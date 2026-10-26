// SPDX-License-Identifier: Apache-2.0
import { initializeDummyPasswordHash } from "@next-round/platform/auth";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

const port = Number(process.env.API_PORT || process.env.PORT || 3000);
const host = process.env.API_HOST || process.env.HOST || "0.0.0.0";

/**
 * Next Round API server executable entrypoint.
 */
export async function main(): Promise<void> {
  let server: FastifyInstance | undefined;
  try {
    server = await buildServer();
    await initializeDummyPasswordHash();
    const runningServer = server;

    const shutdown = async (signal: string): Promise<void> => {
      runningServer.log.info(
        { signal },
        "Gracefully shutting down Next Round API server...",
      );
      try {
        await runningServer.close();
        runningServer.log.info("Next Round API server stopped cleanly");
        process.exit(0);
      } catch {
        runningServer.log.error(
          { code: "INTERNAL_ERROR" },
          "Error encountered while stopping API server",
        );
        process.exit(1);
      }
    };
    const stop = (signal: string): void => {
      void shutdown(signal).catch(() => {
        console.error(
          '{"code":"INTERNAL_ERROR","msg":"Error encountered while stopping API server"}',
        );
        process.exit(1);
      });
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));

    await server.listen({ port, host });
    server.log.info(
      `Next Round API v1 listening on http://${host}:${port} (health: http://${host}:${port}/health/live)`,
    );
  } catch {
    if (server) {
      server.log.error(
        { code: "INTERNAL_ERROR" },
        "Failed to start Next Round API server",
      );
    } else {
      console.error(
        '{"code":"INTERNAL_ERROR","msg":"Failed to start Next Round API server"}',
      );
    }
    process.exit(1);
  }
}

void main().catch(() => {
  console.error(
    '{"code":"INTERNAL_ERROR","msg":"Failed to start Next Round API server"}',
  );
  process.exit(1);
});
