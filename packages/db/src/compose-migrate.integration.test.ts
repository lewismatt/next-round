// SPDX-License-Identifier: Apache-2.0
import { execFile, type ExecFileException } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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

const RUNTIME_ROLE = "next_round_runtime";
const SUCCESS_MESSAGE = "Compose database migration completed.";
const FAILURE_MESSAGE = "Compose database migration failed.";
const CLI_TIMEOUT_MS = 90_000;

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceCli = fileURLToPath(
  new URL("./compose-migrate-cli.ts", import.meta.url),
);
const builtCli = fileURLToPath(
  new URL("../dist/compose-migrate-cli.js", import.meta.url),
);
const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

type ElevatedAttribute =
  | "SUPERUSER"
  | "CREATEDB"
  | "CREATEROLE"
  | "REPLICATION"
  | "BYPASSRLS";

type LedgerRow = {
  position: number;
  version: string;
  checksum: string;
  journal_timestamp: string;
  applied_at: Date;
};

type RoleFlags = {
  rolname: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
};

type Membership = {
  role: string;
  member: string;
};

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
  signal?: string;
};

type CatalogExamples = {
  suffix: string;
  note: string;
  untouchedSchema: string;
  table: string;
  view: string;
  matview: string;
  sequence: string;
  fn: string;
  procedure: string;
  enumName: string;
  domain: string;
  partitioned: string;
  partition: string;
  index: string;
  trigger: string;
  triggerFn: string;
  pgbossTable: string;
};

const SCHEMA_OBJECTS = `
  SELECT n.nspname || ' schema' AS object, n.nspowner AS owner
  FROM pg_namespace n
  WHERE n.nspname IN ('next_round', 'pgboss')
  UNION ALL
  SELECT n.nspname || '.' || c.relname || ' ' || c.relkind::text, c.relowner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('next_round', 'pgboss')
    AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'i', 'I')
  UNION ALL
  SELECT n.nspname || '.' || p.proname || '('
      || pg_get_function_identity_arguments(p.oid) || ') ' || p.prokind::text,
    p.proowner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('next_round', 'pgboss')
  UNION ALL
  SELECT n.nspname || '.' || t.typname || ' ' || t.typtype::text, t.typowner
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname IN ('next_round', 'pgboss')
`;

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const adminUrl = testDatabaseUrl ? new URL(testDatabaseUrl) : undefined;
const bootstrapUser = adminUrl ? decodeUrlComponent(adminUrl.username) : "";
const bootstrapPassword = adminUrl ? decodeUrlComponent(adminUrl.password) : "";

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error("Refusing to interpolate an unsafe SQL identifier");
  }
  return `"${value}"`;
}

function connectionUrl(
  database: string,
  username: string,
  password: string,
): string {
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is not set");
  const url = new URL(`${adminUrl.protocol}//${adminUrl.host}`);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function hexPassword(): string {
  const password = randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(password)) {
    throw new Error("Runtime password must be 64 hexadecimal characters");
  }
  return password;
}

function differentPassword(current: string): string {
  let next = hexPassword();
  while (next === current) next = hexPassword();
  return next;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "";
}

function secretValues(...values: string[]): string[] {
  return values.filter((value) => value.length >= 8);
}

function runCli(env: Record<string, string>): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...env,
  };
  execFile(
    process.execPath,
    existsSync(builtCli) ? [builtCli] : ["--import", "tsx", sourceCli],
    {
      cwd: repoRoot,
      env: childEnv,
      timeout: CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    },
    (error: ExecFileException | null, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const raw: unknown = error.code;
      if (raw === "ENOENT" || raw === "EACCES") {
        reject(new Error("Unable to spawn the compose migrate CLI"));
        return;
      }
      if (raw === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        resolve({ code: 1, stdout, stderr, signal: "maxbuffer" });
        return;
      }
      resolve({
        code: typeof raw === "number" ? raw : 1,
        stdout,
        stderr,
        signal: error.signal || (error.killed ? "SIGKILL" : undefined),
      });
    },
  );
  return promise;
}

function assertPrivate(output: string, secrets: readonly string[]): void {
  const urlLeaked = /postgres(?:ql)?:\/\//i.test(output);
  const leakedIndexes = secrets.flatMap((secret, index) =>
    output.includes(secret) ? [index] : [],
  );
  expect({ urlLeaked, leakedIndexes }).toEqual({
    urlLeaked: false,
    leakedIndexes: [],
  });
}

function assertCliSuccess(result: CliResult, secrets: readonly string[]): void {
  assertPrivate(`${result.stdout}\n${result.stderr}`, secrets);
  expect(result.signal).toBeUndefined();
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${SUCCESS_MESSAGE}\n`);
  expect(result.stderr).toBe("");
}

function assertCliFailure(result: CliResult, secrets: readonly string[]): void {
  assertPrivate(`${result.stdout}\n${result.stderr}`, secrets);
  expect(result.signal).toBeUndefined();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${FAILURE_MESSAGE}\n`);
}

async function reviewedLedger(): Promise<Array<Omit<LedgerRow, "applied_at">>> {
  const parsed: unknown = JSON.parse(
    await readFile(join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("Migration journal is missing");
  }
  const rows = [];
  for (const [position, entry] of parsed.entries.entries()) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("tag" in entry) ||
      !("when" in entry) ||
      typeof entry.tag !== "string" ||
      typeof entry.when !== "number" ||
      !/^\d{4,}_[A-Za-z0-9_-]+$/.test(entry.tag)
    ) {
      throw new Error("Migration journal entry is invalid");
    }
    const sql = await readFile(join(migrationsDirectory, `${entry.tag}.sql`));
    rows.push({
      position,
      version: entry.tag,
      checksum: createHash("sha256").update(sql).digest("hex"),
      journal_timestamp: String(entry.when),
    });
  }
  return rows;
}

describe.skipIf(!testDatabaseUrl)("compose database privilege cutover", () => {
  // The fixed role is cluster-global. Fixtures stay serial, and the role is
  // dropped only when this file proved it was absent before the first fixture.
  describe("serial fixtures", { concurrent: false, timeout: 240_000 }, () => {
    let admin: pg.Client;
    let roleAbsentAtGuard = false;
    let cleanupFailed = false;
    const connections = new Set<pg.Client>();
    const databases = new Set<string>();
    const auxiliaryRoles = new Set<string>();

    function track(client: pg.Client): pg.Client {
      client.on("error", () => undefined);
      connections.add(client);
      return client;
    }

    async function end(client: pg.Client): Promise<void> {
      connections.delete(client);
      await client.end().catch(() => undefined);
    }

    async function connect(url: string): Promise<pg.Client> {
      const client = track(
        new pg.Client({
          connectionString: url,
          connectionTimeoutMillis: 10_000,
        }),
      );
      try {
        await client.connect();
      } catch (error) {
        await end(client);
        throw new Error(
          `Database connection failed (${errorCode(error) || "unknown"})`,
        );
      }
      return client;
    }

    async function roleExists(name: string): Promise<boolean> {
      const result = await admin.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
        [name],
      );
      return result.rows[0].exists;
    }

    async function roleFlags(name: string): Promise<RoleFlags | undefined> {
      const result = await admin.query<RoleFlags>(
        `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
                rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname = $1`,
        [name],
      );
      return result.rows[0];
    }

    async function memberships(name: string): Promise<Membership[]> {
      const result = await admin.query<Membership>(
        `SELECT r.rolname AS role, m.rolname AS member
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
         WHERE r.rolname = $1 OR m.rolname = $1
         ORDER BY 1, 2`,
        [name],
      );
      return result.rows;
    }

    async function createDatabase(): Promise<string> {
      const name = `nr_cutover_${randomBytes(8).toString("hex")}`;
      await admin.query(
        `CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0`,
      );
      databases.add(name);
      return name;
    }

    function bootstrapDatabaseUrl(database: string): string {
      return connectionUrl(database, bootstrapUser, bootstrapPassword);
    }

    function runtimeDatabaseUrl(database: string, password: string): string {
      return connectionUrl(database, RUNTIME_ROLE, password);
    }

    async function createRuntimeRole(
      password: string,
      attributes: string,
    ): Promise<void> {
      if (!roleAbsentAtGuard) {
        throw new Error("Refusing to create the fixed role without the guard");
      }
      await admin.query(
        `CREATE ROLE ${quoteIdent(RUNTIME_ROLE)} ${attributes} PASSWORD ${admin.escapeLiteral(password)}`,
      );
    }

    async function createAuxiliaryRole(password?: string): Promise<string> {
      if (!roleAbsentAtGuard) {
        throw new Error("Refusing to create a fixture role without the guard");
      }
      const name = `nr_aux_${randomBytes(4).toString("hex")}`;
      if (password) {
        await admin.query(
          `CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD ${admin.escapeLiteral(password)}`,
        );
      } else {
        await admin.query(`CREATE ROLE ${quoteIdent(name)} NOLOGIN`);
      }
      auxiliaryRoles.add(name);
      return name;
    }

    async function grantConnect(database: string, role: string): Promise<void> {
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(role)}`,
      );
    }

    async function dropRoleIfOwned(name: string): Promise<void> {
      if (!roleAbsentAtGuard) {
        throw new Error("Refusing to drop a role this suite does not own");
      }
      if (!(await roleExists(name))) return;
      const owned = await admin.query<{ datname: string }>(
        `SELECT datname FROM pg_database
         WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
        [name],
      );
      if (owned.rows.length > 0) {
        throw new Error("Refusing to drop a role that still owns a database");
      }
      await admin.query(
        `DELETE FROM pg_auth_members
         WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
            OR member = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
        [name],
      );
      await admin.query(`DROP OWNED BY ${quoteIdent(name)}`);
      await admin.query(`DROP ROLE ${quoteIdent(name)}`);
    }

    async function cleanupFixtures(): Promise<void> {
      const clients = [...connections];
      connections.clear();
      await Promise.all(
        clients.map((client) => client.end().catch(() => undefined)),
      );
      for (const name of [...databases]) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
        );
        databases.delete(name);
      }
      if (!roleAbsentAtGuard) return;
      await dropRoleIfOwned(RUNTIME_ROLE);
      for (const name of [...auxiliaryRoles]) {
        await dropRoleIfOwned(name);
        auxiliaryRoles.delete(name);
      }
    }

    async function readLedger(client: pg.Client): Promise<LedgerRow[]> {
      const result = await client.query<LedgerRow>(
        `SELECT position, version, checksum, journal_timestamp::text AS journal_timestamp,
                applied_at
         FROM next_round.schema_migrations
         ORDER BY position`,
      );
      return result.rows;
    }

    async function principalRow(client: pg.Client, id: string) {
      const result = await client.query<{
        id: string;
        kind: string;
        display_name: string;
      }>(
        "SELECT id, kind, display_name FROM next_round.principals WHERE id = $1",
        [id],
      );
      return result.rows[0];
    }

    async function insertPrincipal(
      client: pg.Client,
      displayName: string,
    ): Promise<string> {
      const id = randomUUID();
      await client.query(
        "INSERT INTO next_round.principals (id, kind, display_name) VALUES ($1, 'registered', $2)",
        [id, displayName],
      );
      return id;
    }

    async function populate(database: string): Promise<{
      principalId: string;
      displayName: string;
      ledger: LedgerRow[];
    }> {
      const url = bootstrapDatabaseUrl(database);
      await migrateDatabase({ connectionString: url });
      const client = await connect(url);
      try {
        const displayName = `kept-${randomUUID()}`;
        const principalId = await insertPrincipal(client, displayName);
        return { principalId, displayName, ledger: await readLedger(client) };
      } finally {
        await end(client);
      }
    }

    async function relationOwner(
      client: pg.Client,
      schema: string,
      relation: string,
    ): Promise<string> {
      const result = await client.query<{ owner: string | null }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, relation],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0].owner ?? "";
    }

    async function schemaOwner(
      client: pg.Client,
      schema: string,
    ): Promise<string> {
      const result = await client.query<{ owner: string | null }>(
        "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1",
        [schema],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0].owner ?? "";
    }

    async function databaseOwner(database: string): Promise<string> {
      const result = await admin.query<{ owner: string | null }>(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
        [database],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0].owner ?? "";
    }

    async function objectsNotOwnedBy(
      client: pg.Client,
      owner: string,
    ): Promise<Array<{ object: string; owner: string }>> {
      const result = await client.query<{ object: string; owner: string }>(
        `SELECT objects.object, r.rolname AS owner
         FROM (${SCHEMA_OBJECTS}) objects
         JOIN pg_roles r ON r.oid = objects.owner
         WHERE r.rolname IS DISTINCT FROM $1
         ORDER BY 1`,
        [owner],
      );
      return result.rows;
    }

    async function countOwnedBy(
      client: pg.Client,
      owner: string,
    ): Promise<number> {
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM (${SCHEMA_OBJECTS}) objects
         JOIN pg_roles r ON r.oid = objects.owner
         WHERE r.rolname = $1`,
        [owner],
      );
      return result.rows[0].count;
    }

    async function expectRuntimeOwnsApplication(
      client: pg.Client,
    ): Promise<void> {
      expect(await objectsNotOwnedBy(client, RUNTIME_ROLE)).toEqual([]);
    }

    async function expectGrants(client: pg.Client): Promise<void> {
      const result = await client.query<{
        connect: boolean;
        create: boolean;
        temporary: boolean;
      }>(
        `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect,
                has_database_privilege($1, current_database(), 'CREATE') AS create,
                has_database_privilege($1, current_database(), 'TEMPORARY') AS temporary`,
        [RUNTIME_ROLE],
      );
      expect(result.rows[0]).toEqual({
        connect: true,
        create: true,
        temporary: true,
      });
    }

    async function expectSafeRuntimeRole(): Promise<void> {
      expect(await roleFlags(RUNTIME_ROLE)).toEqual({
        rolname: RUNTIME_ROLE,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
      expect(await memberships(RUNTIME_ROLE)).toEqual([]);
    }

    async function expectRuntimeSession(
      database: string,
      password: string,
    ): Promise<pg.Client> {
      const client = await connect(runtimeDatabaseUrl(database, password));
      const result = await client.query<{
        actor: string;
        session_actor: string;
        is_superuser: string;
      }>(
        `SELECT current_user AS actor, session_user AS session_actor,
                current_setting('is_superuser') AS is_superuser`,
      );
      expect(result.rows[0]).toEqual({
        actor: RUNTIME_ROLE,
        session_actor: RUNTIME_ROLE,
        is_superuser: "off",
      });
      return client;
    }

    async function expectAuthenticationFailure(url: string): Promise<void> {
      const client = track(
        new pg.Client({
          connectionString: url,
          connectionTimeoutMillis: 10_000,
        }),
      );
      let code = "";
      try {
        await client.connect();
        code = "connected";
      } catch (error) {
        code = errorCode(error);
      } finally {
        await end(client);
      }
      expect(code).toBe("28P01");
    }

    async function expectDenied(client: pg.Client, sql: string): Promise<void> {
      let code = "";
      try {
        await client.query(sql);
        code = "allowed";
      } catch (error) {
        code = errorCode(error);
      }
      expect(code).toBe("42501");
    }

    async function installCatalogExamples(
      client: pg.Client,
    ): Promise<CatalogExamples> {
      const suffix = randomBytes(4).toString("hex");
      const examples: CatalogExamples = {
        suffix,
        note: `kept-${suffix}`,
        untouchedSchema: `sentinel_other_${suffix}`,
        table: `sentinel_table_${suffix}`,
        view: `sentinel_view_${suffix}`,
        matview: `sentinel_matview_${suffix}`,
        sequence: `sentinel_sequence_${suffix}`,
        fn: `sentinel_function_${suffix}`,
        procedure: `sentinel_procedure_${suffix}`,
        enumName: `sentinel_enum_${suffix}`,
        domain: `sentinel_domain_${suffix}`,
        partitioned: `sentinel_partitioned_${suffix}`,
        partition: `sentinel_partition_${suffix}`,
        index: `sentinel_index_${suffix}`,
        trigger: `sentinel_trigger_${suffix}`,
        triggerFn: `sentinel_trigger_fn_${suffix}`,
        pgbossTable: `sentinel_extra_${suffix}`,
      };
      const table = `${quoteIdent("next_round")}.${quoteIdent(examples.table)}`;
      await client.query(
        `CREATE TYPE next_round.${quoteIdent(examples.enumName)} AS ENUM ('kept', 'other')`,
      );
      await client.query(
        `CREATE DOMAIN next_round.${quoteIdent(examples.domain)} AS text CHECK (VALUE <> '')`,
      );
      await client.query(
        `CREATE SEQUENCE next_round.${quoteIdent(examples.sequence)}`,
      );
      await client.query(
        `CREATE TABLE ${table} (
           id integer PRIMARY KEY,
           note text NOT NULL,
           kind next_round.${quoteIdent(examples.enumName)} NOT NULL,
           label next_round.${quoteIdent(examples.domain)} NOT NULL
         )`,
      );
      await client.query(
        `CREATE INDEX ${quoteIdent(examples.index)} ON ${table} (note)`,
      );
      await client.query(
        `INSERT INTO ${table} (id, note, kind, label) VALUES (1, $1, 'kept', 'kept')`,
        [examples.note],
      );
      await client.query(
        `CREATE FUNCTION next_round.${quoteIdent(examples.triggerFn)}() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      );
      await client.query(
        `CREATE TRIGGER ${quoteIdent(examples.trigger)}
         BEFORE UPDATE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION next_round.${quoteIdent(examples.triggerFn)}()`,
      );
      await client.query(
        `CREATE FUNCTION next_round.${quoteIdent(examples.fn)}() RETURNS integer
         LANGUAGE sql AS $$ SELECT 1 $$`,
      );
      await client.query(
        `CREATE PROCEDURE next_round.${quoteIdent(examples.procedure)}()
         LANGUAGE plpgsql AS $$ BEGIN NULL; END $$`,
      );
      await client.query(
        `CREATE VIEW next_round.${quoteIdent(examples.view)} AS
         SELECT id, note, kind, label FROM ${table}`,
      );
      await client.query(
        `CREATE MATERIALIZED VIEW next_round.${quoteIdent(examples.matview)} AS
         SELECT id, note, kind, label FROM ${table}`,
      );
      await client.query(
        `CREATE TABLE next_round.${quoteIdent(examples.partitioned)} (
           id integer NOT NULL,
           bucket text NOT NULL
         ) PARTITION BY LIST (bucket)`,
      );
      await client.query(
        `CREATE TABLE next_round.${quoteIdent(examples.partition)}
         PARTITION OF next_round.${quoteIdent(examples.partitioned)}
         FOR VALUES IN ('kept')`,
      );
      await client.query(
        `INSERT INTO next_round.${quoteIdent(examples.partitioned)} (id, bucket)
         VALUES (1, 'kept')`,
      );
      await client.query(
        `CREATE TABLE pgboss.${quoteIdent(examples.pgbossTable)} (
           id integer PRIMARY KEY,
           note text NOT NULL
         )`,
      );
      await client.query(
        `INSERT INTO pgboss.${quoteIdent(examples.pgbossTable)} (id, note) VALUES (1, $1)`,
        [examples.note],
      );
      await client.query(
        `CREATE SCHEMA ${quoteIdent(examples.untouchedSchema)}`,
      );
      await client.query(
        `CREATE TABLE ${quoteIdent(examples.untouchedSchema)}.kept (id integer PRIMARY KEY)`,
      );
      await client.query(
        `INSERT INTO ${quoteIdent(examples.untouchedSchema)}.kept (id) VALUES (1)`,
      );
      return examples;
    }

    async function expectExamplesExist(
      client: pg.Client,
      examples: CatalogExamples,
    ): Promise<void> {
      for (const name of [
        examples.table,
        examples.view,
        examples.matview,
        examples.sequence,
        examples.partitioned,
        examples.partition,
        examples.index,
      ]) {
        const result = await client.query<{ relation: string | null }>(
          "SELECT to_regclass($1) AS relation",
          [`next_round.${name}`],
        );
        expect(result.rows[0].relation).not.toBeNull();
      }
      const routines = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'next_round' AND p.proname = ANY ($1::text[])`,
        [[examples.fn, examples.procedure, examples.triggerFn]],
      );
      expect(routines.rows[0].count).toBe(3);
      const types = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'next_round' AND t.typname = ANY ($1::text[])`,
        [[examples.enumName, examples.domain]],
      );
      expect(types.rows[0].count).toBe(2);
      const trigger = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal",
        [examples.trigger],
      );
      expect(trigger.rows[0].count).toBe(1);
      expect(await relationOwner(client, "next_round", examples.sequence)).toBe(
        RUNTIME_ROLE,
      );
      expect(
        await relationOwner(client, "next_round", examples.partitioned),
      ).toBe(RUNTIME_ROLE);
      expect(
        await relationOwner(client, "next_round", examples.partition),
      ).toBe(RUNTIME_ROLE);
      expect(await relationOwner(client, "pgboss", examples.pgbossTable)).toBe(
        RUNTIME_ROLE,
      );
      const typesOwned = await client.query<{ name: string; owner: string }>(
        `SELECT t.typname AS name, pg_get_userbyid(t.typowner) AS owner
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'next_round' AND t.typname = ANY ($1::text[])`,
        [[examples.enumName, examples.domain]],
      );
      expect(
        Object.fromEntries(typesOwned.rows.map((row) => [row.name, row.owner])),
      ).toEqual({
        [examples.domain]: RUNTIME_ROLE,
        [examples.enumName]: RUNTIME_ROLE,
      });
      const procedure = await client.query<{ owner: string }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'next_round' AND p.proname = $1 AND p.prokind = 'p'`,
        [examples.procedure],
      );
      expect(procedure.rows[0]?.owner).toBe(RUNTIME_ROLE);
      const extra = await client.query<{ relation: string | null }>(
        "SELECT to_regclass($1) AS relation",
        [`pgboss.${examples.pgbossTable}`],
      );
      expect(extra.rows[0].relation).not.toBeNull();
    }

    async function installPgBossPartition(
      client: pg.Client,
    ): Promise<{ queue: string; partition: string }> {
      const queue = `sentinel_q_${randomBytes(4).toString("hex")}`;
      await client.query("SELECT pgboss.create_queue($1, $2::jsonb)", [
        queue,
        JSON.stringify({ policy: "standard", partition: true }),
      ]);
      const created = await client.query<{ relname: string }>(
        `SELECT c.relname
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class parent ON parent.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = parent.relnamespace
         JOIN pg_namespace cn ON cn.oid = c.relnamespace
         WHERE n.nspname = 'pgboss'
           AND parent.relname = 'job'
           AND cn.nspname = 'pgboss'
           AND c.relname <> 'job_common'`,
      );
      expect(created.rows).toHaveLength(1);
      return { queue, partition: created.rows[0].relname };
    }

    async function expectPgBossOperational(
      client: pg.Client,
      fixture: { queue: string; partition: string },
    ): Promise<void> {
      expect(await schemaOwner(client, "pgboss")).toBe(RUNTIME_ROLE);
      for (const relation of [
        "job",
        "job_common",
        "version",
        fixture.partition,
      ]) {
        expect(await relationOwner(client, "pgboss", relation)).toBe(
          RUNTIME_ROLE,
        );
      }
      const enumOwner = await client.query<{ owner: string }>(
        `SELECT pg_get_userbyid(t.typowner) AS owner
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'pgboss' AND t.typname = 'job_state' AND t.typtype = 'e'`,
      );
      expect(enumOwner.rows[0]?.owner).toBe(RUNTIME_ROLE);
      const clock = await client.query<{ owner: string; value: Date }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, pgboss.job_now() AS value
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'pgboss' AND p.proname = 'job_now' AND p.prokind = 'f'`,
      );
      expect(clock.rows[0]?.owner).toBe(RUNTIME_ROLE);
      expect(clock.rows[0]?.value).toBeInstanceOf(Date);
      const version = await client.query("SELECT version FROM pgboss.version");
      expect(version.rows.length).toBeGreaterThan(0);
      const queue = await client.query<{
        partition: boolean;
        table_name: string;
      }>("SELECT partition, table_name FROM pgboss.queue WHERE name = $1", [
        fixture.queue,
      ]);
      expect(queue.rows[0]).toEqual({
        partition: true,
        table_name: fixture.partition,
      });
      const parent = await client.query<{ parent: string }>(
        `SELECT parent.relname AS parent
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class parent ON parent.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'pgboss' AND c.relname = $1`,
        [fixture.partition],
      );
      expect(parent.rows[0]?.parent).toBe("job");
    }

    async function expectUntouched(
      database: string,
      schema: string,
    ): Promise<void> {
      const client = await connect(bootstrapDatabaseUrl(database));
      try {
        expect(await schemaOwner(client, schema)).toBe(bootstrapUser);
        expect(await relationOwner(client, schema, "kept")).toBe(bootstrapUser);
        const row = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${quoteIdent(schema)}.kept`,
        );
        expect(row.rows[0].count).toBe(1);
      } finally {
        await end(client);
      }
    }

    function cutoverEnv(
      database: string,
      runtimePassword: string,
      runtimeUrlPassword = runtimePassword,
      directUrl = "",
    ): Record<string, string> {
      return {
        DATABASE_BOOTSTRAP_URL: bootstrapDatabaseUrl(database),
        DATABASE_URL: runtimeDatabaseUrl(database, runtimeUrlPassword),
        RUNTIME_DATABASE_PASSWORD: runtimePassword,
        DATABASE_DIRECT_URL: directUrl,
      };
    }

    beforeAll(async () => {
      admin = new pg.Client({
        connectionString: testDatabaseUrl,
        connectionTimeoutMillis: 10_000,
      });
      admin.on("error", () => undefined);
      await admin.connect();
      await admin.query("SET statement_timeout = '30s'");
      await admin.query("SET lock_timeout = '10s'");
      if (await roleExists(RUNTIME_ROLE)) {
        throw new Error(
          "next_round_runtime already exists; refusing to adopt or drop it",
        );
      }
      roleAbsentAtGuard = true;
    }, 30_000);

    beforeEach(() => {
      if (cleanupFailed) {
        throw new Error(
          "Previous fixture cleanup failed; refusing to continue",
        );
      }
    });

    afterEach(async () => {
      if (!admin) return;
      try {
        await cleanupFixtures();
      } catch (error) {
        cleanupFailed = true;
        throw error;
      }
    }, 60_000);

    afterAll(async () => {
      try {
        if (admin && roleAbsentAtGuard) await cleanupFixtures();
      } finally {
        await admin?.end().catch(() => undefined);
      }
    }, 60_000);

    it("migrates a fresh database under the non-superuser runtime role", async () => {
      const database = await createDatabase();
      const password = hexPassword();
      const untouched = `sentinel_other_${randomBytes(4).toString("hex")}`;
      const bootstrap = await connect(bootstrapDatabaseUrl(database));
      await bootstrap.query(`CREATE SCHEMA ${quoteIdent(untouched)}`);
      await bootstrap.query(
        `CREATE TABLE ${quoteIdent(untouched)}.kept (id integer PRIMARY KEY)`,
      );
      await bootstrap.query(
        `INSERT INTO ${quoteIdent(untouched)}.kept (id) VALUES (1)`,
      );
      await end(bootstrap);
      const secrets = secretValues(
        bootstrapPassword,
        encodeURIComponent(bootstrapPassword),
        password,
        database,
        untouched,
      );
      const result = await runCli(cutoverEnv(database, password));
      assertCliSuccess(result, secrets);

      expect(await databaseOwner(database)).toBe(bootstrapUser);
      await expectSafeRuntimeRole();
      const client = await expectRuntimeSession(database, password);
      try {
        await expectRuntimeOwnsApplication(client);
        await expectGrants(client);
        await expectUntouched(database, untouched);
        const applied = await readLedger(client);
        expect(
          applied.map((row) => ({
            position: row.position,
            version: row.version,
            checksum: row.checksum,
            journal_timestamp: row.journal_timestamp,
          })),
        ).toEqual(await reviewedLedger());
        expect(
          (await client.query("SELECT version FROM pgboss.version")).rows,
        ).toHaveLength(1);
        const displayName = `runtime-${randomUUID()}`;
        const principalId = await insertPrincipal(client, displayName);
        expect(await principalRow(client, principalId)).toEqual({
          id: principalId,
          kind: "registered",
          display_name: displayName,
        });
        const forbidden = `nr_aux_${randomBytes(4).toString("hex")}`;
        await expectDenied(client, `CREATE ROLE ${quoteIdent(forbidden)}`);
        expect(await roleExists(forbidden)).toBe(false);
        await expectDenied(client, `SET ROLE ${quoteIdent(bootstrapUser)}`);
        const actor = await client.query<{ actor: string }>(
          "SELECT current_user AS actor",
        );
        expect(actor.rows[0].actor).toBe(RUNTIME_ROLE);
      } finally {
        await end(client);
      }
    });

    it("transfers populated schemas, preserves data and ledger, and repeats", async () => {
      const database = await createDatabase();
      const populated = await populate(database);
      const bootstrap = await connect(bootstrapDatabaseUrl(database));
      const examples = await installCatalogExamples(bootstrap);
      const boss = await installPgBossPartition(bootstrap);
      const beforeOwners = await objectsNotOwnedBy(bootstrap, bootstrapUser);
      expect(beforeOwners).toEqual([]);
      await end(bootstrap);
      const password = hexPassword();
      const secrets = secretValues(
        bootstrapPassword,
        encodeURIComponent(bootstrapPassword),
        password,
        database,
        populated.displayName,
        examples.note,
        examples.untouchedSchema,
        examples.table,
        examples.pgbossTable,
        examples.fn,
        examples.procedure,
        examples.sequence,
        examples.partition,
        examples.enumName,
        examples.domain,
        boss.queue,
        boss.partition,
      );
      const first = await runCli(cutoverEnv(database, password));
      assertCliSuccess(first, secrets);

      expect(await databaseOwner(database)).toBe(bootstrapUser);
      await expectSafeRuntimeRole();
      const client = await expectRuntimeSession(database, password);
      try {
        await expectRuntimeOwnsApplication(client);
        await expectExamplesExist(client, examples);
        await expectPgBossOperational(client, boss);
        await expectUntouched(database, examples.untouchedSchema);
        expect(await readLedger(client)).toEqual(populated.ledger);
        expect(await principalRow(client, populated.principalId)).toEqual({
          id: populated.principalId,
          kind: "registered",
          display_name: populated.displayName,
        });
        const note = await client.query<{ note: string }>(
          `SELECT note FROM next_round.${quoteIdent(examples.table)} WHERE id = 1`,
        );
        expect(note.rows[0].note).toBe(examples.note);
        const view = await client.query<{ note: string }>(
          `SELECT note FROM next_round.${quoteIdent(examples.view)} WHERE id = 1`,
        );
        expect(view.rows[0].note).toBe(examples.note);
        const matview = await client.query<{ note: string }>(
          `SELECT note FROM next_round.${quoteIdent(examples.matview)} WHERE id = 1`,
        );
        expect(matview.rows[0].note).toBe(examples.note);
        const fn = await client.query<{ value: number }>(
          `SELECT next_round.${quoteIdent(examples.fn)}() AS value`,
        );
        expect(fn.rows[0].value).toBe(1);
        await client.query(
          `CALL next_round.${quoteIdent(examples.procedure)}()`,
        );
        const sequence = await client.query<{ value: string }>(
          `SELECT nextval('next_round.${examples.sequence}') AS value`,
        );
        expect(Number(sequence.rows[0].value)).toBeGreaterThan(0);
        const extra = await client.query<{ note: string }>(
          `SELECT note FROM pgboss.${quoteIdent(examples.pgbossTable)} WHERE id = 1`,
        );
        expect(extra.rows[0].note).toBe(examples.note);
        const partition = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM next_round.${quoteIdent(examples.partitioned)}`,
        );
        expect(partition.rows[0].count).toBe(1);
      } finally {
        await end(client);
      }

      const second = await runCli(cutoverEnv(database, password));
      assertCliSuccess(second, secrets);
      const after = await connect(runtimeDatabaseUrl(database, password));
      try {
        await expectRuntimeOwnsApplication(after);
        await expectExamplesExist(after, examples);
        await expectPgBossOperational(after, boss);
        expect(await readLedger(after)).toEqual(populated.ledger);
        expect(await principalRow(after, populated.principalId)).toEqual({
          id: populated.principalId,
          kind: "registered",
          display_name: populated.displayName,
        });
        await expectSafeRuntimeRole();
      } finally {
        await end(after);
      }
    });

    it("keeps a committed cutover when the runtime password does not match", async () => {
      const database = await createDatabase();
      const populated = await populate(database);
      const runtimePassword = hexPassword();
      const wrongPassword = differentPassword(runtimePassword);
      const secrets = secretValues(
        bootstrapPassword,
        encodeURIComponent(bootstrapPassword),
        runtimePassword,
        wrongPassword,
        database,
        populated.displayName,
      );
      const result = await runCli(
        cutoverEnv(database, runtimePassword, wrongPassword),
      );
      assertCliFailure(result, secrets);

      expect(await databaseOwner(database)).toBe(bootstrapUser);
      await expectSafeRuntimeRole();
      await expectAuthenticationFailure(
        runtimeDatabaseUrl(database, wrongPassword),
      );
      const client = await expectRuntimeSession(database, runtimePassword);
      try {
        await expectRuntimeOwnsApplication(client);
        await expectGrants(client);
        expect(await readLedger(client)).toEqual(populated.ledger);
        expect(await principalRow(client, populated.principalId)).toEqual({
          id: populated.principalId,
          kind: "registered",
          display_name: populated.displayName,
        });
      } finally {
        await end(client);
      }
    });

    it("keeps a committed cutover when the direct role is not runtime", async () => {
      const database = await createDatabase();
      const populated = await populate(database);
      const password = hexPassword();
      const secrets = secretValues(
        bootstrapPassword,
        encodeURIComponent(bootstrapPassword),
        password,
        database,
        populated.displayName,
      );
      const result = await runCli(
        cutoverEnv(
          database,
          password,
          password,
          bootstrapDatabaseUrl(database),
        ),
      );
      assertCliFailure(result, secrets);

      expect(await databaseOwner(database)).toBe(bootstrapUser);
      await expectSafeRuntimeRole();
      const client = await expectRuntimeSession(database, password);
      try {
        await expectRuntimeOwnsApplication(client);
        await expectGrants(client);
        expect(await readLedger(client)).toEqual(populated.ledger);
        expect(await principalRow(client, populated.principalId)).toEqual({
          id: populated.principalId,
          kind: "registered",
          display_name: populated.displayName,
        });
      } finally {
        await end(client);
      }
    });

    it("does not migrate through a mismatched direct role", async () => {
      const database = await createDatabase();
      const note = `kept-${randomBytes(4).toString("hex")}`;
      const table = `sentinel_kept_${randomBytes(4).toString("hex")}`;
      const bootstrap = await connect(bootstrapDatabaseUrl(database));
      await bootstrap.query("CREATE SCHEMA next_round");
      await bootstrap.query(
        `CREATE TABLE next_round.${quoteIdent(table)} (id integer PRIMARY KEY, note text NOT NULL)`,
      );
      await bootstrap.query(
        `INSERT INTO next_round.${quoteIdent(table)} (id, note) VALUES (1, $1)`,
        [note],
      );
      await end(bootstrap);
      const password = hexPassword();
      const secrets = secretValues(
        bootstrapPassword,
        encodeURIComponent(bootstrapPassword),
        password,
        database,
        note,
        table,
      );
      const result = await runCli(
        cutoverEnv(
          database,
          password,
          password,
          bootstrapDatabaseUrl(database),
        ),
      );
      assertCliFailure(result, secrets);

      await expectSafeRuntimeRole();
      const client = await expectRuntimeSession(database, password);
      try {
        expect(await relationOwner(client, "next_round", table)).toBe(
          RUNTIME_ROLE,
        );
        expect(await schemaOwner(client, "next_round")).toBe(RUNTIME_ROLE);
        const row = await client.query<{ note: string }>(
          `SELECT note FROM next_round.${quoteIdent(table)} WHERE id = 1`,
        );
        expect(row.rows[0].note).toBe(note);
        const ledger = await client.query<{ relation: string | null }>(
          "SELECT to_regclass('next_round.schema_migrations') AS relation",
        );
        expect(ledger.rows[0].relation).toBeNull();
        const boss = await client.query<{ relation: string | null }>(
          "SELECT to_regclass('pgboss.version') AS relation",
        );
        expect(boss.rows[0].relation).toBeNull();
      } finally {
        await end(client);
      }
    });

    async function expectProvisioningRollback(
      database: string,
      oldPassword: string,
      newPassword: string,
    ): Promise<void> {
      const client = await connect(bootstrapDatabaseUrl(database));
      try {
        expect(await countOwnedBy(client, RUNTIME_ROLE)).toBe(0);
        expect(await relationOwner(client, "next_round", "principals")).toBe(
          bootstrapUser,
        );
      } finally {
        await end(client);
      }
      await expectAuthenticationFailure(
        runtimeDatabaseUrl(database, newPassword),
      );
      const runtime = await connect(runtimeDatabaseUrl(database, oldPassword));
      try {
        const actor = await runtime.query<{ actor: string }>(
          "SELECT current_user AS actor",
        );
        expect(actor.rows[0].actor).toBe(RUNTIME_ROLE);
      } finally {
        await end(runtime);
      }
    }

    for (const attribute of [
      "SUPERUSER",
      "CREATEDB",
      "CREATEROLE",
      "REPLICATION",
      "BYPASSRLS",
    ] as const) {
      it(`rejects an existing ${attribute} role without adopting it`, async () => {
        const database = await createDatabase();
        const populated = await populate(database);
        const oldPassword = hexPassword();
        const newPassword = differentPassword(oldPassword);
        await createRuntimeRole(oldPassword, elevatedAttributes(attribute));
        await grantConnect(database, RUNTIME_ROLE);
        const before = await roleFlags(RUNTIME_ROLE);
        const secrets = secretValues(
          bootstrapPassword,
          encodeURIComponent(bootstrapPassword),
          oldPassword,
          newPassword,
          database,
          populated.displayName,
        );
        const result = await runCli(cutoverEnv(database, newPassword));
        assertCliFailure(result, secrets);

        expect(await roleFlags(RUNTIME_ROLE)).toEqual(before);
        expect(await memberships(RUNTIME_ROLE)).toEqual([]);
        expect(await databaseOwner(database)).toBe(bootstrapUser);
        await expectProvisioningRollback(database, oldPassword, newPassword);
        const client = await connect(bootstrapDatabaseUrl(database));
        try {
          expect(await readLedger(client)).toEqual(populated.ledger);
          expect(await principalRow(client, populated.principalId)).toEqual({
            id: populated.principalId,
            kind: "registered",
            display_name: populated.displayName,
          });
        } finally {
          await end(client);
        }
      });
    }

    for (const direction of ["member", "has-member"] as const) {
      it(`rejects an existing role with a ${direction} edge without adopting it`, async () => {
        const database = await createDatabase();
        const populated = await populate(database);
        const oldPassword = hexPassword();
        const newPassword = differentPassword(oldPassword);
        const aux = await createAuxiliaryRole();
        await createRuntimeRole(
          oldPassword,
          "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
        );
        await grantConnect(database, RUNTIME_ROLE);
        if (direction === "member") {
          await admin.query(
            `GRANT ${quoteIdent(aux)} TO ${quoteIdent(RUNTIME_ROLE)}`,
          );
        } else {
          await admin.query(
            `GRANT ${quoteIdent(RUNTIME_ROLE)} TO ${quoteIdent(aux)}`,
          );
        }
        const before = await memberships(RUNTIME_ROLE);
        expect(before).toHaveLength(1);
        const secrets = secretValues(
          bootstrapPassword,
          encodeURIComponent(bootstrapPassword),
          oldPassword,
          newPassword,
          database,
          populated.displayName,
          aux,
        );
        const result = await runCli(cutoverEnv(database, newPassword));
        assertCliFailure(result, secrets);

        expect(await roleFlags(RUNTIME_ROLE)).toEqual({
          rolname: RUNTIME_ROLE,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: true,
        });
        expect(await memberships(RUNTIME_ROLE)).toEqual(before);
        await expectProvisioningRollback(database, oldPassword, newPassword);
        const client = await connect(bootstrapDatabaseUrl(database));
        try {
          expect(await readLedger(client)).toEqual(populated.ledger);
          expect(await principalRow(client, populated.principalId)).toEqual({
            id: populated.principalId,
            kind: "registered",
            display_name: populated.displayName,
          });
        } finally {
          await end(client);
        }
      });
    }

    it("rolls back when an application object has an unexpected owner", async () => {
      const database = await createDatabase();
      const populated = await populate(database);
      const oldPassword = hexPassword();
      const newPassword = differentPassword(oldPassword);
      const owner = await createAuxiliaryRole();
      const foreign = `sentinel_foreign_${randomBytes(4).toString("hex")}`;
      await createRuntimeRole(
        oldPassword,
        "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
      );
      await grantConnect(database, RUNTIME_ROLE);
      const bootstrap = await connect(bootstrapDatabaseUrl(database));
      await bootstrap.query(
        `CREATE TABLE next_round.${quoteIdent(foreign)} (id integer PRIMARY KEY)`,
      );
      await bootstrap.query(
        `CREATE TABLE pgboss.${quoteIdent(foreign)} (id integer PRIMARY KEY)`,
      );
      await bootstrap.query(
        `ALTER TABLE next_round.${quoteIdent(foreign)} OWNER TO ${quoteIdent(owner)}`,
      );
      await bootstrap.query(
        `ALTER TABLE pgboss.${quoteIdent(foreign)} OWNER TO ${quoteIdent(owner)}`,
      );
      await end(bootstrap);
      const secrets = secretValues(
        bootstrapPassword,
        encodeURIComponent(bootstrapPassword),
        oldPassword,
        newPassword,
        database,
        populated.displayName,
        owner,
        foreign,
      );
      const result = await runCli(cutoverEnv(database, newPassword));
      assertCliFailure(result, secrets);

      expect(await roleFlags(RUNTIME_ROLE)).toEqual({
        rolname: RUNTIME_ROLE,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
      expect(await memberships(RUNTIME_ROLE)).toEqual([]);
      await expectProvisioningRollback(database, oldPassword, newPassword);
      const client = await connect(bootstrapDatabaseUrl(database));
      try {
        expect(await relationOwner(client, "next_round", foreign)).toBe(owner);
        expect(await relationOwner(client, "pgboss", foreign)).toBe(owner);
        expect(await readLedger(client)).toEqual(populated.ledger);
        expect(await principalRow(client, populated.principalId)).toEqual({
          id: populated.principalId,
          kind: "registered",
          display_name: populated.displayName,
        });
      } finally {
        await end(client);
      }
    });
  });
});

function elevatedAttributes(attribute: ElevatedAttribute): string {
  switch (attribute) {
    case "SUPERUSER":
      return "LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS";
    case "CREATEDB":
      return "LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
    case "CREATEROLE":
      return "LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS";
    case "REPLICATION":
      return "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS";
    case "BYPASSRLS":
      return "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS";
  }
}
