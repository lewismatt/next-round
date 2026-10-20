// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, ERROR_CODES, LIVE_SUBPROTOCOL } from "@next-round/contracts";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import {
  AuthService,
  checkModuleRetentionReadiness,
  defaultGameRegistry,
  InvitationService,
  MatchService,
  TokenService,
  verifyModuleRetentionReadiness,
  type GameRegistry,
} from "@next-round/platform";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import {
  parseTrustedProxies,
  requireAppOrigin,
  requireSessionSecret,
  validateSetupToken,
} from "./config.js";
import type { TrustedProxies } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import {
  adminGameRoutes,
  gameAssetRoutes,
  gameManifestRoutes,
} from "./routes/games.js";
import { matchRoutes } from "./routes/matches.js";
import { tokenRoutes } from "./routes/tokens.js";
import { invitationRoutes } from "./routes/invitations.js";
import { sharedRoutes } from "./routes/shared.js";
import { maintenanceRoutes } from "./routes/maintenance.js";
import type { HealthCheckOptions } from "./routes/health.js";
import { loadTestCounterFixtureIfEnabled } from "./test-counter-fixture.js";
import { LiveService, liveRoutes, type LiveSweepStats } from "./live/index.js";

export interface ServerOptions extends HealthCheckOptions {
  logger?: FastifyServerOptions["logger"];
  trustProxy?: TrustedProxies;
  cookieSecret?: string;
  staticRoot?: string;
  rateLimitMax?: number;
  rateLimitTimeWindow?: string | number;
  databasePool?: DatabasePool;
  setupToken?: string;
  origin?: string;
  gameRegistry?: GameRegistry;
  reconcileIntervalMs?: number;
  databaseDirectUrl?: string;
  listenerApplicationName?: string;
  heartbeatSeconds?: number;
  maxSubscriptionsPerConnection?: number;
  maxBufferedAmount?: number;
  enableLiveListener?: boolean;
  onLiveSweep?: (stats: LiveSweepStats) => void;
}

/**
 * Fastify server factory for Next Round API.
 * Configures security, cookies, WebSockets, rate limiting, static assets, and health checks.
 */
export async function buildServer(
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const trustProxy = parseTrustedProxies(options.trustProxy);
  const cookieSecret = requireSessionSecret(options.cookieSecret);
  const setupToken = validateSetupToken(options.setupToken);
  const origin = requireAppOrigin(options.origin);
  const databasePool = options.databasePool ?? createDatabasePool();
  const gameRegistry = options.gameRegistry ?? defaultGameRegistry;
  if (!options.gameRegistry) {
    loadTestCounterFixtureIfEnabled(
      gameRegistry,
      process.env.NEXT_ROUND_ENABLE_TEST_COUNTER === "true",
    );
  }
  const authService = new AuthService(databasePool, setupToken);
  const matchService = new MatchService(databasePool, gameRegistry);
  const tokenService = new TokenService(databasePool);
  const invitationService = new InvitationService(
    databasePool,
    matchService,
    origin,
  );
  const ownsDatabasePool = options.databasePool === undefined;

  const checkRegistry =
    options.checkRegistry ??
    (async () => {
      try {
        const result = await checkModuleRetentionReadiness(
          databasePool,
          gameRegistry,
        );
        return result.ready;
      } catch {
        return false;
      }
    });
  const loggerConfig: FastifyServerOptions["logger"] = options.logger ?? {
    level: process.env.LOG_LEVEL || "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.url",
        "headers.authorization",
        "headers.cookie",
        "*.password",
        "*.token",
        "*.setupToken",
        "*.secret",
      ],
      censor: "[REDACTED]",
    },
  };

  const app = Fastify({
    logger: loggerConfig,
    trustProxy,
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(error.toResponse(request.id));
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    if (statusCode === 429) {
      const rateLimitError = new ApiError(
        ERROR_CODES.RATE_LIMITED,
        "Too many requests.",
      );
      return reply
        .status(rateLimitError.statusCode)
        .send(rateLimitError.toResponse(request.id));
    }
    // Driver error details and reducer messages can contain private input/state.
    // The request logger already supplies the correlation ID; never serialize
    // arbitrary errors (including their message, stack, detail or cause).
    request.log.error(
      { code: ERROR_CODES.INTERNAL_ERROR },
      "Unhandled API request error",
    );
    const apiError = new ApiError(
      ERROR_CODES.INTERNAL_ERROR,
      "An internal error occurred.",
    );
    return reply
      .status(apiError.statusCode)
      .send(apiError.toResponse(request.id));
  });

  if (ownsDatabasePool) {
    app.addHook("onClose", async () => {
      await databasePool.end();
    });
  }

  // 1. Register Helmet for security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // SPA and WebSockets handled via reverse proxy / policy
  });

  // 2. Register Cookie plugin for session and CSRF management
  await app.register(cookie, {
    secret: cookieSecret,
  });

  // 3. Register Rate Limit plugin
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 100,
    timeWindow: options.rateLimitTimeWindow ?? "1 minute",
  });

  // 4. Register WebSocket plugin for /api/v1/live real-time subscriptions
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024, // Spec §6: 16 KiB per message
      handleProtocols: (protocols) => {
        if (protocols.has(LIVE_SUBPROTOCOL)) {
          return LIVE_SUBPROTOCOL;
        }
        return false;
      },
    },
  });

  // 5. Register Static file serving for SPA and immutable game assets
  const staticRoot =
    options.staticRoot ?? path.resolve(process.cwd(), "public");
  if (!fs.existsSync(staticRoot)) {
    fs.mkdirSync(staticRoot, { recursive: true });
  }
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: "/static/",
  });
  await app.register(gameAssetRoutes, {
    registry: gameRegistry,
  });

  // 6. Register OpenAPI / Swagger for API documentation and contract export
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Next Round API",
        description: "Next Round Platform HTTPS API v1",
        version: "0.1.0",
      },
      servers: [
        {
          url: "/api/v1",
          description: "API v1 base path",
        },
      ],
    },
  });

  // 7. Register Health and version routes (at both / and /api/v1 for operator/load-balancer convenience)
  await app.register(healthRoutes, {
    checkDb: options.checkDb,
    checkRegistry,
  });
  await app.register(healthRoutes, {
    prefix: "/api/v1",
    checkDb: options.checkDb,
    checkRegistry,
  });
  await app.register(gameManifestRoutes, {
    prefix: "/api/v1",
    registry: gameRegistry,
    authService,
    origin,
    databasePool,
  });
  await app.register(adminGameRoutes, {
    prefix: "/api/v1",
    registry: gameRegistry,
    authService,
    databasePool,
    origin,
  });

  if (options.checkRegistry === undefined) {
    app.addHook("onReady", async () => {
      await verifyModuleRetentionReadiness(databasePool, gameRegistry);
    });
  }
  await app.register(authRoutes, {
    prefix: "/api/v1",
    authService,
    tokenService,
    origin,
  });
  await app.register(tokenRoutes, {
    prefix: "/api/v1",
    tokenService,
    authService,
    origin,
  });
  await app.register(matchRoutes, {
    prefix: "/api/v1",
    authService,
    matchService,
    origin,
  });
  await app.register(invitationRoutes, {
    prefix: "/api/v1",
    databasePool,
    authService,
    matchService,
    invitationService,
    registry: gameRegistry,
    origin,
  });
  await app.register(sharedRoutes, {
    prefix: "/api/v1",
    databasePool,
    authService,
    matchService,
    registry: gameRegistry,
    origin,
  });
  await app.register(maintenanceRoutes, {
    prefix: "/api/v1",
    databasePool,
    authService,
    matchService,
    registry: gameRegistry,
    origin,
  });

  const liveService = new LiveService({
    databasePool,
    databaseDirectUrl: options.databaseDirectUrl,
    listenerApplicationName: options.listenerApplicationName,
    reconcileIntervalMs: options.reconcileIntervalMs,
    heartbeatSeconds: options.heartbeatSeconds,
    maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection,
    maxBufferedAmount: options.maxBufferedAmount,
    enableListener: options.enableLiveListener ?? true,
    logger: app.log,
    onSweep: options.onLiveSweep,
  });
  app.decorate("liveService", liveService);
  app.addHook("onReady", async () => {
    await liveService.start();
  });
  app.addHook("onClose", async () => {
    await liveService.close();
  });

  await app.register(liveRoutes, {
    prefix: "/api/v1",
    liveService,
    authService,
    origin,
  });

  return app;
}

export const createServer = buildServer;
