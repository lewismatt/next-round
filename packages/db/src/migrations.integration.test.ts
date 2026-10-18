// SPDX-License-Identifier: Apache-2.0
import { randomInt, randomUUID } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  !testDatabaseUrl &&
  process.env.npm_lifecycle_event === "test:integration"
) {
  throw new Error(
    "TEST_DATABASE_URL is required for database integration tests",
  );
}

const productionMigrations = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

describe.skipIf(!testDatabaseUrl)(
  "reviewed PostgreSQL migrations and deferred constraints",
  () => {
    let admin: pg.Client;
    let databaseName: string;
    let connectionString: string;
    let client: pg.Client;
    const connections = new Set<pg.Client>();
    const directories = new Set<string>();

    async function connect(url = connectionString): Promise<pg.Client> {
      const connection = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 10_000,
      });
      connections.add(connection);
      await connection.connect();
      return connection;
    }

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
      client = await connect();
    }, 60_000);

    afterEach(async () => {
      try {
        await Promise.all(
          [...connections].map((connection) => connection.end()),
        );
        connections.clear();
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
        await Promise.all(
          [...directories].map((directory) =>
            rm(directory, { recursive: true, force: true }),
          ),
        );
        directories.clear();
      }
    }, 60_000);

    async function copyMigrations(): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), "next-round-migrations-"));
      directories.add(directory);
      await cp(productionMigrations, directory, { recursive: true });
      return directory;
    }

    async function appendMigration(
      directory: string,
      name: string,
      sql: string,
    ): Promise<string> {
      const path = join(directory, `${name}.sql`);
      await writeFile(path, sql);
      const journalPath = join(directory, "meta", "_journal.json");
      const journal = JSON.parse(
        await readFile(journalPath, "utf8"),
      ) as Journal;
      const last = journal.entries.at(-1)!;
      journal.entries.push({
        idx: last.idx + 1,
        version: last.version,
        when: last.when + 1,
        tag: name,
        breakpoints: true,
      });
      await writeFile(journalPath, JSON.stringify(journal));
      return path;
    }

    async function ledger() {
      return (
        await client.query(
          "SELECT * FROM next_round.schema_migrations ORDER BY version",
        )
      ).rows;
    }

    async function expectAbsent(table: string, id: string) {
      const result = await client.query(
        `SELECT count(*)::int AS count FROM next_round.${table} WHERE id = $1`,
        [id],
      );
      expect(result.rows[0].count).toBe(0);
    }

    async function seedRegistry() {
      await migrateDatabase({ connectionString });
      const principalId = randomUUID();
      const moduleId = `migration-test-${randomUUID()}`;
      await client.query("BEGIN");
      try {
        await client.query(
          "INSERT INTO next_round.principals (id, kind, display_name) VALUES ($1, 'registered', 'Migration fixture')",
          [principalId],
        );
        await client.query(
          "INSERT INTO next_round.instance_policy (version, instance_name, policy, changed_by) VALUES (1, 'Migration fixture', '{}', $1)",
          [principalId],
        );
        await insertModule(moduleId);
        await insertModuleVersion(moduleId);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      return { principalId, moduleId };
    }

    async function insertModule(moduleId: string) {
      await client.query(
        "INSERT INTO next_round.modules (id, default_version) VALUES ($1, '1.0.0')",
        [moduleId],
      );
    }

    async function insertModuleVersion(moduleId: string) {
      await client.query(
        `INSERT INTO next_round.module_versions
        (module_id, version, manifest, server_hash, client_hash, sdk_contract, state_version, result_version)
       VALUES ($1, '1.0.0', '{}', 'fixture-server', 'fixture-client', 'next-round-game/0.1', 1, 1)`,
        [moduleId],
      );
    }

    async function insertMatch(
      id: string,
      moduleId: string,
      creatorId: string,
      hostMemberId: string | null = null,
    ) {
      await client.query(
        `INSERT INTO next_round.matches
        (id, module_id, module_version, state_version, mode, creator_id, host_member_id,
         settings, visibility, policy_version, policy_snapshot)
       VALUES ($1, $2, '1.0.0', 1, 'multiplayer', $3, $4, '{}', 'invite', 1, '{}')`,
        [id, moduleId, creatorId, hostMemberId],
      );
    }

    async function insertMember(
      id: string,
      matchId: string,
      principalId: string,
    ) {
      await client.query(
        "INSERT INTO next_round.match_members (id, match_id, principal_id, join_ordinal) VALUES ($1, $2, $3, 1)",
        [id, matchId, principalId],
      );
    }

    it("applies every reviewed migration and pg-boss, then repeats without changing its ledger", async () => {
      await migrateDatabase({ connectionString });
      const applied = await ledger();
      const files = (await readdir(productionMigrations)).filter((name) =>
        name.endsWith(".sql"),
      );
      expect(applied).toHaveLength(files.length);
      expect(
        (
          await client.query(
            "SELECT to_regclass('next_round.matches') AS relation",
          )
        ).rows[0].relation,
      ).not.toBeNull();
      expect(
        (await client.query("SELECT to_regclass('pgboss.job') AS relation"))
          .rows[0].relation,
      ).not.toBeNull();
      expect(
        (await client.query("SELECT version FROM pgboss.version")).rows,
      ).toHaveLength(1);
      await migrateDatabase({ connectionString });
      expect(await ledger()).toEqual(applied);
    }, 60_000);

    it("serializes concurrent runners behind the session lock and applies pending SQL once", async () => {
      const migrationsDirectory = await copyMigrations();
      const table = `concurrency_${randomUUID().replaceAll("-", "")}`;
      const barrierKey = randomInt(1, 2_000_000_000);
      await appendMigration(
        migrationsDirectory,
        "9999_concurrent_fixture",
        `
      CREATE TABLE next_round.${table} (id uuid PRIMARY KEY);
      SELECT pg_advisory_xact_lock(${barrierKey});
      INSERT INTO next_round.${table} VALUES ('${randomUUID()}');
    `,
      );
      const barrier = await connect();
      const barrierPid = (await barrier.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      await barrier.query("SELECT pg_advisory_lock($1)", [barrierKey]);
      const pending: Array<Promise<void>> = [];
      try {
        const first = migrateDatabase({
          connectionString,
          migrationsDirectory,
        });
        pending.push(first);
        // Attach rejection handlers immediately while observing the actual database lock graph.
        void first.catch(() => {});
        let firstPid: number | undefined;
        await expect
          .poll(
            async () => {
              const result = await client.query(
                `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
             AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
                [barrierPid],
              );
              firstPid = result.rows[0]?.pid;
              return firstPid !== undefined;
            },
            { timeout: 15_000, interval: 25 },
          )
          .toBe(true);
        const second = migrateDatabase({
          connectionString,
          migrationsDirectory,
        });
        pending.push(second);
        void second.catch(() => {});
        await expect
          .poll(
            async () => {
              const result = await client.query(
                `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> $1
             AND $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
                [firstPid],
              );
              return result.rowCount;
            },
            { timeout: 15_000, interval: 25 },
          )
          .toBe(1);
      } finally {
        await barrier.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
        const outcomes = await Promise.allSettled(pending);
        for (const outcome of outcomes)
          expect(outcome.status).toBe("fulfilled");
      }
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM next_round.${table}`,
          )
        ).rows[0].count,
      ).toBe(1);
      const applied = await ledger();
      await migrateDatabase({ connectionString, migrationsDirectory });
      expect(await ledger()).toEqual(applied);
    }, 60_000);

    it("rolls failing DDL and its ledger entry back and accepts corrected unapplied SQL", async () => {
      const migrationsDirectory = await copyMigrations();
      await migrateDatabase({ connectionString, migrationsDirectory });
      const applied = await ledger();
      const table = `rollback_${randomUUID().replaceAll("-", "")}`;
      const sql = `CREATE TABLE next_round.${table} (id uuid PRIMARY KEY); INSERT INTO next_round.${table} VALUES ('${randomUUID()}');`;
      const path = await appendMigration(
        migrationsDirectory,
        "9999_failure_fixture",
        `${sql}
      DO $$ BEGIN RAISE EXCEPTION 'intentional migration failure'; END $$;`,
      );
      await expect(
        migrateDatabase({ connectionString, migrationsDirectory }),
      ).rejects.toThrow();
      expect(
        (
          await client.query("SELECT to_regclass($1) AS relation", [
            `next_round.${table}`,
          ])
        ).rows[0].relation,
      ).toBeNull();
      expect(await ledger()).toEqual(applied);
      await writeFile(path, sql);
      await migrateDatabase({ connectionString, migrationsDirectory });
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM next_round.${table}`,
          )
        ).rows[0].count,
      ).toBe(1);
      expect(await ledger()).toHaveLength(applied.length + 1);
    }, 60_000);

    it("rejects checksum changes to applied SQL without changing the ledger", async () => {
      const migrationsDirectory = await copyMigrations();
      await migrateDatabase({ connectionString, migrationsDirectory });
      const applied = await ledger();
      const file = (await readdir(migrationsDirectory))
        .filter((name) => name.endsWith(".sql"))
        .sort()[0];
      const path = join(migrationsDirectory, file);
      await writeFile(
        path,
        `${await readFile(path, "utf8")}\n-- changed after application\n`,
      );
      await expect(
        migrateDatabase({ connectionString, migrationsDirectory }),
      ).rejects.toThrow();
      expect(await ledger()).toEqual(applied);
    }, 60_000);

    it("rejects an absent applied file even if its journal entry is also removed", async () => {
      const migrationsDirectory = await copyMigrations();
      await migrateDatabase({ connectionString, migrationsDirectory });
      const applied = await ledger();
      const journalPath = join(migrationsDirectory, "meta", "_journal.json");
      const journal = JSON.parse(
        await readFile(journalPath, "utf8"),
      ) as Journal;
      const removed = journal.entries.pop()!;
      await rm(join(migrationsDirectory, `${removed.tag}.sql`));
      await writeFile(journalPath, JSON.stringify(journal));
      await expect(
        migrateDatabase({ connectionString, migrationsDirectory }),
      ).rejects.toThrow();
      expect(await ledger()).toEqual(applied);
    }, 60_000);

    it("commits cyclic module/default-version creation but rejects an unresolved default at commit", async () => {
      await migrateDatabase({ connectionString });
      const moduleId = `module-${randomUUID()}`;
      await client.query("BEGIN");
      await insertModule(moduleId);
      await insertModuleVersion(moduleId);
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            "SELECT default_version FROM next_round.modules WHERE id = $1",
            [moduleId],
          )
        ).rows[0].default_version,
      ).toBe("1.0.0");
      const invalidId = `module-${randomUUID()}`;
      await client.query("BEGIN");
      await insertModule(invalidId);
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23503",
      });
      await client.query("ROLLBACK");
      await expectAbsent("modules", invalidId);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM next_round.module_versions WHERE module_id = $1",
            [moduleId],
          )
        ).rows[0].count,
      ).toBe(1);
    }, 60_000);

    it("rejects a missing applied SQL file while its journal entry is retained", async () => {
      const migrationsDirectory = await copyMigrations();
      await migrateDatabase({ connectionString, migrationsDirectory });
      const applied = await ledger();
      const journal = JSON.parse(
        await readFile(
          join(migrationsDirectory, "meta", "_journal.json"),
          "utf8",
        ),
      ) as Journal;
      await rm(join(migrationsDirectory, `${journal.entries[0].tag}.sql`));
      await expect(
        migrateDatabase({ connectionString, migrationsDirectory }),
      ).rejects.toThrow();
      expect(await ledger()).toEqual(applied);
    }, 60_000);

    it("rejects a ledger gap rather than replaying an earlier applied migration", async () => {
      await migrateDatabase({ connectionString });
      await client.query(
        "DELETE FROM next_round.schema_migrations WHERE position = 0",
      );
      const altered = await ledger();
      await expect(migrateDatabase({ connectionString })).rejects.toThrow();
      expect(await ledger()).toEqual(altered);
      expect(
        (
          await client.query(
            "SELECT to_regclass('next_round.matches') AS relation",
          )
        ).rows[0].relation,
      ).not.toBeNull();
    }, 60_000);

    it("commits guest-before-match creation and rolls an unresolved guest destination back at commit", async () => {
      const { principalId, moduleId } = await seedRegistry();
      const guestId = randomUUID();
      const matchId = randomUUID();
      const memberId = randomUUID();
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO next_round.principals (id, kind, display_name, guest_match_id) VALUES ($1, 'guest', 'Guest fixture', $2)",
        [guestId, matchId],
      );
      await insertMatch(matchId, moduleId, guestId, memberId);
      await insertMember(memberId, matchId, guestId);
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            "SELECT guest_match_id FROM next_round.principals WHERE id = $1",
            [guestId],
          )
        ).rows[0].guest_match_id,
      ).toBe(matchId);
      const invalidGuest = randomUUID();
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO next_round.principals (id, kind, display_name, guest_match_id) VALUES ($1, 'guest', 'Invalid fixture', $2)",
        [invalidGuest, randomUUID()],
      );
      await client.query(
        "UPDATE next_round.principals SET display_name = 'Must roll back' WHERE id = $1",
        [principalId],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23503",
      });
      await client.query("ROLLBACK");
      await expectAbsent("principals", invalidGuest);
      expect(
        (
          await client.query(
            "SELECT display_name FROM next_round.principals WHERE id = $1",
            [principalId],
          )
        ).rows[0].display_name,
      ).toBe("Migration fixture");
    }, 60_000);

    it("commits a match before its same-match host and rejects a host belonging to another match at commit", async () => {
      const { principalId, moduleId } = await seedRegistry();
      const matchId = randomUUID();
      const memberId = randomUUID();
      await client.query("BEGIN");
      await insertMatch(matchId, moduleId, principalId, memberId);
      await insertMember(memberId, matchId, principalId);
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            "SELECT host_member_id FROM next_round.matches WHERE id = $1",
            [matchId],
          )
        ).rows[0].host_member_id,
      ).toBe(memberId);
      const invalidMatch = randomUUID();
      await client.query("BEGIN");
      await insertMatch(invalidMatch, moduleId, principalId, memberId);
      await client.query(
        "UPDATE next_round.matches SET revision = 7 WHERE id = $1",
        [matchId],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23503",
      });
      await client.query("ROLLBACK");
      await expectAbsent("matches", invalidMatch);
      expect(
        (
          await client.query(
            "SELECT revision::int FROM next_round.matches WHERE id = $1",
            [matchId],
          )
        ).rows[0].revision,
      ).toBe(0);
    }, 60_000);
  },
);
