import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;

export * from "./schema.js";

export interface DatabasePoolOptions {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Initializes a PostgreSQL connection pool with connection pooling limits.
 */
export function createDatabasePool(options?: DatabasePoolOptions): pg.Pool {
  const connectionString = options?.connectionString ?? process.env.DATABASE_URL;
  const max =
    options?.max ?? (process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10);

  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: options?.idleTimeoutMillis,
    connectionTimeoutMillis: options?.connectionTimeoutMillis,
  });
}

/**
 * Creates a Drizzle ORM client configured with the Next Round database schema.
 */
export function createDatabaseClient(pool: pg.Pool): NodePgDatabase<typeof schema> {
  return drizzle(pool, { schema });
}

export type DatabaseClient = NodePgDatabase<typeof schema>;
