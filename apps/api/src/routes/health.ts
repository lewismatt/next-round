// SPDX-License-Identifier: Apache-2.0
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export interface HealthCheckOptions {
  checkDb?: () => Promise<boolean>;
  checkRegistry?: () => Promise<boolean>;
}

export interface HealthLiveResponse {
  status: "ok";
  uptime: number;
  timestamp: string;
}

export interface HealthReadyResponse {
  status: "ready" | "not_ready";
  checks: {
    database: "ok" | "failed";
    registry: "ok" | "failed";
  };
  timestamp: string;
  error?: string;
}

export interface VersionResponse {
  name: string;
  version: string;
  apiVersion: string;
  sdkVersion: string;
  commit: string;
  sourceUrl: string;
  buildTime: string;
}

export const healthRoutes: FastifyPluginAsync<HealthCheckOptions> = async (
  fastify,
  options
) => {
  /**
   * GET /health/live
   * Liveness probe per Master Spec §3.
   * Confirms the Fastify server process is running and accepting HTTP requests.
   */
  fastify.get(
    "/health/live",
    async (_request: FastifyRequest, reply: FastifyReply): Promise<HealthLiveResponse> => {
      return reply.status(200).send({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }
  );

  /**
   * GET /health/ready
   * Readiness probe per Master Spec §3.
   * Verifies database/migration readiness and module registry status.
   * Public output contains no secrets or internal exception traces.
   */
  fastify.get(
    "/health/ready",
    async (_request: FastifyRequest, reply: FastifyReply): Promise<HealthReadyResponse> => {
      try {
        const dbReady = options.checkDb ? await options.checkDb() : true;
        const registryReady = options.checkRegistry
          ? await options.checkRegistry()
          : true;

        if (!dbReady || !registryReady) {
          return reply.status(503).send({
            status: "not_ready",
            checks: {
              database: dbReady ? "ok" : "failed",
              registry: registryReady ? "ok" : "failed",
            },
            timestamp: new Date().toISOString(),
          });
        }

        return reply.status(200).send({
          status: "ready",
          checks: {
            database: "ok",
            registry: "ok",
          },
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Spec §3: Public output contains no secrets or internal exception traces
        return reply.status(503).send({
          status: "not_ready",
          checks: {
            database: "failed",
            registry: "failed",
          },
          error: "Readiness check failed",
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  /**
   * GET /version
   * Version metadata per Master Spec §3.
   * Exposes app/API/SDK build metadata and source URL.
   * Public output contains no secrets or internal exception traces.
   */
  fastify.get(
    "/version",
    async (_request: FastifyRequest, reply: FastifyReply): Promise<VersionResponse> => {
      return reply.status(200).send({
        name: "next-round",
        version: "0.1.0",
        apiVersion: "v1",
        sdkVersion: "0.1",
        commit: process.env.GIT_COMMIT || "development",
        sourceUrl:
          process.env.SOURCE_URL || "https://github.com/lewismatt/next-round",
        buildTime: process.env.BUILD_TIME || "development",
      });
    }
  );
};
