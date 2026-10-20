// SPDX-License-Identifier: Apache-2.0
// Restores an isolated PostgreSQL backup and checks persisted data plus API readiness.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "../packages/db/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.TEST_DATABASE_URL;
assert.ok(
  source,
  "TEST_DATABASE_URL must identify a populated PostgreSQL source database",
);
const sourceUrl = new URL(source);
const name = `s3_restore_${randomUUID().replaceAll("-", "")}`;
const restoredUrl = new URL(source);
restoredUrl.pathname = `/${name}`;
const admin = createDatabasePool({ connectionString: source, max: 2 });
admin.on("error", (error) => {
  process.stderr.write(`admin pool error: ${error.message}\n`);
});
const tables = [
  { name: "principals", order: "t.id::text" },
  { name: "matches", order: "t.id::text" },
  { name: "match_results", order: "t.match_id::text" },
  {
    name: "career_contributions",
    order: "t.match_id::text, t.principal_id::text",
  },
  { name: "audit_log", order: "t.id::text" },
];
const origin = "http://127.0.0.1:3000";
let created = false,
  child,
  restoredPool;

/**
 * Ends a pool and waits until every removed client socket has emitted its
 * end event. Pool.end() resolves before the sockets finish closing, and
 * dropping the database in that window terminates a still-closing client,
 * which the pool then reports as an unhandled 'error' event (57P01) after
 * the pass line (BL-027). The login-budget fixture drains the same way.
 */
async function settlePool(pool) {
  if (!pool) return;
  const disconnected = [];
  pool.on("remove", (client) => {
    disconnected.push(
      new Promise((resolve) => client.once("end", resolve)),
    );
  });
  await pool.end();
  await Promise.all(disconnected);
}

async function fingerprint(pool, table) {
  const { rows } = await pool.query(
    `SELECT count(*)::text AS count,
            md5(COALESCE(string_agg(md5(to_jsonb(t)::text), chr(10) ORDER BY ${table.order}), '')) AS digest
       FROM next_round.${table.name} t`,
  );
  return { count: BigInt(rows[0].count), digest: rows[0].digest };
}
async function waitForReady(url) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/health/ready`);
      const body = await response.json();
      if (
        response.status === 200 &&
        body.status === "ready" &&
        body.checks.database === "ok" &&
        body.checks.registry === "ok"
      )
        return;
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Restored API did not become ready: ${last}`);
}
function dockerPgTool(tool, databaseUrl, input, maxBuffer) {
  const url = new URL(databaseUrl);
  const major = Number(
    url.searchParams.get("serverVersion") || process.env.PG_MAJOR,
  );
  if (![17, 18].includes(major))
    throw new Error(
      "Set PG_MAJOR=17 or 18 if the source server version cannot be inferred from TEST_DATABASE_URL",
    );
  const image =
    process.env.PG_TOOL_IMAGE ||
    (major === 18 ? "postgres:18.6-alpine" : "postgres:17-alpine");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "host",
      "-e",
      `PGPASSWORD=${decodeURIComponent(url.password)}`,
      image,
      tool,
      "-h",
      process.env.PG_TOOL_HOST || url.hostname,
      "-p",
      url.port || "5432",
      "-U",
      decodeURIComponent(url.username),
      "-d",
      decodeURIComponent(url.pathname.slice(1)),
      ...(tool === "pg_dump"
        ? ["--format=custom", "--no-owner", "--no-acl"]
        : ["--exit-on-error", "--no-owner", "--no-acl"]),
    ],
    { cwd: root, input, maxBuffer },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `${tool} failed in Docker: ${result.stderr?.toString() || result.error?.message || "no diagnostic output"}`,
    );
  return result.stdout;
}
async function pgTool(tool, databaseUrl, input, maxBuffer) {
  const hostTool =
    tool === "pg_dump"
      ? process.env.PG_DUMP_BIN || "pg_dump"
      : process.env.PG_RESTORE_BIN || "pg_restore";
  const args =
    tool === "pg_dump"
      ? ["--format=custom", "--no-owner", "--no-acl", "--dbname", databaseUrl]
      : ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", databaseUrl];
  const result = spawnSync(hostTool, args, { cwd: root, input, maxBuffer });
  if (!result.error && result.status === 0) return result.stdout;
  if (tool === "pg_restore") {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    created = false;
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
  }
  return dockerPgTool(tool, databaseUrl, input, maxBuffer);
}

try {
  const version = await admin.query("SHOW server_version_num");
  const major = Number(String(version.rows[0].server_version_num).slice(0, 2));
  process.env.PG_MAJOR ||= String(major);
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  const dump = await pgTool(
    "pg_dump",
    sourceUrl.href,
    undefined,
    1024 * 1024 * 1024,
  );
  assert.ok(dump?.length, "pg_dump produced a non-empty custom-format archive");
  await pgTool("pg_restore", restoredUrl.href, dump, 1024 * 1024 * 1024);
  restoredPool = createDatabasePool({
    connectionString: restoredUrl.href,
    max: 2,
  });
  restoredPool.on("error", (error) => {
    process.stderr.write(`restored pool error: ${error.message}\n`);
  });
  const ledger = await restoredPool.query(
    "SELECT position FROM next_round.schema_migrations",
  );
  assert.ok(
    ledger.rowCount > 0,
    "The restored migration ledger must contain applied migrations",
  );
  const restoredCounts = {};
  for (const table of tables) {
    const [before, after] = await Promise.all([
      fingerprint(admin, table),
      fingerprint(restoredPool, table),
    ]);
    assert.deepEqual(after, before, `restored data mismatch for ${table.name}`);
    restoredCounts[table.name] = after.count.toString();
  }
  assert.ok(
    Object.values(restoredCounts).some((count) => count !== "0"),
    "The restored source must contain data",
  );
  const serverCode = `import {buildServer} from './apps/api/dist/server.js'; const app=await buildServer({rateLimitMax:10000}); const url=await app.listen({port:0,host:'127.0.0.1'}); process.send({url}); process.on('SIGTERM',()=>void app.close());`;
  child = spawn(process.execPath, ["--input-type=module", "-e", serverCode], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: restoredUrl.href,
      DATABASE_DIRECT_URL: restoredUrl.href,
      APP_ORIGIN: origin,
      SESSION_SECRET: randomBytes(64).toString("hex"),
      NEXT_ROUND_ENABLE_TEST_COUNTER: "true",
      LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const serverUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Restored API process startup timed out")),
      30_000,
    );
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolve(message.url);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Restored API exited before startup (${code})`));
    });
    child.stderr.on("data", (value) => process.stderr.write(value));
  });
  await waitForReady(serverUrl);
  console.log(
    JSON.stringify({
      status: "pass",
      database: name,
      restoredCounts,
      readiness: "ready",
    }),
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exit;
  }
  await settlePool(restoredPool);
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await settlePool(admin);
}
