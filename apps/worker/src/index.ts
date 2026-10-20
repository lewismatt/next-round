// SPDX-License-Identifier: Apache-2.0
import { parsePositiveIntegerInterval } from "@next-round/platform";
import { createWorker, safeErrorCode } from "./worker.js";

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/next_round";
const reconcileIntervalMs = parsePositiveIntegerInterval(
  process.env.LIVE_RECONCILE_INTERVAL_MS,
  "LIVE_RECONCILE_INTERVAL_MS",
  10000,
);

/**
 * Next Round Worker executable entrypoint.
 */
export async function main(): Promise<void> {
  const worker = createWorker({
    connectionString,
    reconcileIntervalMs,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] Received ${signal}, initiating graceful shutdown...`);
    try {
      await worker.stop();
      console.log("[worker] Worker stopped cleanly");
      process.exit(0);
    } catch (err) {
      console.error(`[worker] Error during worker shutdown: ${safeErrorCode(err)}`);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    console.log("[worker] Starting Next Round background worker...");
    await worker.start();
    console.log(
      `[worker] Background worker running. Schema=pgboss, reconcileInterval=${reconcileIntervalMs}ms`
    );
  } catch (err) {
    console.error(`[worker] Failed to start background worker: ${safeErrorCode(err)}`);
    process.exit(1);
  }
}

void main();
