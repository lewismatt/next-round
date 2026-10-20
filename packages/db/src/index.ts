// SPDX-License-Identifier: Apache-2.0
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool, Client } = pg;
export type DatabasePool = pg.Pool;
export type DedicatedClient = pg.Client;
export type DatabaseNotification = pg.Notification;

export function createDedicatedClient(
  connectionString: string,
  applicationName?: string,
): pg.Client {
  return new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
}
export * from "./schema.js";

export interface DatabasePoolOptions {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Initializes a PostgreSQL connection pool with connection pooling limits.
 *
 * The pool carries a default `error` listener: when an idle pooled client's
 * backend dies (database restart, restore, administrative termination) pg
 * emits the failure on the pool, and an unlistened `error` event would
 * throw as an uncaught exception and take the process down. Listening here
 * lets the pool discard the dead client and carry on; only the error code
 * is logged, never the message (it can carry connection details).
 */
export function createDatabasePool(options?: DatabasePoolOptions): pg.Pool {
  const connectionString = options?.connectionString ?? process.env.DATABASE_URL;
  const max =
    options?.max ?? (process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10);

  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: options?.idleTimeoutMillis,
    connectionTimeoutMillis: options?.connectionTimeoutMillis,
  });
  pool.on("error", (err) => {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "UNKNOWN";
    console.error(`[db:pool] Idle client error: ${code}`);
  });
  return pool;
}

/**
 * Creates a Drizzle ORM client configured with the Next Round database schema.
 */
export function createDatabaseClient(pool: pg.Pool): NodePgDatabase<typeof schema> {
  return drizzle(pool, { schema });
}

export type DatabaseClient = NodePgDatabase<typeof schema>;
