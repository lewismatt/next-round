// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
// Real compiled API/worker processes against a per-run PostgreSQL database.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "../packages/db/dist/index.js";
import { migrateDatabase } from "../packages/db/dist/migrate.js";
import { hashPassword } from "../packages/platform/dist/auth.js";
import { manifest } from "../games/test-counter/dist/manifest.js";
import {
  HarnessEnvironment,
  setupMultiplayerCounterScenario,
} from "../packages/game-harness/dist/index.js";
import { runIdentityAcceptance } from "./sprint3-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.TEST_DATABASE_URL;
assert.ok(
  source,
  "TEST_DATABASE_URL is required; this runner creates and drops an isolated database",
);
const core = process.argv.includes("--core");
const negative = process.argv.includes("--negative-control");
if (negative && !core) throw new Error("--negative-control requires --core");
const admin = createDatabasePool({ connectionString: source, max: 2 });
const name = `sprint3_${randomUUID().replaceAll("-", "")}`;
const dbUrl = new URL(source);
dbUrl.pathname = `/${name}`;
const sessionSecret = randomBytes(32).toString("hex");
const children = [];
let pool;
let created = false;
let primaryError;
let environment;
let environment2;
let origin;
function launch(code, extra = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl.href,
      DATABASE_DIRECT_URL: dbUrl.href,
      TEST_DATABASE_URL: dbUrl.href,
      APP_ORIGIN: origin,
      SESSION_SECRET: sessionSecret,
      NEXT_ROUND_ENABLE_TEST_COUNTER: "true",
      LOG_LEVEL: "error",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.lines = [];
  child.messages = [];
  child.on("message", (value) => child.messages.push(value));
  child.stdout.on("data", (data) => child.lines.push(data.toString()));
  child.stderr.on("data", (data) => child.lines.push(data.toString()));
  children.push(child);
  return child;
}
function waitMessage(child, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out: ${child.lines.join("")}`)),
      30000,
    );
    const check = (value) => {
      if (value) {
        clearTimeout(timer);
        resolve(value);
      }
    };
    child.on("message", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited ${code}: ${child.lines.join("")}`));
    });
    for (const message of child.messages) check(message);
  });
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(timer);
}
async function seedAccount(label) {
  const id = randomUUID();
  const credentials = {
    username: label,
    password: randomBytes(24).toString("hex"),
  };
  await pool.query(
    "INSERT INTO next_round.principals(id,kind,display_name) VALUES($1,'registered',$2)",
    [id, label],
  );
  await pool.query(
    "INSERT INTO next_round.accounts(principal_id,username,password_hash,role) VALUES($1,$2,$3,'member')",
    [id, label, await hashPassword(credentials.password)],
  );
  return { id, ...credentials };
}
async function until(check, label, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  await migrateDatabase({ connectionString: dbUrl.href });
  pool = createDatabasePool({ connectionString: dbUrl.href, max: 5 });
  const accounts = [];
  for (const username of [
    "s3_host",
    "s3_peer",
    "alice",
    "bob",
    "s3_reset",
    "s3_fill1",
    "s3_fill2",
    "s3_fill3",
    "s3_fill4",
    "s3_fill5",
    "s3_fill6",
  ])
    accounts.push(await seedAccount(username));
  await pool.query(
    "UPDATE next_round.accounts SET role='admin',can_invite_guests=true,can_invite_registrations=true WHERE username='s3_host'",
  );
  await pool.query(
    "UPDATE next_round.accounts SET can_invite_guests=true,can_invite_registrations=true WHERE username IN ('alice','bob')",
  );
  const policy = {
    schemaVersion: 1,
    historyVisibility: "participants",
    statsVisibility: "instance",
    rejoinChat: "full",
    retention: {
      chatDaysAfterFinish: 30,
      privateStateDaysAfterFinish: 30,
      resultDaysAfterFinish: null,
      notificationDays: 30,
    },
  };
  await pool.query(
    "INSERT INTO next_round.instance_policy(version,instance_name,policy,changed_by) VALUES(1,'Sprint 3',$1::jsonb,$2)",
    [JSON.stringify(policy), accounts[0].id],
  );
  await pool.query(
    "INSERT INTO next_round.instance_singleton(id,current_policy_version) VALUES(true,1)",
  );
  const moduleSeed = await pool.connect();
  try {
    await moduleSeed.query("BEGIN");
    await moduleSeed.query(
      "INSERT INTO next_round.modules(id,default_version) VALUES('test-counter','0.1.0')",
    );
    await moduleSeed.query(
      `INSERT INTO next_round.module_versions(module_id,version,manifest,server_hash,client_hash,sdk_contract,state_version,result_version)
      VALUES('test-counter','0.1.0',$1::jsonb,'acceptance-server','acceptance-client','next-round-game/0.1',1,1)`,
      [JSON.stringify(manifest)],
    );
    await moduleSeed.query(
      `INSERT INTO next_round.module_versions(module_id,version,manifest,server_hash,client_hash,sdk_contract,state_version,result_version)
      VALUES('test-counter','0.2.0',$1::jsonb,'acceptance-server-v2','acceptance-client-v2','next-round-game/0.1',1,1)`,
      [JSON.stringify({ ...manifest, version: "0.2.0" })],
    );
    await moduleSeed.query("COMMIT");
  } catch (error) {
    await moduleSeed.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    moduleSeed.release();
  }

  const apiCode = `import {buildServer} from './apps/api/dist/server.js';
    import {GameRegistry} from './packages/platform/dist/index.js';
    import {manifest} from './games/test-counter/dist/manifest.js';
    import {server} from './games/test-counter/dist/server.js';
    const registry=new GameRegistry();
    const baseServer=${
      negative
        ? `{...server,view(ctx,state,viewer){return {...server.view(ctx,state,viewer),myMarker:'DELIBERATE-PRIVATE-VIEW-LEAK'};}}`
        : "{...server}"
    };
    registry.register(manifest,baseServer,{clientRoot:'apps/web/dist/games/test-counter/0.1.0/'});
    registry.register({...manifest,version:'0.2.0'},{...server,migrate({state,settings,result}){if(settings.target===13)throw new Error('acceptance migration rollback');return {state,settings,result};}},
      {clientRoot:'apps/web/dist/games/test-counter/0.1.0/'});
    const app=await buildServer({rateLimitMax:10000,gameRegistry:registry});
    app.addHook('onError',(_request,_reply,error,done)=>{
      process.send({diagnostic:{name:error.name,code:error.code,frames:error.stack?.split('\\n').slice(1,5)}});
      done();
    });
    const url=await app.listen({port:Number(process.env.PORT),host:'127.0.0.1'});
    process.send({url}); process.on('SIGTERM',()=>void app.close());`;
  const [portA, portB] = await Promise.all([reservePort(), reservePort()]);
  const api1 = launch(apiCode, {
    PORT: String(portA),
    APP_ORIGIN: `http://127.0.0.1:${portA}`,
  });
  const api2 = launch(apiCode, {
    PORT: String(portB),
    APP_ORIGIN: `http://127.0.0.1:${portB}`,
  });
  const [one, two] = await Promise.all([
    waitMessage(api1, "API 1 startup"),
    waitMessage(api2, "API 2 startup"),
  ]);
  origin = new URL(one.url).origin;
  const worker = launch("await import('./apps/worker/dist/index.js');");
  const workerPid = worker.pid;
  const provisionRegistered = async ({ username }) =>
    accounts.find((account) => account.username === username);
  environment = new HarnessEnvironment({
    baseUrl: one.url,
    useSystemClock: true,
    timeoutMs: 10000,
    provisionRegistered,
  });
  environment2 = new HarnessEnvironment({
    baseUrl: two.url,
    useSystemClock: true,
    timeoutMs: 10000,
    provisionRegistered,
  });
  // Real production login creates clients independently against both API processes.
  const host = await environment.createRegisteredClient({
    username: accounts[0].username,
    displayName: "host",
  });
  const peer = await environment2.createRegisteredClient({
    username: accounts[1].username,
    displayName: "peer",
  });
  const cases = [];
  const measure = async (name, checks, action) => {
    const start = performance.now();
    await action();
    cases.push({
      name,
      checks,
      elapsedMs: +(performance.now() - start).toFixed(3),
      status: "pass",
    });
  };
  await measure(
    "compiled-api-http-match-lifecycle",
    ["create HTTP 201", "join", "start", "revision-checked action"],
    async () => {
      const match = await host.createMatch(
        "test-counter",
        "group",
        { target: 20, turnSeconds: 60 },
        "instance",
      );
      let receipt = await peer.joinMatch(match.matchId, 0);
      receipt = await host.startMatch(match.matchId, receipt.committedRevision);
      const view = await host.getSnapshot(match.matchId);
      assert.equal(view.revision, receipt.committedRevision);
      const markerHost = view.game.myMarker;
      const peerView = await peer.getSnapshot(match.matchId);
      assert.notEqual(
        markerHost,
        peerView.game.myMarker,
        "consumer-visible private marker must be viewer-specific",
      );
      host.matchId = match.matchId;
      host.revision = receipt.committedRevision;
    },
  );
  if (negative) {
    // Same behavioral assertion as the positive lifecycle case: a valid response with wrong private view must fail.
    const leaked = await host.getSnapshot(host.matchId);
    assert.notEqual(
      leaked.game.myMarker,
      "DELIBERATE-PRIVATE-VIEW-LEAK",
      "private-view leak negative control",
    );
  }
  await host.connectWs();
  await peer.connectWs();
  await measure(
    "real-websocket-private-view-and-reconnect",
    [
      "both API WS sessions connected",
      "WS snapshots are received",
      "viewer-specific private view",
      "reconnect produces fresh WS snapshot",
    ],
    async () => {
      const id = host.matchId;
      host.onSnapshot(id, () => {});
      peer.onSnapshot(id, () => {});
      const before = await peer.getSnapshot(id);
      const wakeup = await peer.act(id, {
        type: "note",
        payload: { text: "live wakeup" },
        expectedRevision: before.revision,
      });
      const [hostWs, peerWs] = await Promise.all([
        until(
          () =>
            host.receivedSnapshots.find(
              (snapshot) =>
                snapshot.id === id &&
                snapshot.revision === wakeup.committedRevision,
            ),
          "host WS snapshot",
        ),
        until(
          () =>
            peer.receivedSnapshots.find(
              (snapshot) =>
                snapshot.id === id &&
                snapshot.revision === wakeup.committedRevision,
            ),
          "peer WS snapshot",
        ),
      ]);
      assert.notEqual(
        hostWs.game.myMarker,
        peerWs.game.myMarker,
        "WS clients must receive distinct private markers",
      );
      host.disconnectWs();
      const missed = await peer.act(id, {
        type: "note",
        payload: { text: "missed while disconnected" },
        expectedRevision: wakeup.committedRevision,
      });
      await host.reconnectWs();
      const resumed = await until(
        () =>
          host.receivedSnapshots.find(
            (snapshot) =>
              snapshot.id === id &&
              snapshot.revision === missed.committedRevision,
          ),
        "reconnect WS snapshot",
      );
      assert.equal(
        resumed.game.myMarker,
        hostWs.game.myMarker,
        "reconnect preserves the caller's private view",
      );
    },
  );
  await measure(
    "retry-and-deadline-retention-with-worker-effect",
    [
      "same command replay preserves committed revision",
      "deadline dueAt/generation retained by note",
      "worker acknowledges durable live invalidation",
    ],
    async () => {
      const before = await host.getSnapshot(host.matchId);
      const deadlineBefore = (
        await pool.query(
          "SELECT key,generation,due_at FROM next_round.match_deadlines WHERE match_id=$1 AND status='pending'",
          [host.matchId],
        )
      ).rows[0];
      assert.ok(deadlineBefore, "started turn must have a persisted deadline");
      const commandId = randomUUID();
      const action = {
        type: "note",
        payload: { text: "acceptance" },
        commandId,
        expectedRevision: before.revision,
      };
      const first = await host.act(host.matchId, action);
      const replay = await host.replayCommand(host.matchId, action);
      assert.equal(replay.committedRevision, first.committedRevision);
      const deadlineAfter = (
        await pool.query(
          "SELECT key,generation,due_at FROM next_round.match_deadlines WHERE match_id=$1 AND status='pending'",
          [host.matchId],
        )
      ).rows[0];
      assert.deepEqual(
        deadlineAfter,
        deadlineBefore,
        "note must retain the original pending deadline identity and dueAt",
      );
      await until(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate'
       AND safe_payload @> $1::jsonb AND delivered_at IS NOT NULL`,
              [
                JSON.stringify({
                  scope: { kind: "match", id: host.matchId },
                  revision: first.committedRevision,
                }),
              ],
            )
          ).rowCount > 0,
        "worker acknowledgement of live invalidation",
      );
    },
  );
  const postgres = (await pool.query("SHOW server_version")).rows[0]
    .server_version;
  const acceptanceEnv = environment;
  const scenario = await setupMultiplayerCounterScenario(acceptanceEnv, {
    target: 10,
    turnSeconds: 60,
  });
  cases.push({
    name: "H1-H2-production-multiplayer-counter-fixture",
    checks: [
      "registered Alice and Bob authenticate through production APIs",
      "real match created, Bob joins, targeted guest invite issued and redeemed",
    ],
    status: "pass",
  });
  const request = async (
    path,
    { method = "GET", body, client, base = one.url, headers = {} } = {},
  ) => {
    const requestHeaders = { "content-type": "application/json", ...headers };
    requestHeaders.origin = new URL(base).origin;
    if (client) {
      requestHeaders.cookie = client.session.cookie;
      if (client.session.csrfToken)
        requestHeaders["x-csrf-token"] = client.session.csrfToken;
    }
    return fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const apiOrigin = new URL(one.url).origin;
  const ctx = {
    pool,
    databaseUrl: dbUrl.href,
    migrationTargetVersion: "0.2.0",
    adminSession: host.session,
    host,
    peer,
    env: acceptanceEnv,
    apiA: { ...one, child: api1 },
    apiB: { ...two, child: api2 },
    request,
    until,
    worker,
    launch,
    stop,
    scenario,
    accounts,
    origin: apiOrigin,
    cases,
    measure,
    assert,
  };
  await runIdentityAcceptance(ctx);
  if (!core) {
    const { runSharedAcceptance } = await import("./sprint3-shared.mjs");
    await runSharedAcceptance(ctx);
  }
  const requirementIds = ["H1", "H2", "H3", "H4", "H5", "H6"];
  if (!core)
    for (const id of requirementIds)
      assert.ok(
        cases.some(
          (test) => test.requirement === id || test.name.startsWith(`${id}:`),
        ),
        `full acceptance is missing required ${id} production scenarios`,
      );
  const output = {
    scenario: "Sprint 3 H1-H6 production acceptance",
    mode: core ? "core-only" : "full",
    postgres,
    processes: { api: [api1.pid, api2.pid], worker: workerPid },
    cases,
    requirements: Object.fromEntries(
      requirementIds.map((id) => [
        id,
        {
          status: cases.some(
            (test) => test.requirement === id || test.name.startsWith(`${id}:`),
          )
            ? "pass"
            : "not-run-core-subset",
          cases: cases
            .filter(
              (test) =>
                test.requirement === id || test.name.startsWith(`${id}:`),
            )
            .map((test) => test.name),
        },
      ]),
    ),
  };
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  primaryError = error;
  console.error(JSON.stringify({ completedCases: cases }));
  for (const child of children)
    console.error(
      `Child ${child.pid} output: ${child.lines.join("").slice(-4000)}`,
    );
  for (const child of children) console.error(JSON.stringify(child.messages.filter(message=>message.diagnostic)));
} finally {
  let cleanupError;
  const cleanup = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupError ??= error;
    }
  };
  await cleanup(async () => {
    environment?.reset();
    environment2?.reset();
  });
  await cleanup(() => Promise.all(children.map(stop)));
  await cleanup(() => pool?.end());
  if (created)
    await cleanup(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`));
  await cleanup(() => admin.end());
  if (cleanupError) {
    if (primaryError)
      console.error(
        `Acceptance cleanup failed after primary error: ${cleanupError.message}`,
      );
    else primaryError = cleanupError;
  }
}
if (primaryError) throw primaryError;
