// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { healthRoutes, type HealthCheckOptions } from "./routes/health.js";
import { parseTrustedProxies, requireSessionSecret, validateSetupToken, type TrustedProxies } from "./config.js";

export interface ServerOptions extends HealthCheckOptions {
  logger?: FastifyServerOptions["logger"];
  trustProxy?: TrustedProxies;
  cookieSecret?: string;
  staticRoot?: string;
  rateLimitMax?: number;
  rateLimitTimeWindow?: string | number;
}

/**
 * Fastify server factory for Next Round API.
 * Configures security, cookies, WebSockets, rate limiting, static assets, and health checks.
 */
export async function buildServer(
  options: ServerOptions = {}
): Promise<FastifyInstance> {
  const trustProxy = parseTrustedProxies(options.trustProxy);
  const cookieSecret = requireSessionSecret(options.cookieSecret);
  validateSetupToken();
  const loggerConfig: FastifyServerOptions["logger"] =
    options.logger ?? {
      level: process.env.LOG_LEVEL || "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
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
  });

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
    checkRegistry: options.checkRegistry,
  });
  await app.register(healthRoutes, {
    prefix: "/api/v1",
    checkDb: options.checkDb,
    checkRegistry: options.checkRegistry,
  });

  return app;
}

export const createServer = buildServer;
