// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PgBoss, getConstructionPlans, getMigrationPlans } from "pg-boss";

const require = createRequire(import.meta.url);
const migrationLockNamespace = 0x4e524d47;
const defaultMigrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

interface ReviewedMigration {
  position: number;
  version: string;
  checksum: string;
  journalTimestamp: number;
  sql: string;
}

interface AppliedMigration {
  position: number;
  version: string;
  checksum: string;
  journal_timestamp: string;
}

interface MigrationJournal {
  dialect: unknown;
  entries: unknown;
}

interface JournalEntry {
  idx: unknown;
  tag: unknown;
  when: unknown;
}

async function readMigrations(directory: string): Promise<ReviewedMigration[]> {
  const journal = JSON.parse(
    await readFile(join(directory, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  if (
    typeof journal !== "object" ||
    journal === null ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0
  ) {
    throw new Error("Migration journal is missing or invalid");
  }

  const migrations: ReviewedMigration[] = [];
  const versions = new Set<string>();
  let previousTimestamp = -1;
  for (const [position, value] of journal.entries.entries()) {
    const entry = value as JournalEntry;
    if (
      typeof entry !== "object" ||
      entry === null ||
      entry.idx !== position ||
      typeof entry.tag !== "string" ||
      !/^\d{4,}_[A-Za-z0-9_-]+$/.test(entry.tag) ||
      versions.has(entry.tag) ||
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousTimestamp
    ) {
      throw new Error("Migration journal order or version is invalid");
    }
    const sql = await readFile(join(directory, `${entry.tag}.sql`));
    migrations.push({
      position,
      version: entry.tag,
      checksum: createHash("sha256").update(sql).digest("hex"),
      journalTimestamp: entry.when,
      sql: sql.toString("utf8"),
    });
    versions.add(entry.tag);
    previousTimestamp = entry.when;
  }

  const sqlFiles = (await readdir(directory)).filter((name) =>
    name.endsWith(".sql"),
  );
  if (
    sqlFiles.length !== migrations.length ||
    sqlFiles.some((name) => !versions.has(name.slice(0, -4)))
  ) {
    throw new Error("SQL files do not match the reviewed migration journal");
  }
  return migrations;
}

/**
 * The pinned pg-boss public plans append each concurrent index build with a
 * provenance comment after the main transaction. Keep these native boundaries:
 * node-postgres must send each concurrent build as its own query, not a single
 * implicit transaction containing all the appended statements.
 */
async function applyPgBossPlan(client: pg.Client, plan: string): Promise<void> {
  const statements = plan.split(/(?<=;)\s*(?=-- inlined from )/);
  try {
    for (const statement of statements) await client.query(statement);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function migratePgBoss(client: pg.Client): Promise<void> {
  const metadata = require("pg-boss/package.json") as {
    pgboss?: { schema?: unknown };
  };
  const targetVersion = metadata.pgboss?.schema;
  if (typeof targetVersion !== "number" || !Number.isInteger(targetVersion)) {
    throw new Error("Invalid pg-boss schema version metadata");
  }
  const installed = await client.query<{ name: string | null }>(
    "SELECT to_regclass('pgboss.version')::text AS name",
  );
  if (!installed.rows[0].name) {
    await applyPgBossPlan(client, getConstructionPlans("pgboss"));
  } else {
    const current = await client.query<{ version: number }>(
      "SELECT version FROM pgboss.version",
    );
    if (
      current.rows.length !== 1 ||
      !Number.isInteger(current.rows[0].version) ||
      current.rows[0].version > targetVersion
    ) {
      throw new Error("Unsupported installed pg-boss schema version");
    }
    const currentVersion = current.rows[0].version;
    if (currentVersion < targetVersion) {
      const partitions = await client.query<{
        table_name: string;
        policy: string;
      }>("SELECT table_name, policy FROM pgboss.queue WHERE partition = true");
      await applyPgBossPlan(
        client,
        getMigrationPlans("pgboss", currentVersion, {
          partitionTables: partitions.rows.map((row) => ({
            tableName: row.table_name,
            policy: row.policy,
          })),
        }),
      );
    }
  }

  // Construction alone starts no timers and uses no additional connection.
  // A failed native concurrent build can leave a committed version stamp; drift
  // must keep retries failing until an operator repairs the missing/invalid index.
  const inspector = new PgBoss({
    db: { executeSql: (text, values) => client.query(text, values) },
    schema: "pgboss",
    migrate: false,
    schedule: false,
    supervise: false,
  });
  const drift = await inspector.detectSchemaDrift();
  if (!drift.ok)
    throw new Error("Installed pg-boss schema requires operator repair");
}

/** Applies the immutable Drizzle journal and pg-boss schema on one locked session. */
export async function migrateDatabase(options: {
  connectionString: string;
  migrationsDirectory?: string;
}): Promise<void> {
  const migrations = await readMigrations(
    options.migrationsDirectory ?? defaultMigrationsDirectory,
  );
  const client = new pg.Client({ connectionString: options.connectionString });
  let connectionFailed = false;
  // Idle connection errors must fail the operation without an uncaught event
  // exposing driver diagnostics outside the CLI's safe error boundary.
  client.on("error", () => {
    connectionFailed = true;
  });
  let locked = false;
  let inTransaction = false;
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
      migrationLockNamespace,
      1,
    ]);
    locked = true;
    await client.query("BEGIN");
    inTransaction = true;

    const ledger = await client.query<{ name: string | null }>(
      "SELECT to_regclass('next_round.schema_migrations')::text AS name",
    );
    const applied = ledger.rows[0].name
      ? (
          await client.query<AppliedMigration>(
            "SELECT position, version, checksum, journal_timestamp FROM next_round.schema_migrations ORDER BY position",
          )
        ).rows
      : [];
    for (const [position, row] of applied.entries()) {
      const migration = migrations[position];
      if (
        !migration ||
        row.position !== position ||
        row.version !== migration.version ||
        row.checksum !== migration.checksum ||
        String(row.journal_timestamp) !== String(migration.journalTimestamp)
      ) {
        throw new Error(
          "Applied migration history does not match the reviewed migration journal",
        );
      }
    }

    const pending = migrations.slice(applied.length);
    // Drizzle statement-breakpoint markers are SQL comments; whole-file queries
    // preserve dollar-quoted functions and all statements in this transaction.
    for (const migration of pending) await client.query(migration.sql);

    await client.query(`
      CREATE SCHEMA IF NOT EXISTS next_round;
      CREATE TABLE IF NOT EXISTS next_round.schema_migrations (
        position integer PRIMARY KEY CHECK (position >= 0),
        version text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        journal_timestamp bigint NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    for (const migration of pending) {
      await client.query(
        "INSERT INTO next_round.schema_migrations (position, version, checksum, journal_timestamp) VALUES ($1, $2, $3, $4)",
        [
          migration.position,
          migration.version,
          migration.checksum,
          migration.journalTimestamp,
        ],
      );
    }
    await client.query("COMMIT");
    inTransaction = false;
    await migratePgBoss(client);
    if (connectionFailed) throw new Error("Migration connection failed");
  } finally {
    try {
      if (inTransaction) await client.query("ROLLBACK");
    } finally {
      try {
        if (locked) {
          await client.query(
            "SELECT pg_advisory_unlock($1::integer, $2::integer)",
            [migrationLockNamespace, 1],
          );
        }
      } finally {
        await client.end();
      }
    }
  }
}
