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

export interface ServerOptions extends HealthCheckOptions {
  logger?: FastifyServerOptions["logger"];
  trustProxy?: boolean;
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
    trustProxy:
      options.trustProxy ?? (process.env.TRUST_PROXY === "true" || true),
  });

  // 1. Register Helmet for security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // SPA and WebSockets handled via reverse proxy / policy
  });

  // 2. Register Cookie plugin for session and CSRF management
  await app.register(cookie, {
    secret:
      options.cookieSecret ||
      process.env.SESSION_SECRET ||
      "next-round-default-development-secret-key-32-chars-min",
  });

  // 3. Register Rate Limit plugin
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 100,
    timeWindow: options.rateLimitTimeWindow ?? "1 minute",
  });

  // 4. Register WebSocket plugin for /api/v1/live real-time subscriptions
  await app.register(websocket, {
    options: {
      maxPayload: 1048576, // 1 MiB per frame
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
