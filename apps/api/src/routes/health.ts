// SPDX-License-Identifier: Apache-2.0
import { ApiError, ERROR_CODES } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import type { AuthService } from "@next-round/platform";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireSession } from "./auth.js";

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

export interface AdminHealthRoutesOptions {
  authService: AuthService;
  databasePool: DatabasePool;
}

export interface AdminWorkerHealth {
  workerId: string;
  startedAt: string;
  lastSeenAt: string;
  ageSeconds: number;
  status: "ok" | "stale";
}

export interface AdminHealthResponse {
  workers: AdminWorkerHealth[];
  oldestPendingOutboxAgeSeconds: number | null;
  oldestPendingDeadlineAgeSeconds: number | null;
  parkedEffects: {
    total: number;
    recent: Array<{
      id: string;
      topic: string;
      attempts: number;
      lastErrorCode: string | null;
      deadLetteredAt: string;
    }>;
  };
}

/** A heartbeat older than this reads as stale: roughly three missed
 *  sweeps at the default 10 s reconciliation interval. */
const WORKER_STALE_AFTER_SECONDS = 30;

/**
 * GET /admin/health (BL-039)
 * Admin health per Master Spec §8: worker heartbeats, the oldest pending
 * deadline/outbox ages, and the parked (dead-lettered) effects an operator
 * may need to inspect. Admin sessions only; no payloads or secrets — the
 * outbox rows surface metadata (topic/attempts/error code) only.
 */
export const adminHealthRoutes: FastifyPluginAsync<AdminHealthRoutesOptions> =
  async (fastify, options) => {
    fastify.get("/admin/health", async (request, reply) => {
      const session = await requireSession(request, options.authService, false);
      if (!session.permissions.isAdmin) {
        throw new ApiError(
          ERROR_CODES.FORBIDDEN,
          "Administrator access is required.",
        );
      }
      const pool = options.databasePool;
      const [workerRows, outboxAge, deadlineAge, parkedCount, parkedRows] =
        await Promise.all([
          pool.query<{
            worker_id: string;
            started_at: Date;
            last_seen_at: Date;
            age_seconds: number;
          }>(
            `SELECT worker_id, started_at, last_seen_at,
                    EXTRACT(EPOCH FROM (clock_timestamp() - last_seen_at))::float8 AS age_seconds
               FROM next_round.worker_heartbeats
              ORDER BY last_seen_at DESC`,
          ),
          pool.query<{ age_seconds: number | null }>(
            `SELECT EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at)))::float8 AS age_seconds
               FROM next_round.outbox
              WHERE delivered_at IS NULL AND dead_lettered_at IS NULL`,
          ),
          pool.query<{ age_seconds: number | null }>(
            `SELECT EXTRACT(EPOCH FROM (clock_timestamp() - min(due_at)))::float8 AS age_seconds
               FROM next_round.match_deadlines
              WHERE status = 'pending' AND due_at <= clock_timestamp()`,
          ),
          pool.query<{ total: number }>(
            `SELECT count(*)::integer AS total FROM next_round.outbox
              WHERE dead_lettered_at IS NOT NULL`,
          ),
          pool.query<{
            id: string;
            topic: string;
            attempts: number;
            last_error_code: string | null;
            dead_lettered_at: Date;
          }>(
            `SELECT id, topic, attempts, last_error_code, dead_lettered_at
               FROM next_round.outbox
              WHERE dead_lettered_at IS NOT NULL
              ORDER BY dead_lettered_at DESC
              LIMIT 10`,
          ),
        ]);
      const data: AdminHealthResponse = {
        workers: workerRows.rows.map((row) => {
          const ageSeconds = Math.max(0, Math.round(row.age_seconds));
          return {
            workerId: row.worker_id,
            startedAt: row.started_at.toISOString(),
            lastSeenAt: row.last_seen_at.toISOString(),
            ageSeconds,
            status: ageSeconds <= WORKER_STALE_AFTER_SECONDS ? "ok" : "stale",
          };
        }),
        oldestPendingOutboxAgeSeconds:
          outboxAge.rows[0].age_seconds === null
            ? null
            : Math.round(outboxAge.rows[0].age_seconds),
        oldestPendingDeadlineAgeSeconds:
          deadlineAge.rows[0].age_seconds === null
            ? null
            : Math.round(deadlineAge.rows[0].age_seconds),
        parkedEffects: {
          total: parkedCount.rows[0].total,
          recent: parkedRows.rows.map((row) => ({
            id: row.id,
            topic: row.topic,
            attempts: row.attempts,
            lastErrorCode: row.last_error_code,
            deadLetteredAt: row.dead_lettered_at.toISOString(),
          })),
        },
      };
      return reply
        .status(200)
        .header("Cache-Control", "no-store")
        .send({ data, serverNow: new Date().toISOString() });
    });
  };
