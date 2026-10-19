// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerRunner } from "./worker.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  !testDatabaseUrl &&
  process.env.npm_lifecycle_event === "test:integration"
) {
  throw new Error(
    "TEST_DATABASE_URL is required for database integration tests",
  );
}

// The API and the migration runner are consumed as compiled build output so the
// proof covers what `pnpm build` produces. They are loaded by file URL because
// @next-round/worker does not depend on @next-round/api and the db package only
// exports its schema and client.
const apiServerModule = new URL("../../api/dist/server.js", import.meta.url);
const migrateModule = new URL(
  "../../../packages/db/dist/migrate.js",
  import.meta.url,
);

interface CompiledApiServer {
  listen(options: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
  server: { address(): string | AddressInfo | null };
}

interface CompiledApiModule {
  buildServer(options: {
    logger: false;
    staticRoot: string;
  }): Promise<CompiledApiServer>;
}

interface CompiledMigrateModule {
  migrateDatabase(options: { connectionString: string }): Promise<void>;
}

describe("compiled API boot", () => {
  let staticRoot: string;
  let api: CompiledApiServer | undefined;

  beforeEach(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), "next-round-boot-api-"));
    // Test-process-only values; they satisfy the production fail-fast checks.
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("SETUP_TOKEN", randomBytes(32).toString("hex"));
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.stubEnv("TRUST_PROXY", "");
  });

  afterEach(async () => {
    try {
      await api?.close();
    } finally {
      api = undefined;
      vi.unstubAllEnvs();
      await rm(staticRoot, { recursive: true, force: true });
    }
  });

  it("serves GET /health/live over a real socket", async () => {
    const { buildServer } = (await import(
      apiServerModule.href
    )) as CompiledApiModule;
    api = await buildServer({ logger: false, staticRoot });
    await api.listen({ port: 0, host: "127.0.0.1" });
    const address = api.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("API server did not bind a TCP port");
    }
    expect(address.port).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${address.port}/health/live`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  }, 30_000);
});

describe.skipIf(!testDatabaseUrl)(
  "worker boot against migrated PostgreSQL",
  () => {
    let admin: pg.Client;
    let databaseName: string;
    let connectionString: string;

    beforeEach(async () => {
      databaseName = `next_round_test_${randomUUID().replaceAll("-", "")}`;
      admin = new pg.Client({
        connectionString: testDatabaseUrl,
        connectionTimeoutMillis: 10_000,
      });
      await admin.connect();
      // The generated name contains only a fixed prefix and hexadecimal characters.
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
      const url = new URL(testDatabaseUrl!);
      url.pathname = `/${databaseName}`;
      connectionString = url.toString();
    }, 60_000);

    afterEach(async () => {
      try {
        if (admin) {
          // Target only this test's random database; never terminate the supplied admin database.
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [databaseName],
          );
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        }
      } finally {
        await admin?.end();
      }
    }, 60_000);

    it("starts, creates both pg-boss queues, and stops cleanly", async () => {
      const { migrateDatabase } = (await import(
        migrateModule.href
      )) as CompiledMigrateModule;
      await migrateDatabase({ connectionString });

      const worker = new WorkerRunner({ connectionString });
      let started = false;
      try {
        await expect(worker.start()).resolves.toBeUndefined();
        started = true;
        expect(worker.getStatus()).toMatchObject({
          running: true,
          bossStarted: true,
        });

        const client = new pg.Client({
          connectionString,
          connectionTimeoutMillis: 10_000,
        });
        await client.connect();
        try {
          const { rows } = await client.query<{ name: string }>(
            "SELECT name FROM pgboss.queue WHERE name = ANY($1) ORDER BY name",
            [["match-deadline", "outbox-delivery"]],
          );
          expect(rows.map((row) => row.name)).toEqual([
            "match-deadline",
            "outbox-delivery",
          ]);
        } finally {
          await client.end();
        }
      } finally {
        if (started) {
          await worker.stop();
        }
      }
      expect(worker.getStatus()).toMatchObject({
        running: false,
        bossStarted: false,
      });
    }, 60_000);
  },
);
