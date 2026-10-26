// SPDX-License-Identifier: Apache-2.0

import pg from "pg";
import { migrateDatabase } from "./migrate.js";

const runtimeRole = "next_round_runtime";
// Same session lock as migrate.ts. Qualification only avoids search_path shadowing.
const migrationLockNamespace = 0x4e524d47;
const migrationLockKey = 1;
const applicationSchemas = ["next_round", "pgboss"];

interface RoleFlags {
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

interface OwnedName {
  schema_name: string;
  object_name: string;
  owner: string;
}

interface OwnedRoutine extends OwnedName {
  identity_arguments: string;
}

function quoteIdent(identifier: string): string {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new Error("invalid identifier");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("invalid literal");
  return `'${value.replaceAll("'", "''")}'`;
}

function nonblank(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requiredPassword(value: string | undefined): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("invalid runtime password");
  }
  return value;
}

function requiredConnectionUrl(value: string | undefined): string {
  const connectionString = nonblank(value);
  if (!connectionString) throw new Error("missing connection url");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("invalid connection url");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("invalid connection url");
  }
  return connectionString;
}

function decodedUsername(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.username === "") return "";
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error("invalid connection url");
  }
}

function isDuplicateRole(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42710"
  );
}

function hasElevatedAttribute(row: RoleFlags): boolean {
  return (
    row.rolsuper !== false ||
    row.rolcreatedb !== false ||
    row.rolcreaterole !== false ||
    row.rolreplication !== false ||
    row.rolbypassrls !== false
  );
}

function qualifiedName(schema: string, name: string): string {
  if (schema !== "next_round" && schema !== "pgboss") {
    throw new Error("unexpected schema");
  }
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function routineStatement(
  kind: "FUNCTION" | "PROCEDURE",
  schema: string,
  name: string,
  args: string,
): string {
  if (
    typeof args !== "string" ||
    args.includes("\0") ||
    args.includes(";") ||
    args.includes("--") ||
    args.includes("/*")
  ) {
    throw new Error("unexpected routine signature");
  }
  return `ALTER ${kind} ${qualifiedName(schema, name)}(${args}) OWNER TO ${quoteIdent(runtimeRole)}`;
}

async function endClient(client: pg.Client | undefined): Promise<void> {
  if (!client) return;
  try {
    await client.end();
  } catch {
    // end() errors can carry connection details. Session exit still closes it.
  }
}

async function assertRuntimeRoleSafe(client: pg.Client): Promise<void> {
  const flags = await client.query<RoleFlags>(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
     FROM pg_catalog.pg_roles
     WHERE rolname = $1`,
    [runtimeRole],
  );
  const row = flags.rows[0];
  if (!row || hasElevatedAttribute(row)) {
    throw new Error("runtime role is missing or elevated");
  }
  const membership = await client.query<{ has_membership: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS m
       JOIN pg_catalog.pg_roles AS r ON r.rolname = $1
       WHERE m.roleid = r.oid OR m.member = r.oid
     ) AS has_membership`,
    [runtimeRole],
  );
  if (membership.rows[0]?.has_membership !== false) {
    throw new Error("runtime role has memberships");
  }
}

async function ensureRuntimeRole(
  client: pg.Client,
  password: string,
): Promise<void> {
  const passwordSql = quoteLiteral(password);
  const roleSql = quoteIdent(runtimeRole);
  const existing = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
    [runtimeRole],
  );
  if (existing.rows.length === 0) {
    await client.query("SAVEPOINT compose_role");
    try {
      await client.query(
        `CREATE ROLE ${roleSql} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${passwordSql}`,
      );
      await client.query("RELEASE SAVEPOINT compose_role");
      return;
    } catch (error) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT compose_role");
      } catch {
        throw new Error("runtime role creation failed");
      }
      if (!isDuplicateRole(error))
        throw new Error("runtime role creation failed");
    }
  }
  // Reject a powerful or related role instead of clearing attributes or edges.
  await assertRuntimeRoleSafe(client);
  await client.query(
    `ALTER ROLE ${roleSql} WITH LOGIN PASSWORD ${passwordSql}`,
  );
}

async function alterIfBootstrapOwned(
  client: pg.Client,
  bootstrapRole: string,
  owner: string,
  statement: string,
): Promise<void> {
  if (owner === runtimeRole) return;
  if (owner !== bootstrapRole) throw new Error("unexpected object owner");
  await client.query(statement);
}

async function assertTransferableOwners(
  client: pg.Client,
  bootstrapRole: string,
): Promise<void> {
  const owners = await client.query<{ owner: string | null }>(
    `SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner
     FROM pg_catalog.pg_namespace AS n
     WHERE n.nspname = ANY($1::text[])
     UNION ALL
     SELECT pg_catalog.pg_get_userbyid(c.relowner)
     FROM pg_catalog.pg_class AS c
     JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
     UNION ALL
     SELECT pg_catalog.pg_get_userbyid(p.proowner)
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1::text[])
     UNION ALL
     SELECT pg_catalog.pg_get_userbyid(t.typowner)
     FROM pg_catalog.pg_type AS t
     JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY($1::text[])`,
    [applicationSchemas],
  );
  for (const row of owners.rows) {
    if (row.owner !== bootstrapRole && row.owner !== runtimeRole) {
      throw new Error("unexpected object owner");
    }
  }
}

async function transferRelations(
  client: pg.Client,
  bootstrapRole: string,
  relkinds: readonly string[],
  kind: "TABLE" | "SEQUENCE" | "VIEW" | "MATERIALIZED VIEW",
): Promise<void> {
  const result = await client.query<OwnedName>(
    `SELECT n.nspname AS schema_name,
            c.relname AS object_name,
            pg_catalog.pg_get_userbyid(c.relowner) AS owner
     FROM pg_catalog.pg_class AS c
     JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind::text = ANY($2::text[])
     ORDER BY c.relispartition ASC, n.nspname, c.relname`,
    [applicationSchemas, relkinds],
  );
  for (const row of result.rows) {
    await alterIfBootstrapOwned(
      client,
      bootstrapRole,
      row.owner,
      `ALTER ${kind} ${qualifiedName(row.schema_name, row.object_name)} OWNER TO ${quoteIdent(runtimeRole)}`,
    );
  }
}

async function transferRoutines(
  client: pg.Client,
  bootstrapRole: string,
  kind: "FUNCTION" | "PROCEDURE",
  prokind: "f" | "p",
): Promise<void> {
  const result = await client.query<OwnedRoutine>(
    `SELECT n.nspname AS schema_name,
            p.proname AS object_name,
            pg_catalog.pg_get_userbyid(p.proowner) AS owner,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments
     FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1::text[])
       AND p.prokind::text = $2
     ORDER BY n.nspname, p.proname, p.oid`,
    [applicationSchemas, prokind],
  );
  for (const row of result.rows) {
    await alterIfBootstrapOwned(
      client,
      bootstrapRole,
      row.owner,
      routineStatement(
        kind,
        row.schema_name,
        row.object_name,
        row.identity_arguments,
      ),
    );
  }
}

async function transferOwnership(
  client: pg.Client,
  bootstrapRole: string,
): Promise<void> {
  await assertTransferableOwners(client, bootstrapRole);

  const schemas = await client.query<{ object_name: string; owner: string }>(
    `SELECT n.nspname AS object_name,
            pg_catalog.pg_get_userbyid(n.nspowner) AS owner
     FROM pg_catalog.pg_namespace AS n
     WHERE n.nspname = ANY($1::text[])
     ORDER BY n.nspname`,
    [applicationSchemas],
  );
  for (const row of schemas.rows) {
    if (row.object_name !== "next_round" && row.object_name !== "pgboss") {
      throw new Error("unexpected schema");
    }
    await alterIfBootstrapOwned(
      client,
      bootstrapRole,
      row.owner,
      `ALTER SCHEMA ${quoteIdent(row.object_name)} OWNER TO ${quoteIdent(runtimeRole)}`,
    );
  }

  // Parents before partitions. OWNED BY sequences reject a new owner until the
  // linked table has that owner, so every table is transferred before sequences.
  await transferRelations(client, bootstrapRole, ["r", "p"], "TABLE");
  await transferRelations(client, bootstrapRole, ["S"], "SEQUENCE");
  await transferRelations(client, bootstrapRole, ["v"], "VIEW");
  await transferRelations(client, bootstrapRole, ["m"], "MATERIALIZED VIEW");

  const types = await client.query<OwnedName>(
    `SELECT n.nspname AS schema_name,
            t.typname AS object_name,
            pg_catalog.pg_get_userbyid(t.typowner) AS owner
     FROM pg_catalog.pg_type AS t
     JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY($1::text[])
       AND t.typtype::text = ANY($2::text[])
       AND t.typelem = 0
     ORDER BY n.nspname, t.typname`,
    [applicationSchemas, ["e", "d"]],
  );
  for (const row of types.rows) {
    await alterIfBootstrapOwned(
      client,
      bootstrapRole,
      row.owner,
      `ALTER TYPE ${qualifiedName(row.schema_name, row.object_name)} OWNER TO ${quoteIdent(runtimeRole)}`,
    );
  }

  await transferRoutines(client, bootstrapRole, "FUNCTION", "f");
  await transferRoutines(client, bootstrapRole, "PROCEDURE", "p");
}

async function provision(
  bootstrapUrl: string,
  password: string,
): Promise<string> {
  const client = new pg.Client({ connectionString: bootstrapUrl });
  let connectionFailed = false;
  let locked = false;
  let inTransaction = false;
  client.on("error", () => {
    connectionFailed = true;
  });
  try {
    await client.connect();
    const identity = await client.query<{
      current_role: string;
      database_name: string;
    }>(
      `SELECT current_user AS current_role,
              current_database() AS database_name`,
    );
    const bootstrapRole = identity.rows[0]?.current_role;
    const database = identity.rows[0]?.database_name;
    if (!bootstrapRole || !database)
      throw new Error("missing session identity");
    if (bootstrapRole === runtimeRole) {
      throw new Error("bootstrap role is runtime");
    }

    await client.query(
      "SELECT pg_catalog.pg_advisory_lock($1::integer, $2::integer)",
      [migrationLockNamespace, migrationLockKey],
    );
    locked = true;
    await client.query("BEGIN");
    inTransaction = true;
    await client.query(
      "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
    );
    // Password literals are standard-conforming; do not depend on the server default.
    await client.query(
      "SELECT pg_catalog.set_config('standard_conforming_strings', 'on', true)",
    );
    await ensureRuntimeRole(client, password);
    await client.query(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(runtimeRole)}`,
    );
    await transferOwnership(client, bootstrapRole);
    if (connectionFailed) throw new Error("bootstrap connection failed");
    await client.query("COMMIT");
    inTransaction = false;
    if (connectionFailed) throw new Error("bootstrap connection failed");
    return database;
  } finally {
    try {
      if (inTransaction) await client.query("ROLLBACK");
    } catch {
      // Disconnect aborts an open transaction. Never surface driver text.
    }
    try {
      if (locked) {
        await client.query(
          "SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)",
          [migrationLockNamespace, migrationLockKey],
        );
      }
    } catch {
      // Backend exit releases the session advisory lock.
    }
    await endClient(client);
  }
}

async function verifyRuntime(
  connectionString: string,
  database: string,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  let connectionFailed = false;
  client.on("error", () => {
    connectionFailed = true;
  });
  try {
    await client.connect();
    const identity = await client.query<{
      current_role: string;
      session_role: string;
      database_name: string;
    }>(
      `SELECT current_user AS current_role,
              session_user AS session_role,
              current_database() AS database_name`,
    );
    const row = identity.rows[0];
    if (
      !row ||
      row.current_role !== runtimeRole ||
      row.session_role !== runtimeRole ||
      row.database_name !== database
    ) {
      throw new Error("runtime identity mismatch");
    }
    await assertRuntimeRoleSafe(client);
    if (connectionFailed) throw new Error("runtime connection failed");
  } finally {
    await endClient(client);
  }
}

async function runComposeMigration(): Promise<void> {
  const password = requiredPassword(process.env.RUNTIME_DATABASE_PASSWORD);
  const bootstrapUrl = requiredConnectionUrl(
    process.env.DATABASE_BOOTSTRAP_URL,
  );
  const runtimeUrl = requiredConnectionUrl(process.env.DATABASE_URL);
  if (decodedUsername(bootstrapUrl) === runtimeRole) {
    throw new Error("bootstrap username is runtime");
  }
  const directUrl = nonblank(process.env.DATABASE_DIRECT_URL);
  const selectedUrl = directUrl ? requiredConnectionUrl(directUrl) : runtimeUrl;

  // Close the privileged session before verify/migrateDatabase. Those open a
  // second connection and take this same advisory lock; holding it deadlocks.
  const database = await provision(bootstrapUrl, password);
  await verifyRuntime(selectedUrl, database);
  await migrateDatabase({ connectionString: selectedUrl });
}

try {
  await runComposeMigration();
  console.log("Compose database migration completed.");
} catch {
  // URLs, SQL, passwords and driver errors must never reach either stream.
  process.exitCode = 1;
  console.error("Compose database migration failed.");
}
