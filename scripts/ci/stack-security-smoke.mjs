#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Real Compose proof for the internet-hardening deployment.
// Requires --baseline-image, --baseline-ref and --postgres-major=17|18.
// Never prints secrets, full container environments, or credential-bearing logs.

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import https from "node:https";

const root = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://localhost:8443";
const httpOrigin = "http://127.0.0.1:8080";
const runtimeRole = "next_round_runtime";
const bootstrapRole = "next_round";
const databaseName = "next_round";
const expectedCsp =
  "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://localhost:8443; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const limits = {
  api: { memory: 1024 ** 3, nanoCpus: 2_000_000_000, pids: 128 },
  worker: { memory: 512 * 1024 ** 2, nanoCpus: 1_000_000_000, pids: 128 },
  migrate: { memory: 512 * 1024 ** 2, nanoCpus: 1_000_000_000, pids: 128 },
  postgres: { memory: 1024 ** 3, nanoCpus: 2_000_000_000, pids: 256 },
  caddy: { memory: 256 * 1024 ** 2, nanoCpus: 1_000_000_000, pids: 128 },
};
const appServices = ["api", "worker", "migrate"];
const secrets = [];
let selectedPostgresImage = "";
// Shell variables outrank --env-file in Compose. Never adopt operator secrets
// or deployment overrides into this disposable fixture.
const subprocessEnv = { ...process.env };
for (const key of [
  "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD",
  "RUNTIME_DATABASE_PASSWORD", "DATABASE_URL", "DATABASE_DIRECT_URL",
  "SESSION_SECRET", "SETUP_TOKEN", "CADDY_DOMAIN", "CSP_WEBSOCKET_ORIGIN",
  "PROXY_SUBNET", "CADDY_PROXY_IP", "LIVE_RECONCILE_INTERVAL_MS",
  ...Object.keys(limits).flatMap((service) =>
    ["MEM_LIMIT", "CPUS", "PIDS_LIMIT"].map((suffix) => `${service.toUpperCase()}_${suffix}`)),
]) delete subprocessEnv[key];

function progress(message) {
  console.log(`stack-security-smoke: ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function remember(secret) {
  if (secret) secrets.push(secret);
  return secret;
}

function redact(value) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  return text
    .replace(/postgres:\/\/[^\s'"]+/g, "postgres://[redacted]")
    .replace(/__(Host-)?next-round-[a-z-]+=[^;\s]+/g, "[redacted-cookie]");
}

function hexSecret() {
  return remember(randomBytes(32).toString("hex"));
}

function userPassword() {
  return remember(randomBytes(24).toString("base64url"));
}

function sleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

function withTimeout(promise, ms, label) {
  const { promise: timed, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(
    () => reject(new Error(`Timed out waiting for ${label}`)),
    ms,
  );
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
  return timed;
}

function run(
  command,
  args,
  { input, timeout = 120_000, cwd = root, allowFail = false } = {},
) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawn(command, args, {
    cwd, env: subprocessEnv, stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`Timed out running ${command}`));
  }, timeout);
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    const result = {
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
    if (code !== 0 && !allowFail) {
      reject(
        new Error(
          redact(
            `${command} failed (${code}): ${result.stderr || result.stdout}`.slice(
              0,
              600,
            ),
          ),
        ),
      );
      return;
    }
    resolve(result);
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  return promise;
}

function parseArgs(argv) {
  let baselineImage = "";
  let baselineRef = "";
  let postgresMajor = "";
  let keepOnSuccess = false;
  for (const arg of argv) {
    if (arg.startsWith("--baseline-image="))
      baselineImage = arg.slice("--baseline-image=".length);
    else if (arg.startsWith("--baseline-ref="))
      baselineRef = arg.slice("--baseline-ref=".length);
    else if (arg.startsWith("--postgres-major="))
      postgresMajor = arg.slice("--postgres-major=".length);
    else if (arg === "--keep-on-success") keepOnSuccess = true;
    else fail(`Unknown argument ${arg}`);
  }
  check(
    baselineImage && !/[\s'"`\n]/.test(baselineImage),
    "--baseline-image is required",
  );
  check(
    baselineRef && !/[\s'"`\n]/.test(baselineRef),
    "--baseline-ref is required",
  );
  check(
    postgresMajor === "17" || postgresMajor === "18",
    "--postgres-major must be 17 or 18",
  );
  return { baselineImage, baselineRef, postgresMajor, keepOnSuccess };
}

async function imagePresent(name) {
  const result = await run("docker", ["image", "inspect", name], {
    allowFail: true,
  });
  return result.code === 0;
}

function parseCidr(cidr) {
  const [address, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const value = parts.reduce((acc, part) => (acc << 8n) + BigInt(part), 0n);
  return { value, bits };
}

function overlaps(left, right) {
  const a = parseCidr(left);
  const b = parseCidr(right);
  if (!a || !b) return false;
  const bits = Math.min(a.bits, b.bits);
  const mask = bits === 0 ? 0n : (~0n << BigInt(32 - bits)) & 0xffffffffn;
  return (a.value & mask) === (b.value & mask);
}

async function usedSubnets() {
  const used = [];
  const listed = await run("docker", ["network", "ls", "-q"], {
    allowFail: true,
  });
  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length > 0) {
    const inspected = await run("docker", ["network", "inspect", ...ids], {
      allowFail: true,
    });
    if (inspected.code === 0) {
      const networks = JSON.parse(inspected.stdout);
      for (const network of networks) {
        for (const config of network.IPAM?.Config ?? []) {
          if (typeof config.Subnet === "string") used.push(config.Subnet);
        }
      }
    }
  }
  const routes = await run("ip", ["-4", "route"], { allowFail: true });
  if (routes.code === 0) {
    for (const match of routes.stdout.matchAll(
      /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g,
    ))
      used.push(match[0]);
  }
  return used;
}

async function freeProxy() {
  const used = await usedSubnets();
  const candidates = [];
  for (let third = 1; third <= 254; third += 1)
    candidates.push(`172.31.${third}.0/24`);
  for (let third = 1; third <= 254; third += 1)
    candidates.push(`10.201.${third}.0/24`);
  for (const subnet of candidates) {
    if (used.some((existing) => overlaps(subnet, existing))) continue;
    const proxyIp = subnet.replace(/\.0\/24$/, ".10");
    return { subnet, proxyIp };
  }
  fail("No free proxy subnet for a unique Caddy static address");
}

function assertPortFree(port) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = createServer();
  server.once("error", (error) => {
    server.close();
    if (error.code === "EADDRINUSE") {
      reject(
        new Error(
          `127.0.0.1:${port} is occupied; refusing to stop the occupant`,
        ),
      );
      return;
    }
    reject(error);
  });
  server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  return promise;
}

async function occupiedDiagnostic(port) {
  const result = await run("ss", ["-ltnp"], { allowFail: true });
  if (result.code !== 0) return "";
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.includes(`:${port}`));
  return line ? ` Listener: ${line.trim()}` : "";
}

async function requirePortsFree() {
  for (const port of [8080, 8443]) {
    try {
      await assertPortFree(port);
    } catch (error) {
      const detail = await occupiedDiagnostic(port);
      fail(`${error.message}.${detail}`);
    }
  }
}

function yamlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function overrideYaml({
  postgresMajor,
  proxyIp,
  image,
  publish,
  wrongBootstrapUrl,
  postgresImage,
}) {
  const imageBlock = image
    ? `    image: ${image}\n    pull_policy: never\n`
    : "";
  const resolvedPostgresImage =
    postgresMajor === "17"
      ? "postgres:17.11-alpine"
      : postgresImage || selectedPostgresImage;
  const postgresImageLine = resolvedPostgresImage
    ? `    image: ${resolvedPostgresImage}\n`
    : "";
  const pgdata =
    postgresMajor === "17"
      ? "      PGDATA: /var/lib/postgresql/17/docker\n"
      : "";
  const ports = publish
    ? '    ports: !override\n      - "127.0.0.1:8080:80"\n      - "127.0.0.1:8443:443"\n'
    : "    ports: !override []\n";
  const bootstrap = wrongBootstrapUrl
    ? `      DATABASE_BOOTSTRAP_URL: ${yamlQuote(wrongBootstrapUrl)}\n`
    : "";
  return `services:
  postgres:
    ports: !override []
${postgresImageLine}    environment:
${pgdata}      POSTGRES_HOST_AUTH_METHOD: scram-sha-256
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U ${bootstrapRole} -d ${databaseName}"]
      interval: 3s
      timeout: 5s
      retries: 40
      start_period: 20s
  api:
${imageBlock}    environment:
      APP_ORIGIN: ${yamlQuote(origin)}
      TRUST_PROXY: ${yamlQuote(proxyIp)}
  worker:
${imageBlock}    environment:
      DATABASE_DIRECT_URL: ""
  migrate:
${imageBlock}    environment:
${bootstrap}      DATABASE_DIRECT_URL: ""
  caddy:
    environment:
      CADDY_DOMAIN: localhost
      CSP_WEBSOCKET_ORIGIN: wss://localhost:8443
${ports}`;
}

async function writePrivate(file, content) {
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
}

function envFile(values) {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

function composeArgs(stack, extra) {
  return [
    "compose",
    "-p",
    stack.project,
    "--project-directory",
    stack.projectDir,
    "-f",
    stack.composeFile,
    "-f",
    stack.overrideFile,
    "--env-file",
    stack.envFile,
    ...extra,
  ];
}

function compose(stack, extra, options = {}) {
  return run("docker", composeArgs(stack, extra), options);
}

async function containerId(stack, service) {
  const result = await compose(stack, ["ps", "-aq", service], {
    allowFail: true,
  });
  return result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

async function inspect(id, format) {
  const result = await run("docker", ["inspect", "-f", format, id]);
  return result.stdout.trim();
}

async function waitMigrate(stack, label) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const id = await containerId(stack, "migrate");
    if (id) {
      const status = await inspect(id, "{{.State.Status}}");
      if (status === "exited") {
        const code = Number(await inspect(id, "{{.State.ExitCode}}"));
        check(code === 0, `${label}: migrate exited ${code}`);
        progress(`${label}: migrate exited 0`);
        return;
      }
    }
    await sleep(1000);
  }
  fail(`${label}: migrate did not exit 0`);
}

async function psql(stack, sql, user = bootstrapRole) {
  const result = await compose(stack, [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    databaseName,
    "-At",
    "-c",
    sql,
  ]);
  return result.stdout.trim();
}

async function psqlAsRuntime(stack, password, sql) {
  const result = await compose(
    stack,
    [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'IFS= read -r PW && PGPASSWORD="$PW" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U next_round_runtime -d next_round -At -c "$1"',
      "sh",
      sql,
    ],
    { input: `${password}\n`, allowFail: true },
  );
  return result;
}

async function readCaddyRoot(stack) {
  check(
    typeof tls.setDefaultCACertificates === "function",
    "Node tls.setDefaultCACertificates is required; refusing insecure TLS",
  );
  let pem = "";
  await untilOk("Caddy local root", async () => {
    const result = await compose(
      stack,
      [
        "exec",
        "-T",
        "caddy",
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      ],
      { allowFail: true },
    );
    if (result.code !== 0 || !result.stdout.includes("BEGIN CERTIFICATE"))
      return false;
    pem = result.stdout;
    tls.setDefaultCACertificates([pem]);
    return true;
  });
  return pem;
}

async function untilOk(label, checkFn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    try {
      if (await checkFn()) return;
    } catch (error) {
      last = redact(error.message).slice(0, 180);
    }
    await sleep(1000);
  }
  fail(`${label} (${last})`);
}

function policy() {
  return {
    schemaVersion: 1,
    historyVisibility: "participants",
    statsVisibility: "owner",
    rejoinChat: "full",
    retention: {
      chatDaysAfterFinish: 30,
      privateStateDaysAfterFinish: 30,
      resultDaysAfterFinish: null,
      notificationDays: 30,
    },
  };
}

async function loadHarness() {
  const client = await import(
    pathToFile(root, "packages/game-harness/dist/client.js")
  );
  const sessions = await import(
    pathToFile(root, "packages/game-harness/dist/sessions.js")
  );
  check(
    typeof client.HttpSimulatedClient === "function",
    "HttpSimulatedClient is not exported",
  );
  check(
    typeof client.requestData === "function",
    "requestData is not exported",
  );
  check(
    typeof sessions.authenticateRegistered === "function",
    "authenticateRegistered is not exported",
  );
  return { ...client, ...sessions };
}

function pathToFile(base, relative) {
  return new URL(relative, pathToFileURL(`${base}/`)).href;
}

async function loadBrowser() {
  const moduleUrl = new URL("./stack-security-browser.mjs", import.meta.url);
  let browser;
  try {
    browser = await import(moduleUrl);
  } catch (error) {
    fail(
      `Browser helper is required and could not be loaded: ${redact(error.message)}`,
    );
  }
  check(
    typeof browser.setupThroughBrowser === "function",
    "setupThroughBrowser is not exported",
  );
  check(
    typeof browser.exerciseBrowser === "function",
    "exerciseBrowser is not exported",
  );
  return browser;
}

async function apiSetup(harness, credentials, setupToken, instanceName) {
  await harness.requestData(
    { baseUrl: origin, origin, timeoutMs: 60_000 },
    undefined,
    "/setup",
    {
      setupToken,
      commandId: randomUUID(),
      instanceName,
      username: credentials.username,
      password: credentials.password,
      displayName: credentials.displayName,
      policy: policy(),
    },
  );
}

async function login(harness, credentials) {
  const options = { baseUrl: origin, origin, timeoutMs: 60_000 };
  const session = await harness.authenticateRegistered(options, {
    username: credentials.username,
    password: credentials.password,
  });
  const client = new harness.HttpSimulatedClient(session, options);
  return { options, session, client };
}

async function importDocument(harness, options, session, gameId, file) {
  const document = JSON.parse(await readFile(file, "utf8"));
  const { data } = await harness.requestData(
    options,
    session,
    `/admin/games/${gameId}/import`,
    {
      commandId: randomUUID(),
      document,
    },
  );
  check(
    typeof data?.resourceId === "string" && data.resourceId,
    `${gameId} import did not return a resource id`,
  );
  return data.resourceId;
}

async function createStarted(harness, options, session, client, spec) {
  const { data } = await harness.requestData(options, session, "/matches", {
    commandId: randomUUID(),
    moduleId: spec.moduleId,
    mode: "solo",
    settings: spec.settings,
    visibility: "invite",
    ...(spec.resourceId ? { resourceId: spec.resourceId } : {}),
  });
  check(
    typeof data?.matchId === "string" && data.matchId,
    `${spec.moduleId} create did not return a match id`,
  );
  await client.startMatch(data.matchId, 0);
  const snapshot = await client.getSnapshot(data.matchId);
  check(
    snapshot?.id === data.matchId && snapshot.phase === "active",
    `${spec.moduleId} snapshot is not an active private match`,
  );
  return data.matchId;
}

async function populateFixtures(harness, credentials) {
  const { options, session, client } = await login(harness, credentials);
  const crosswordResource = await importDocument(
    harness,
    options,
    session,
    "crossword",
    path.join(root, "games/crossword/content/warm-up.json"),
  );
  const triviaResource = await importDocument(
    harness,
    options,
    session,
    "trivia",
    path.join(root, "games/trivia/content/starter.json"),
  );
  const matches = {
    crossword: await createStarted(harness, options, session, client, {
      moduleId: "crossword",
      resourceId: crosswordResource,
      settings: {
        preset: "solo_casual",
        wrongGuessesPerTurn: null,
        correctWordsPerTurn: null,
        turnSeconds: null,
      },
    }),
    trivia: await createStarted(harness, options, session, client, {
      moduleId: "trivia",
      resourceId: triviaResource,
      settings: { rounds: 1, secondsPerRound: 300 },
    }),
    cipher: await createStarted(harness, options, session, client, {
      moduleId: "cipher",
      settings: { preset: "standard", turnSeconds: null },
    }),
  };
  client.disconnectWs();
  return { matches, session };
}

async function identityRows(stack) {
  return {
    ledger: await psql(
      stack,
      "SELECT position::text || '|' || version || '|' || checksum || '|' || journal_timestamp::text FROM next_round.schema_migrations ORDER BY position",
    ),
    accounts: await psql(
      stack,
      "SELECT username || '|' || principal_id::text FROM next_round.accounts ORDER BY username",
    ),
    matches: await psql(
      stack,
      "SELECT id::text || '|' || module_id || '|' || phase FROM next_round.matches ORDER BY module_id, id::text",
    ),
  };
}

async function proveRole(stack, password, label) {
  const flags = await psql(
    stack,
    "SELECT rolsuper::text || ',' || rolcreatedb::text || ',' || rolcreaterole::text || ',' || rolreplication::text || ',' || rolbypassrls::text || ',' || rolcanlogin::text FROM pg_roles WHERE rolname = 'next_round_runtime'",
  );
  check(
    flags === "false,false,false,false,false,true",
    `${label}: runtime role flags are ${flags || "missing"}`,
  );
  const members = await psql(
    stack,
    "SELECT count(*) FROM pg_auth_members m JOIN pg_roles a ON a.oid = m.roleid JOIN pg_roles b ON b.oid = m.member WHERE a.rolname = 'next_round_runtime' OR b.rolname = 'next_round_runtime'",
  );
  check(members === "0", `${label}: runtime role has memberships`);
  const owners = await psql(
    stack,
    "SELECT nspname || '=' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname IN ('next_round','pgboss') ORDER BY 1",
  );
  check(
    owners === "next_round=next_round_runtime\npgboss=next_round_runtime",
    `${label}: schema owners are not the runtime role`,
  );
  const connected = await psqlAsRuntime(
    stack,
    password,
    "SELECT current_user || ',' || session_user",
  );
  check(
    connected.code === 0 &&
      connected.stdout.trim() === `${runtimeRole},${runtimeRole}`,
    `${label}: runtime password login failed`,
  );
  const createRole = await psqlAsRuntime(
    stack,
    password,
    "CREATE ROLE stack_smoke_denied NOLOGIN",
  );
  check(createRole.code !== 0, `${label}: runtime role created a role`);
  const setRole = await psqlAsRuntime(
    stack,
    password,
    `SET ROLE ${bootstrapRole}`,
  );
  check(setRole.code !== 0, `${label}: runtime role set role to bootstrap`);
  progress(`${label}: runtime ownership, flags and denied privileges ok`);
}

async function proveBaselineOwnership(stack, alreadyRuntime) {
  if (alreadyRuntime) {
    const owners = await psql(
      stack,
      "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'next_round'",
    );
    check(
      owners === runtimeRole,
      "hardened baseline schema was not already runtime-owned",
    );
    progress("baseline: already runtime-owned; cutover must preserve that");
    return;
  }
  const superuser = await psql(
    stack,
    `SELECT rolsuper::text FROM pg_roles WHERE rolname = '${bootstrapRole}'`,
  );
  check(
    superuser === "true",
    "old baseline bootstrap role was not a superuser",
  );
  const owners = await psql(
    stack,
    "SELECT string_agg(pg_get_userbyid(nspowner), ',' ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('next_round','pgboss')",
  );
  check(
    owners === `${bootstrapRole},${bootstrapRole}`,
    `old baseline schemas were owned by ${owners || "nobody"}`,
  );
  progress("baseline: old-format superuser ownership recorded");
}

function envMap(raw) {
  const map = new Map();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq > 0) map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return map;
}

async function proveEnvAbsence(stack, password, bootstrapPassword, label) {
  for (const service of ["api", "worker"]) {
    const id = await containerId(stack, service);
    check(id, `${label}: ${service} container is missing`);
    const raw = JSON.parse(await inspect(id, "{{json .Config.Env}}"));
    const env = envMap(raw);
    check(
      !env.has("POSTGRES_PASSWORD") && !env.has("DATABASE_BOOTSTRAP_URL"),
      `${label}: ${service} has bootstrap credentials`,
    );
    const url = env.get("DATABASE_URL") ?? "";
    check(
      !url.includes(bootstrapPassword),
      `${label}: ${service} database URL contains the bootstrap password`,
    );
    const parsed = new URL(url);
    check(
      parsed.username === runtimeRole &&
        decodeURIComponent(parsed.password) === password,
      `${label}: ${service} is not using the runtime role URL`,
    );
    check(
      !raw.join("\n").includes(bootstrapPassword),
      `${label}: ${service} environment contains the bootstrap password`,
    );
  }
  progress(`${label}: bootstrap credentials absent from api and worker`);
}

async function proveWorker(stack, harness, credentials, matchId, label) {
  await untilOk(`${label}: worker heartbeat`, async () => {
    const count = await psql(
      stack,
      "SELECT count(*) FROM next_round.worker_heartbeats WHERE last_seen_at > clock_timestamp() - interval '60 seconds'",
    );
    return count !== "0";
  });
  check(/^[0-9a-f-]{36}$/.test(matchId), "invalid fixture match id");
  const revision = Number(await psql(
    stack,
    `SELECT chat_revision FROM next_round.matches WHERE id='${matchId}'`,
  )) + 1;
  const { options, session } = await login(harness, credentials);
  await harness.requestData(options, session, `/matches/${matchId}/chat`, {
    commandId: randomUUID(),
    text: "security-smoke worker probe",
  });
  await untilOk(`${label}: worker outbox delivery`, async () => {
    const delivered = await psql(
      stack,
      `SELECT delivered_at IS NOT NULL FROM next_round.outbox WHERE dedupe_key='chat:${matchId}:${revision}'`,
    );
    return delivered === "t";
  });
  progress(`${label}: worker processed an outbox row`);
}

async function proveContainment(stack, label) {
  for (const [service, limit] of Object.entries(limits)) {
    const id = await containerId(stack, service);
    check(id, `${label}: ${service} is not running`);
    const host = JSON.parse(await inspect(id, "{{json .HostConfig}}"));
    check(
      host.Memory === limit.memory,
      `${label}: ${service} memory limit is not the containment default`,
    );
    check(
      host.NanoCpus === limit.nanoCpus,
      `${label}: ${service} cpu limit is not the containment default`,
    );
    check(
      host.PidsLimit === limit.pids,
      `${label}: ${service} pid limit is not the containment default`,
    );
    check(
      host.LogConfig?.Type === "json-file",
      `${label}: ${service} log driver is not json-file`,
    );
    check(
      host.LogConfig?.Config?.["max-size"] === "10m" &&
        host.LogConfig?.Config?.["max-file"] === "3",
      `${label}: ${service} log rotation is wrong`,
    );
    const security = (host.SecurityOpt ?? []).join(" ");
    check(
      /no-new-privileges[:=]true/.test(security),
      `${label}: ${service} lacks no-new-privileges`,
    );
    if (appServices.includes(service)) {
      check(
        host.ReadonlyRootfs === true,
        `${label}: ${service} root is writable`,
      );
      check(
        (host.CapDrop ?? []).some((cap) => cap.toUpperCase() === "ALL"),
        `${label}: ${service} did not drop all capabilities`,
      );
      const user = await inspect(id, "{{.Config.User}}");
      check(
        user === "node" || user === "node:node" || user.startsWith("1000"),
        `${label}: ${service} is not the node user`,
      );
      const tmp = host.Tmpfs?.["/tmp"] ?? "";
      check(
        tmp.includes("noexec") && tmp.includes("nosuid"),
        `${label}: ${service} tmpfs is not noexec`,
      );
    }
  }
  const denied = await compose(
    stack,
    [
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      "require('fs').writeFileSync('/app/stack-smoke-write','x')",
    ],
    { allowFail: true },
  );
  check(
    denied.code !== 0 && /EROFS/.test(denied.stderr + denied.stdout),
    `${label}: app-root write did not fail EROFS`,
  );
  await compose(stack, [
    "exec",
    "-T",
    "api",
    "node",
    "-e",
    "require('fs').writeFileSync('/tmp/stack-smoke-write','x'); require('fs').unlinkSync('/tmp/stack-smoke-write')",
  ]);
  progress(`${label}: containment limits and filesystem writes ok`);
}

async function proveNetwork(stack, proxyIp, label) {
  const published = [];
  for (const service of ["postgres", "migrate", "api", "worker", "caddy"]) {
    const id = await containerId(stack, service);
    if (!id) continue;
    const ports = JSON.parse(
      await inspect(id, "{{json .NetworkSettings.Ports}}"),
    );
    for (const [containerPort, bindings] of Object.entries(ports ?? {})) {
      for (const binding of bindings ?? []) {
        published.push(
          `${service} ${binding.HostIp}:${binding.HostPort}->${containerPort}`,
        );
      }
    }
  }
  check(published.length === 2, `${label}: unexpected published ports`);
  check(
    published.every(
      (entry) =>
        entry.startsWith("caddy 127.0.0.1:8080->80") ||
        entry.startsWith("caddy 127.0.0.1:8443->443"),
    ),
    `${label}: a non-loopback or non-Caddy port is published`,
  );
  const caddyId = await containerId(stack, "caddy");
  const networks = Object.keys(
    JSON.parse(await inspect(caddyId, "{{json .NetworkSettings.Networks}}")),
  );
  check(
    networks.length === 1 && networks[0].endsWith("_proxy"),
    `${label}: Caddy is not confined to the proxy network`,
  );
  const address = JSON.parse(
    await inspect(caddyId, "{{json .NetworkSettings.Networks}}"),
  );
  check(
    address[networks[0]].IPAddress === proxyIp,
    `${label}: Caddy static address does not match TRUST_PROXY`,
  );
  const internal = await run("docker", [
    "network",
    "inspect",
    `${stack.project}_default`,
    "-f",
    "{{.Internal}}",
  ]);
  check(
    internal.stdout.trim() === "true",
    `${label}: backend network is not internal`,
  );
  const postgresId = await containerId(stack, "postgres");
  const postgresNetworks = JSON.parse(
    await inspect(postgresId, "{{json .NetworkSettings.Networks}}"),
  );
  check(
    Object.keys(postgresNetworks).length === 1 &&
      postgresNetworks[`${stack.project}_default`],
    `${label}: PostgreSQL is attached outside the backend network`,
  );
  const databaseIp = postgresNetworks[`${stack.project}_default`].IPAddress;
  // Same network namespace reachability as Caddy, with a real TCP client and
  // an API positive control; unsupported BusyBox nc flags cannot fake a pass.
  const tcpProof = await run("docker", [
    "run", "--rm", "--network", networks[0],
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "next-round-app:local", "node", "--input-type=module", "-e",
    `import net from 'node:net';
     async function connects(host, port) {
       const {promise, resolve} = Promise.withResolvers();
       const socket = net.connect({host,port});
       const finish = value => { socket.destroy(); resolve(value); };
       socket.once('connect',()=>finish(true));
       socket.once('error',()=>finish(false));
       socket.setTimeout(3000,()=>finish(false));
       return promise;
     }
     if (!(await connects('api',3000))) process.exit(2);
     if (await connects(${JSON.stringify(databaseIp)},5432)) process.exit(3);
     console.log('API reachable; backend PostgreSQL TCP connection denied.');`,
  ], { allowFail: true, timeout: 20_000 });
  check(tcpProof.code === 0, `${label}: proxy-network TCP isolation proof failed (${tcpProof.code})`);
  progress(`${label}: published ports and Caddy isolation ok`);
}

async function cookieProof(harness, credentials, label) {
  const before = await countSessionsSafe();
  const { response } = await harness.requestData(
    { baseUrl: origin, origin, timeoutMs: 60_000 },
    undefined,
    "/auth/login",
    { username: credentials.username, password: credentials.password },
  );
  const cookies = response.headers.getSetCookie();
  for (const name of ["__Host-next-round-session", "__Host-next-round-csrf"]) {
    const header = cookies.find((cookie) => cookie.startsWith(`${name}=`));
    check(header, `${label}: ${name} was not set`);
    const lower = header.toLowerCase();
    check(
      lower.includes("secure") && lower.includes("httponly"),
      `${label}: ${name} is missing Secure or HttpOnly`,
    );
    check(
      /samesite=lax/.test(lower) && /path=\//.test(lower),
      `${label}: ${name} is missing SameSite=Lax or Path=/`,
    );
    check(
      !/(^|;)\s*domain=/i.test(header),
      `${label}: ${name} has a Domain attribute`,
    );
  }
  check(before !== null, `${label}: could not read session count`);
  progress(`${label}: __Host- cookie attributes ok`);
}

async function countQuery(stack, sql) {
  return psql(stack, sql);
}

let activeStack = null;
async function countSessionsSafe() {
  if (!activeStack) return null;
  return countQuery(activeStack, "SELECT count(*) FROM next_round.sessions");
}

async function proveDenials(stack, harness, credentials, matchId, label) {
  activeStack = stack;
  const principalsBefore = await psql(
    stack,
    "SELECT count(*) FROM next_round.principals",
  );
  const { session, client } = await login(harness, credentials);
  const sessionsBefore = await psql(stack, "SELECT count(*) FROM next_round.sessions");
  const chatsBefore = await psql(stack, "SELECT count(*) FROM next_round.chat_messages");
  const beforeSnapshot = await client.getSnapshot(matchId);
  const wrongOrigin = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    redirect: "manual",
  });
  check(
    wrongOrigin.status === 403,
    `${label}: wrong Origin was not denied`,
  );
  const missingCsrf = await fetch(`${origin}/api/v1/matches/${matchId}/chat`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: session.cookie,
    },
    body: JSON.stringify({ commandId: randomUUID(), text: "missing csrf" }),
    redirect: "manual",
  });
  check(missingCsrf.status === 403, `${label}: missing CSRF was not denied`);
  const wrongCsrf = await fetch(`${origin}/api/v1/matches/${matchId}/chat`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: session.cookie,
      "x-csrf-token": "wrong-csrf-token",
    },
    body: JSON.stringify({ commandId: randomUUID(), text: "wrong csrf" }),
    redirect: "manual",
  });
  check(wrongCsrf.status === 403, `${label}: wrong CSRF was not denied`);
  const afterSnapshot = await client.getSnapshot(matchId);
  check(
    afterSnapshot.revision === beforeSnapshot.revision,
    `${label}: denied mutation changed match revision`,
  );
  const invitation = await fetch(`${origin}/api/v1/guest-invitations/redeem`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      token: randomBytes(32).toString("hex"),
      displayName: "Invalid Guest",
      commandId: randomUUID(),
    }),
    redirect: "manual",
  });
  check(
    invitation.status >= 400 && invitation.status < 500,
    `${label}: invalid invitation was not denied`,
  );
  const budgetSql = "SELECT encode(key_hash, 'hex') || ':' || sum(count)::text FROM next_round.rate_buckets GROUP BY key_hash ORDER BY 1";
  const parseBudgets = (text) => new Map(text.split("\n").filter(Boolean).map((row) => {
    const [key, count] = row.split(":");
    return [key, Number(count)];
  }));
  const budgetsBefore = parseBudgets(await psql(stack, budgetSql));
  const forgedUser = `forged_${randomBytes(4).toString("hex")}`;
  const forgedHeaders = {
    origin,
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.50",
    "x-real-ip": "203.0.113.50",
    forwarded: "for=203.0.113.50",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
  };
  const forged = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: forgedHeaders,
    body: JSON.stringify({ username: forgedUser, password: userPassword() }),
    redirect: "manual",
  });
  check(
    forged.status === 401,
    `${label}: forged forwarding login was not denied`,
  );
  const plain = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: forgedUser, password: userPassword() }),
    redirect: "manual",
  });
  check(
    plain.status === 401,
    `${label}: comparison login was not denied`,
  );
  const budgetsAfter = parseBudgets(await psql(stack, budgetSql));
  const delta = (key) => (budgetsAfter.get(key) ?? 0) - (budgetsBefore.get(key) ?? 0);
  const changedKeys = [...budgetsAfter.keys()].filter((key) => delta(key) !== 0);
  const loginKey = (namespace, value) =>
    createHash("sha256").update(`login:${namespace}:${value}`).digest("hex");
  check(
    delta(loginKey("username", forgedUser)) === 2 &&
      delta(loginKey("source-ip", "203.0.113.50")) === 0 &&
      changedKeys.length === 2 && changedKeys.every((key) => delta(key) === 2),
    `${label}: forged forwarding did not share the real source's login budget`,
  );
  check(
    (await psql(stack, "SELECT count(*) FROM next_round.principals")) ===
      principalsBefore,
    `${label}: denial created a principal`,
  );
  check(
    (await psql(stack, "SELECT count(*) FROM next_round.sessions")) === sessionsBefore &&
      (await psql(stack, "SELECT count(*) FROM next_round.chat_messages")) === chatsBefore,
    `${label}: denied requests changed sessions or chat messages`,
  );
  const forgedBody = await forged.text();
  check(
    !forgedBody.includes("203.0.113.50"),
    `${label}: forged address was reflected`,
  );
  client.disconnectWs();
  progress(
    `${label}: origin, CSRF, invitation and forged forwarding denials ok`,
  );
}

function rawHeaders(response) {
  const names = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2)
    names.push(response.rawHeaders[i].toLowerCase());
  return names;
}

function httpsGet(ca, urlPath) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const request = https.request(
    {
      host: "127.0.0.1",
      port: 8443,
      servername: "localhost",
      path: urlPath,
      method: "GET",
      ca,
      headers: { host: "localhost" },
      timeout: 20_000,
    },
    (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          raw: rawHeaders(response),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    },
  );
  request.on("error", reject);
  request.end();
  return promise;
}

async function proveCsp(ca, label) {
  const html = await httpsGet(ca, "/");
  check(html.status === 200, `${label}: HTML was not served`);
  const script = html.body.match(/src="(\/[^"]+\.js)"/)?.[1];
  check(script, `${label}: HTML did not reference a same-origin script`);
  const js = await httpsGet(ca, script);
  const api = await httpsGet(ca, "/api/v1/setup");
  for (const [name, response] of [
    ["HTML", html],
    ["JS", js],
    ["API", api],
  ]) {
    const count = response.raw.filter(
      (header) => header === "content-security-policy",
    ).length;
    check(count === 1, `${label}: ${name} CSP header count is ${count}`);
    check(
      response.headers["content-security-policy"] === expectedCsp,
      `${label}: ${name} CSP value differs`,
    );
  }
  progress(`${label}: enforced CSP appears once on HTML, JS and API`);
  return script;
}

function stalledRequest(ca, payload, limitMs, label) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const started = performance.now();
  let completed = false;
  let deadline;
  const socket = tls.connect(
    {
      host: "127.0.0.1",
      port: 8443,
      servername: "localhost",
      ca,
    },
    () => {
      socket.write(payload);
    },
  );
  // Drain error responses so TLS end/close is observed rather than paused on
  // unread response bytes after the server has already timed out the body.
  socket.resume();
  const finish = (error) => {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    const elapsed = performance.now() - started;
    socket.destroy();
    if (error) reject(error);
    else resolve(elapsed);
  };
  socket.once("close", () => finish());
  socket.once("end", () => finish());
  socket.once("error", () => finish());
  deadline = setTimeout(
    () => finish(new Error(`${label} stayed open past ${limitMs}ms`)),
    limitMs,
  );
  return promise;
}

async function proveSlow(ca, label) {
  const headerElapsed = await stalledRequest(
    ca,
    "GET / HTTP/1.1\r\nHost: localhost\r\n",
    18_000,
    `${label} slow headers`,
  );
  check(
    headerElapsed >= 8_000 && headerElapsed <= 18_000,
    `${label}: slow headers closed at ${Math.round(headerElapsed)}ms`,
  );
  const bodyElapsed = await stalledRequest(
    ca,
    "POST /api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{",
    45_000,
    `${label} slow body`,
  );
  check(
    bodyElapsed >= 24_000 && bodyElapsed <= 45_000,
    `${label}: slow body closed at ${Math.round(bodyElapsed)}ms`,
  );
  progress(`${label}: slow header and body were disconnected within limits`);
}

async function openLive(session, ca, matchId) {
  const { WebSocket } = createRequire(
    path.join(root, "packages/game-harness/package.json"),
  )("ws");
  const agent = new https.Agent({
    ca,
    servername: "localhost",
    rejectUnauthorized: true,
  });
  const socket = new WebSocket(
    origin.replace("https:", "wss:") + "/api/v1/live",
    "next-round.live.v1",
    {
      agent,
      headers: { origin, cookie: session.cookie },
      handshakeTimeout: 20_000,
    },
  );
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(
    () => reject(new Error("WebSocket open timed out")),
    20_000,
  );
  socket.once("open", () => {
    clearTimeout(timer);
    resolve(socket);
  });
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  const opened = await promise;
  const requestId = randomUUID();
  const subscribed = waitForFrame(
    opened,
    (frame) => frame.type === "subscribed" && frame.requestId === requestId,
    20_000,
  );
  opened.send(
    JSON.stringify({
      type: "subscribe",
      requestId,
      scope: { kind: "chat", id: matchId },
    }),
  );
  await subscribed;
  return opened;
}

function waitForFrame(socket, predicate, timeoutMs) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => {
    socket.off("message", onMessage);
    reject(new Error("WebSocket frame timed out"));
  }, timeoutMs);
  const onMessage = (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!predicate(frame)) return;
    clearTimeout(timer);
    socket.off("message", onMessage);
    resolve(frame);
  };
  socket.on("message", onMessage);
  return promise;
}

function waitForClose(socket, timeoutMs) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(
    () => reject(new Error("WebSocket close timed out")),
    timeoutMs,
  );
  socket.once("close", (code, reason) => {
    clearTimeout(timer);
    resolve({ code, reason: reason.toString() });
  });
  return promise;
}

async function proveWebSocket(stack, harness, credentials, matchId, ca, label) {
  const apiId = await containerId(stack, "api");
  const pidBefore = await inspect(apiId, "{{.State.Pid}}");
  const restartsBefore = await inspect(apiId, "{{.RestartCount}}");
  const { session } = await login(harness, credentials);
  const survivor = await openLive(session, ca, matchId);
  await sleep(65_000);
  check(
    survivor.readyState === survivor.OPEN,
    `${label}: valid WebSocket did not stay open beyond 60s`,
  );
  const pingId = randomUUID();
  const pong = waitForFrame(
    survivor,
    (frame) => frame.type === "pong" && frame.requestId === pingId,
    10_000,
  );
  survivor.send(JSON.stringify({ type: "ping", requestId: pingId }));
  await pong;
  const abuser = await openLive(session, ca, matchId);
  const closed = waitForClose(abuser, 10_000);
  for (let i = 0; i < 50; i += 1)
    abuser.send(JSON.stringify({ type: "ping", requestId: randomUUID() }));
  const close = await closed;
  check(
    close.code === 1008 && close.reason.includes("Message rate exceeded"),
    `${label}: abuse closed ${close.code} ${close.reason}`,
  );
  check(
    survivor.readyState === survivor.OPEN,
    `${label}: abuse closed the peer socket`,
  );
  const invalidated = waitForFrame(
    survivor,
    (frame) => frame.type === "invalidate" && frame.scope?.id === matchId,
    20_000,
  );
  const { options } = await login(harness, credentials);
  await harness.requestData(options, session, `/matches/${matchId}/chat`, {
    commandId: randomUUID(),
    text: "security-smoke invalidation",
  });
  await invalidated;
  const pidAfter = await inspect(apiId, "{{.State.Pid}}");
  const restartsAfter = await inspect(apiId, "{{.RestartCount}}");
  check(
    pidAfter === pidBefore && restartsAfter === restartsBefore,
    `${label}: API process restarted during WebSocket rejection`,
  );
  survivor.close();
  progress(
    `${label}: WebSocket survived 60s, abuse closed 1008, peer received invalidation`,
  );
}

async function exercise(browser, credentials, matches, artifactDir, label) {
  const result = await withTimeout(
    browser.exerciseBrowser({
      origin,
      credentials,
      matches,
      artifactDir,
    }),
    480_000,
    `${label} browser exercise`,
  );
  check(result?.ok === true, `${label}: browser exercise did not succeed`);
  progress(`${label}: browser exercise ok`);
}

async function proveHardened(
  stack,
  harness,
  browser,
  credentials,
  matches,
  artifactDir,
  ca,
  label,
) {
  activeStack = stack;
  await proveRole(stack, stack.runtimePassword, label);
  await proveEnvAbsence(
    stack,
    stack.runtimePassword,
    stack.bootstrapPassword,
    label,
  );
  await proveWorker(stack, harness, credentials, matches.crossword, label);
  await proveContainment(stack, label);
  await proveNetwork(stack, stack.proxyIp, label);
  await cookieProof(harness, credentials, label);
  await proveDenials(stack, harness, credentials, matches.crossword, label);
  await exercise(browser, credentials, matches, artifactDir, label);
  await proveCsp(ca, label);
  const deferredFailures = [];
  try {
    await proveSlow(ca, label);
  } catch (error) {
    deferredFailures.push(`slow-client disconnect: ${error.message}`);
    progress(`${label}: slow-client disconnect failed; retaining failure and continuing`);
  }
  try {
    await proveWebSocket(
      stack,
      harness,
      credentials,
      matches.crossword,
      ca,
      label,
    );
  } catch (error) {
    deferredFailures.push(`WebSocket stability/abuse: ${error.message}`);
    progress(`${label}: WebSocket proof failed; retaining failure and continuing`);
  }
  const anonymous = await fetch(
    `${origin}/api/v1/matches/${matches.crossword}`,
    { redirect: "manual" },
  );
  check(
    anonymous.status === 401,
    `${label}: anonymous match read was not denied`,
  );
  if (deferredFailures.length)
    throw new Error(`${label}: ${deferredFailures.join("; ")}`);
  progress(`${label}: hardened acceptance complete`);
}

async function makeStack({
  project,
  projectDir,
  composeFile,
  overrideFile,
  envFilePath,
  proxyIp,
  runtimePassword,
  bootstrapPassword,
}) {
  return {
    project,
    projectDir,
    composeFile,
    overrideFile,
    envFile: envFilePath,
    proxyIp,
    runtimePassword,
    bootstrapPassword,
  };
}

async function up(stack, services = []) {
  await compose(stack, ["up", "-d", "--no-build", ...services], {
    timeout: 300_000,
  });
}

async function down(stack, volumes) {
  await compose(
    stack,
    ["down", "--remove-orphans", ...(volumes ? ["-v"] : [])],
    { timeout: 180_000 },
  );
}

async function writeStackFiles(
  dir,
  {
    postgresMajor,
    proxyIp,
    image,
    publish,
    secrets: values,
    wrongBootstrapUrl,
  },
) {
  const overrideFile = path.join(dir, "override.yml");
  const envPath = path.join(dir, "stack.env");
  await writePrivate(
    overrideFile,
    overrideYaml({
      postgresMajor,
      proxyIp,
      image,
      publish,
      wrongBootstrapUrl,
    }),
  );
  await writePrivate(
    envPath,
    envFile({
      POSTGRES_DB: databaseName,
      POSTGRES_USER: bootstrapRole,
      POSTGRES_PASSWORD: values.bootstrapPassword,
      RUNTIME_DATABASE_PASSWORD: values.runtimePassword,
      SESSION_SECRET: values.sessionSecret,
      SETUP_TOKEN: values.setupToken,
      CADDY_DOMAIN: "localhost",
      PROXY_SUBNET: values.subnet,
      CADDY_PROXY_IP: proxyIp,
      DATABASE_DIRECT_URL: "",
    }),
  );
  return { overrideFile, envPath };
}

function newSecrets(subnet) {
  return {
    bootstrapPassword: hexSecret(),
    runtimePassword: hexSecret(),
    sessionSecret: hexSecret(),
    setupToken: hexSecret(),
    subnet,
  };
}

async function credentialProbes(postgresMajor, proxy, hardenedCompose) {
  const ownedStacks = [];
  const privateDirectories = [];
  let probeError;
  try {
  progress("credential probes: missing runtime password");
  const missingDir = await mkdtemp(path.join(tmpdir(), "nr-sec-missing-"));
  await chmod(missingDir, 0o700);
  privateDirectories.push(missingDir);
  const missingProject = `nrsec${randomBytes(4).toString("hex")}`;
  const missingSecrets = newSecrets(proxy.subnet);
  const missingFiles = await writeStackFiles(missingDir, {
    postgresMajor,
    proxyIp: proxy.proxyIp,
    publish: false,
    secrets: { ...missingSecrets, runtimePassword: "" },
  });
  const missingEnv = missingFiles.envPath;
  const rawEnv = await readFile(missingEnv, "utf8");
  await writePrivate(
    missingEnv,
    rawEnv.replace(/^RUNTIME_DATABASE_PASSWORD=.*\n/m, ""),
  );
  const missingStack = await makeStack({
    project: missingProject,
    projectDir: path.join(root, "deploy"),
    composeFile: hardenedCompose,
    overrideFile: missingFiles.overrideFile,
    envFilePath: missingEnv,
    proxyIp: proxy.proxyIp,
    runtimePassword: "",
    bootstrapPassword: missingSecrets.bootstrapPassword,
  });
  const cleanupEnv = path.join(missingDir, "cleanup.env");
  await writePrivate(
    cleanupEnv,
    rawEnv.replace(/^RUNTIME_DATABASE_PASSWORD=.*$/m,
      `RUNTIME_DATABASE_PASSWORD=${missingSecrets.runtimePassword}`),
  );
  ownedStacks.push({ ...missingStack, envFile: cleanupEnv });
  const missing = await compose(missingStack, ["up", "-d", "--no-build"], {
    allowFail: true,
    timeout: 60_000,
  });
  check(missing.code !== 0, "missing runtime password started the stack");
  check(
    /RUNTIME_DATABASE_PASSWORD/.test(missing.stderr + missing.stdout),
    "missing runtime password was not a configuration failure",
  );
  const leftover = await run(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${missingProject}`,
    ],
    { allowFail: true },
  );
  check(
    leftover.stdout.trim() === "",
    "missing runtime password created a container",
  );
  progress("credential probes: missing runtime password rejected");

  const wrongProxy = await freeProxy();
  const wrongDir = await mkdtemp(path.join(tmpdir(), "nr-sec-wrong-"));
  await chmod(wrongDir, 0o700);
  privateDirectories.push(wrongDir);
  const wrongProject = `nrsec${randomBytes(4).toString("hex")}`;
  const wrongSecrets = newSecrets(wrongProxy.subnet);
  const wrongPassword = hexSecret();
  const wrongUrl = `postgres://${bootstrapRole}:${wrongPassword}@postgres:5432/${databaseName}`;
  remember(wrongUrl);
  const wrongFiles = await writeStackFiles(wrongDir, {
    postgresMajor,
    proxyIp: wrongProxy.proxyIp,
    publish: false,
    secrets: wrongSecrets,
    wrongBootstrapUrl: wrongUrl,
  });
  const wrongStack = await makeStack({
    project: wrongProject,
    projectDir: path.join(root, "deploy"),
    composeFile: hardenedCompose,
    overrideFile: wrongFiles.overrideFile,
    envFilePath: wrongFiles.envPath,
    proxyIp: wrongProxy.proxyIp,
    runtimePassword: wrongSecrets.runtimePassword,
    bootstrapPassword: wrongSecrets.bootstrapPassword,
  });
  ownedStacks.push(wrongStack);
  progress("credential probes: wrong bootstrap password");
  const wrongUp = await compose(
    wrongStack,
    ["up", "-d", "--no-build", "migrate"],
    { allowFail: true, timeout: 300_000 },
  );
  let migrateId = "";
  let migrateCode = wrongUp.code;
  const migrateDeadline = Date.now() + 300_000;
  while (Date.now() < migrateDeadline) {
    migrateId = await containerId(wrongStack, "migrate");
    if (
      migrateId &&
      (await inspect(migrateId, "{{.State.Status}}")) === "exited"
    ) {
      migrateCode = Number(await inspect(migrateId, "{{.State.ExitCode}}"));
      break;
    }
    await sleep(1000);
  }
  check(
    Boolean(migrateId) && migrateCode !== 0,
    "wrong bootstrap password did not fail migrate",
  );
  const role = await psql(
    wrongStack,
    "SELECT count(*) FROM pg_roles WHERE rolname = 'next_round_runtime'",
  );
  check(role === "0", "wrong bootstrap password left a runtime role");
  const apiId = await containerId(wrongStack, "api");
  check(!apiId, "wrong bootstrap password started API");
  await down(wrongStack, true);
  progress("credential probes: wrong bootstrap password rejected");

  progress("credential probes: wrong runtime password");
  const runtimeProxy = await freeProxy();
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nr-sec-runtime-"));
  await chmod(runtimeDir, 0o700);
  privateDirectories.push(runtimeDir);
  const runtimeProject = `nrsec${randomBytes(4).toString("hex")}`;
  const runtimeSecrets = newSecrets(runtimeProxy.subnet);
  const runtimeFiles = await writeStackFiles(runtimeDir, {
    postgresMajor,
    proxyIp: runtimeProxy.proxyIp,
    publish: false,
    secrets: runtimeSecrets,
  });
  const runtimeStack = await makeStack({
    project: runtimeProject,
    projectDir: path.join(root, "deploy"),
    composeFile: hardenedCompose,
    overrideFile: runtimeFiles.overrideFile,
    envFilePath: runtimeFiles.envPath,
    proxyIp: runtimeProxy.proxyIp,
    runtimePassword: runtimeSecrets.runtimePassword,
    bootstrapPassword: runtimeSecrets.bootstrapPassword,
  });
  ownedStacks.push(runtimeStack);
  await compose(runtimeStack, ["up", "-d", "--no-build", "migrate"], {
    timeout: 300_000,
  });
  await waitMigrate(runtimeStack, "wrong-runtime setup");
  const badPassword = hexSecret();
  const badEnv = (await readFile(runtimeFiles.envPath, "utf8")).replace(
    /^RUNTIME_DATABASE_PASSWORD=.*$/m,
    `RUNTIME_DATABASE_PASSWORD=${badPassword}`,
  );
  await writePrivate(runtimeFiles.envPath, badEnv);
  runtimeStack.runtimePassword = badPassword;
  await compose(runtimeStack, ["up", "-d", "--no-build", "--no-deps", "api"], {
    allowFail: true,
    timeout: 120_000,
  });
  await untilOk(
    "wrong runtime API failure",
    async () => {
      const id = await containerId(runtimeStack, "api");
      if (!id) return false;
      const restarts = Number(await inspect(id, "{{.RestartCount}}"));
      const status = await inspect(id, "{{.State.Status}}");
      return restarts >= 1 || status === "exited";
    },
    60_000,
  );
  const badApi = await containerId(runtimeStack, "api");
  check(badApi, "wrong runtime password did not create the API container");
  const apiEnv = envMap(
    JSON.parse(await inspect(badApi, "{{json .Config.Env}}")),
  );
  check(
    !apiEnv.has("POSTGRES_PASSWORD"),
    "wrong runtime password fell back to bootstrap credentials in the API environment",
  );
  const apiUrl = new URL(apiEnv.get("DATABASE_URL") ?? "postgres://invalid");
  check(
    apiUrl.username === runtimeRole,
    "wrong runtime password changed the API database user",
  );
  const listening = await run("docker", ["logs", badApi], { allowFail: true });
  check(
    !(listening.stdout + listening.stderr).includes("listening on"),
    "wrong runtime password became a healthy API",
  );
  const stillSafe = await psql(
    runtimeStack,
    "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'next_round_runtime'",
  );
  check(
    stillSafe === "false",
    "wrong runtime password promoted the runtime role",
  );
  await down(runtimeStack, true);
  progress(
    "credential probes: wrong runtime password rejected without privileged fallback",
  );
  } catch (error) {
    probeError = error;
  } finally {
    let cleanupFailed = false;
    for (const stack of ownedStacks) {
      try { await down(stack, true); }
      catch {
        cleanupFailed = true;
        console.error(`stack-security-smoke: cleanup failed for ${stack.project}`);
      }
    }
    if (cleanupFailed) {
      console.error(`stack-security-smoke: recovery directories: ${privateDirectories.join(", ")}`);
      probeError ??= new Error("Credential fixture cleanup failed");
    } else {
      for (const directory of privateDirectories)
        await rm(directory, { recursive: true, force: true });
    }
  }
  if (probeError) throw probeError;
}

async function waitHttps(label) {
  await untilOk(label, async () => {
    const response = await fetch(`${origin}/api/v1/setup`, {
      redirect: "manual",
    });
    return response.status === 200;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  check(
    await imagePresent(options.baselineImage),
    `Baseline image ${options.baselineImage} is not present; refusing to build it`,
  );
  check(
    await imagePresent("next-round-app:local"),
    "Hardened image next-round-app:local is not present; refusing to build it",
  );
  if (
    options.postgresMajor === "17" &&
    !(await imagePresent("postgres:17.11-alpine"))
  ) {
    progress("pulling approved postgres:17.11-alpine test image");
    await run("docker", ["pull", "postgres:17.11-alpine"], {
      timeout: 300_000,
    });
  }
  const sha = (
    await run("git", [
      "rev-parse",
      "--verify",
      `${options.baselineRef}^{commit}`,
    ])
  ).stdout.trim();
  check(/^[0-9a-f]{40}$/.test(sha), "baseline ref did not resolve to a commit");
  const browser = await loadBrowser();
  const harness = await loadHarness();
  const privateRoot = await mkdtemp(path.join(tmpdir(), "nr-stack-security-"));
  await chmod(privateRoot, 0o700);
  const baselineCompose = path.join(privateRoot, "baseline-compose.yml");
  const baselineCaddy = path.join(privateRoot, "Caddyfile");
  await writePrivate(
    baselineCompose,
    (await run("git", ["show", `${sha}:deploy/docker-compose.yml`])).stdout,
  );
  await writePrivate(
    baselineCaddy,
    (await run("git", ["show", `${sha}:deploy/Caddyfile`])).stdout,
  );
  const baselineText = await readFile(baselineCompose, "utf8");
  const alreadyRuntime = baselineText.includes(runtimeRole);
  const hardenedCompose = path.join(root, "deploy/docker-compose.yml");
  const hardenedPin =
    (await readFile(hardenedCompose, "utf8")).match(
      /image:\s*(postgres:18\S+)/,
    )?.[1] ?? "";
  check(
    options.postgresMajor === "17" || hardenedPin,
    "hardened compose has no postgres 18 image pin",
  );
  selectedPostgresImage = options.postgresMajor === "18" ? hardenedPin : "";
  const stacks = [];
  let kept = null;
  const acceptanceFailures = [];
  let primaryError;
  try {
    await requirePortsFree();
    const probeProxy = await freeProxy();
    await credentialProbes(options.postgresMajor, probeProxy, hardenedCompose);

    const credentials = {
      username: "smoke_admin",
      password: userPassword(),
      displayName: "Smoke Admin",
    };
    const instanceName = "Security Smoke";

    progress(`fresh hardened stack, postgres ${options.postgresMajor}`);
    await requirePortsFree();
    const freshProxy = await freeProxy();
    const freshSecrets = newSecrets(freshProxy.subnet);
    const freshDir = path.join(privateRoot, "fresh");
    await rm(freshDir, { recursive: true, force: true });
    await writePrivate(path.join(privateRoot, ".keep"), "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(freshDir, { recursive: true, mode: 0o700 });
    const freshFiles = await writeStackFiles(freshDir, {
      postgresMajor: options.postgresMajor,
      proxyIp: freshProxy.proxyIp,
      publish: true,
      secrets: freshSecrets,
    });
    const freshArtifact = path.join(freshDir, "browser");
    await mkdir(freshArtifact, { recursive: true, mode: 0o700 });
    const fresh = await makeStack({
      project: `nrsec${randomBytes(4).toString("hex")}`,
      projectDir: path.join(root, "deploy"),
      composeFile: hardenedCompose,
      overrideFile: freshFiles.overrideFile,
      envFilePath: freshFiles.envPath,
      proxyIp: freshProxy.proxyIp,
      runtimePassword: freshSecrets.runtimePassword,
      bootstrapPassword: freshSecrets.bootstrapPassword,
    });
    stacks.push(fresh);
    await up(fresh);
    await waitMigrate(fresh, "fresh");
    const freshCa = await readCaddyRoot(fresh);
    await waitHttps("fresh API");
    const setupState = await fetch(`${origin}/api/v1/setup`, {
      redirect: "manual",
    });
    const setupBody = await setupState.json();
    check(
      setupBody?.data?.configured === false,
      "fresh stack was already configured",
    );
    const setupResult = await withTimeout(
      browser.setupThroughBrowser({
        origin,
        setupToken: freshSecrets.setupToken,
        credentials,
        instanceName,
        artifactDir: freshArtifact,
      }),
      480_000,
      "fresh browser setup",
    );
    check(setupResult?.ok === true, "fresh browser setup did not succeed");
    progress("fresh: browser setup ok");
    const configured = await fetch(`${origin}/api/v1/setup`, {
      redirect: "manual",
    });
    const configuredBody = await configured.json();
    check(
      configuredBody?.data?.configured === true,
      "browser setup left the instance unconfigured",
    );
    const freshFixtures = await populateFixtures(harness, credentials);
    try {
      await proveHardened(
        fresh,
        harness,
        browser,
        credentials,
        freshFixtures.matches,
        freshArtifact,
        freshCa,
        "fresh",
      );
    } catch (error) {
      acceptanceFailures.push(error.message);
      progress(`fresh: retained security acceptance failure: ${error.message}`);
    }
    await down(fresh, true);

    progress(
      `baseline volume upgrade, postgres ${options.postgresMajor}, ref ${sha.slice(0, 12)}`,
    );
    await requirePortsFree();
    const upgradeProxy = await freeProxy();
    const upgradeSecrets = newSecrets(upgradeProxy.subnet);
    const upgradeDir = path.join(privateRoot, "upgrade");
    await mkdir(upgradeDir, { recursive: true, mode: 0o700 });
    const baselineFiles = await writeStackFiles(upgradeDir, {
      postgresMajor: options.postgresMajor,
      proxyIp: upgradeProxy.proxyIp,
      image: options.baselineImage,
      publish: true,
      secrets: upgradeSecrets,
    });
    const baselineStack = await makeStack({
      project: `nrsec${randomBytes(4).toString("hex")}`,
      projectDir: privateRoot,
      composeFile: baselineCompose,
      overrideFile: baselineFiles.overrideFile,
      envFilePath: baselineFiles.envPath,
      proxyIp: upgradeProxy.proxyIp,
      runtimePassword: upgradeSecrets.runtimePassword,
      bootstrapPassword: upgradeSecrets.bootstrapPassword,
    });
    stacks.push(baselineStack);
    await up(baselineStack);
    await waitMigrate(baselineStack, "baseline");
    await readCaddyRoot(baselineStack);
    await waitHttps("baseline API");
    await apiSetup(
      harness,
      credentials,
      upgradeSecrets.setupToken,
      instanceName,
    );
    const baselineFixtures = await populateFixtures(harness, credentials);
    await proveBaselineOwnership(baselineStack, alreadyRuntime);
    const before = await identityRows(baselineStack);
    progress("baseline: fixtures populated; stopping writers");
    await compose(baselineStack, ["stop", "api", "worker", "caddy"]);
    await down(baselineStack, false);
    const hardenedFiles = await writeStackFiles(upgradeDir, {
      postgresMajor: options.postgresMajor,
      proxyIp: upgradeProxy.proxyIp,
      publish: true,
      secrets: upgradeSecrets,
    });
    const upgraded = await makeStack({
      project: baselineStack.project,
      projectDir: path.join(root, "deploy"),
      composeFile: hardenedCompose,
      overrideFile: hardenedFiles.overrideFile,
      envFilePath: hardenedFiles.envPath,
      proxyIp: upgradeProxy.proxyIp,
      runtimePassword: upgradeSecrets.runtimePassword,
      bootstrapPassword: upgradeSecrets.bootstrapPassword,
    });
    stacks.push(upgraded);
    await up(upgraded);
    await waitMigrate(upgraded, "upgrade");
    const upgradeCa = await readCaddyRoot(upgraded);
    await waitHttps("upgraded API");
    const after = await identityRows(upgraded);
    check(
      after.ledger === before.ledger,
      "upgrade changed the migration ledger",
    );
    check(
      after.accounts === before.accounts,
      "upgrade changed fixture accounts",
    );
    const preservedIds = before.matches
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split("|")[0])
      .sort();
    const survivingIds = after.matches
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split("|")[0]);
    check(
      preservedIds.every((id) => survivingIds.includes(id)),
      "upgrade lost a fixture match",
    );
    const { client } = await login(harness, credentials);
    let browserMatches = { ...baselineFixtures.matches };
    let replaceForBrowser = false;
    for (const [game, matchId] of Object.entries(baselineFixtures.matches)) {
      const snapshot = await client.getSnapshot(matchId);
      check(snapshot?.id === matchId, `upgrade lost the ${game} snapshot`);
      if (snapshot.phase !== "active") replaceForBrowser = true;
    }
    client.disconnectWs();
    if (replaceForBrowser) {
      progress(
        "upgrade: a preserved match is no longer active; starting a replacement for the browser",
      );
      browserMatches = (await populateFixtures(harness, credentials)).matches;
    }
    progress("upgrade: fixture accounts, matches and ledger preserved");
    const upgradeArtifact = path.join(upgradeDir, "browser");
    await mkdir(upgradeArtifact, { recursive: true, mode: 0o700 });
    try {
      await proveHardened(
        upgraded,
        harness,
        browser,
        credentials,
        browserMatches,
        upgradeArtifact,
        upgradeCa,
        "upgrade",
      );
    } catch (error) {
      acceptanceFailures.push(error.message);
      progress(`upgrade: retained security acceptance failure: ${error.message}`);
    }
    if (acceptanceFailures.length)
      throw new Error(`Security acceptance blocked: ${acceptanceFailures.join(" | ")}`);
    kept = upgraded;
    if (options.keepOnSuccess) {
      const metadata = path.join(privateRoot, "keep.json");
      await writePrivate(
        metadata,
        JSON.stringify(
          {
            project: upgraded.project,
            origin,
            httpOrigin,
            artifactDir: upgradeArtifact,
            freshArtifact,
            postgresMajor: Number(options.postgresMajor),
            baselineRef: sha,
            baselineImage: options.baselineImage,
            keptScenario: "upgrade",
            matches: browserMatches,
          },
          null,
          2,
        ) + "\n",
      );
      progress(`kept upgrade stack; metadata ${metadata}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const preserve = options.keepOnSuccess && !primaryError && kept;
    let cleanupFailed = false;
    for (const stack of stacks) {
      if (preserve && stack.project === kept.project) continue;
      try {
        await down(stack, true);
      } catch (error) {
        cleanupFailed = true;
        primaryError ??= error;
        console.error(`stack-security-smoke: cleanup failed for ${stack.project}`);
      }
    }
    if (!preserve && !cleanupFailed)
      await rm(privateRoot, { recursive: true, force: true });
    if (cleanupFailed)
      console.error(`stack-security-smoke: retained recovery configuration in ${privateRoot}`);
  }
  if (primaryError) {
    console.error(
      `stack-security-smoke: ${redact(primaryError.stack || primaryError.message)}`,
    );
    process.exitCode = 1;
  } else {
    progress(`acceptance complete for postgres ${options.postgresMajor}`);
  }
}

await main();
