// SPDX-License-Identifier: Apache-2.0
// Real compiled API/worker processes. Faults exist only in this isolated database.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "../packages/db/dist/index.js";
import { migrateDatabase } from "../packages/db/dist/migrate.js";
import { generateOpaqueSessionToken, generateCsrfToken, SESSION_DEV_COOKIE_NAME } from "../packages/platform/dist/auth.js";
import { manifest } from "../games/test-counter/dist/manifest.js";

const require = createRequire(new URL("../packages/game-harness/package.json", import.meta.url));
const WebSocket = require("ws");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.TEST_DATABASE_URL;
assert.ok(source, "TEST_DATABASE_URL is required; the runner creates and drops its own database");
const admin = createDatabasePool({ connectionString: source, max: 2 });
const name = `sprint2_${randomUUID().replaceAll("-", "")}`;
const role = `${name}_listen`;
const password = randomBytes(24).toString("hex");
const dbUrl = new URL(source);
dbUrl.pathname = `/${name}`;
const directUrl = new URL(dbUrl);
directUrl.username = role;
directUrl.password = password;
const origin = "http://127.0.0.1:3000";
const children = [];
const sockets = [];
const sweepSamples = [];
let pool;
let databaseCreated = false;
let roleCreated = false;

async function until(check, label, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
function launch(code, extraEnv = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: dbUrl.href, DATABASE_DIRECT_URL: directUrl.href,
      APP_ORIGIN: origin, SESSION_SECRET: randomBytes(32).toString("hex"),
      NEXT_ROUND_ENABLE_TEST_COUNTER: "true", LIVE_RECONCILE_INTERVAL_MS: "10000", LOG_LEVEL: "info", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.lines = [];
  child.messages = [];
  child.on("message", message => child.messages.push(message));
  let partial = "";
  child.stdout.on("data", data => {
    partial += data.toString();
    const lines = partial.split("\n"); partial = lines.pop();
    for (const line of lines) {
      child.lines.push(line);
      try {
        const entry = JSON.parse(line);
        if (entry.msg === "Live reconciliation sweep") sweepSamples.push({ pid: child.pid, ...entry });
      } catch { /* Worker startup output is deliberately plain text. */ }
    }
  });
  child.stderr.on("data", data => child.lines.push(data.toString()));
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited; clearTimeout(timer);
}
async function api() {
  const child = launch(`import {buildServer} from './apps/api/dist/server.js';
    import {defaultGameRegistry} from './packages/platform/dist/index.js';
    import {manifest} from './games/test-counter/dist/manifest.js';
    import {server} from './games/test-counter/dist/server.js';
    import {fileURLToPath} from 'node:url';
    const app=await buildServer({rateLimitMax:10000});
    process.on('message',message=>{
      if(message.type!=='install-v02') return;
      defaultGameRegistry.register({...manifest,version:'0.2.0'},{
        ...server,view(...args){return {...server.view(...args),myNote:'renderer-v0.2.0'};}
      },{clientRoot:fileURLToPath(new URL('./apps/web/dist/games/test-counter/0.1.0/',import.meta.url)),isDefault:true});
      process.send({installed:'0.2.0'});
    });
    process.on('SIGTERM',()=>void app.close().then(()=>process.exit(0)));
    const url=await app.listen({port:0,host:'127.0.0.1'}); process.send({url});`);
  await until(() => {
    if (child.exitCode !== null) throw new Error(child.lines.join("\n"));
    return child.messages[0];
  }, "API listening");
  return { child, url: child.messages[0].url };
}
async function worker() {
  const child = launch(`await import('./apps/worker/dist/index.js');`);
  await until(() => {
    if (child.exitCode !== null) throw new Error(child.lines.join("\n"));
    return child.lines.some(line => line.includes("Background worker running"));
  }, "worker startup drain");
  return child;
}
async function session(label) {
  const id = randomUUID();
  const token = generateOpaqueSessionToken();
  const csrf = generateCsrfToken();
  await pool.query("INSERT INTO next_round.principals(id,kind,display_name) VALUES($1,'registered',$2)", [id, label]);
  await pool.query("INSERT INTO next_round.accounts(principal_id,username,password_hash,role) VALUES($1,$2,'unused-acceptance-password','member')", [id, label]);
  await pool.query(`INSERT INTO next_round.sessions(id,principal_id,token_hash,csrf_hash,auth_epoch,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,$4,0,now()+interval '1 day',now()+interval '1 day')`, [randomUUID(), id, token.tokenHash, csrf.csrfHash]);
  return { id, cookie: `${SESSION_DEV_COOKIE_NAME}=${token.rawToken}`, csrf: csrf.rawToken };
}
async function request(node, identity, route, body, expected = 200) {
  const response = await fetch(`${node.url}/api/v1${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: identity.cookie, origin, ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": identity.csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = await response.json();
  assert.equal(response.status, expected, JSON.stringify(envelope));
  return envelope.data;
}
async function connect(node, identity, matchId, permitted = true) {
  const socket = new WebSocket(`${node.url.replace("http:", "ws:")}/api/v1/live`, "next-round.live.v1", { headers: { Origin: origin, Cookie: identity.cookie } });
  sockets.push(socket);
  const client = { socket, frames: [], snapshots: [], errors: [], refreshes: [] };
  socket.on("message", bytes => {
    const frame = JSON.parse(bytes.toString());
    client.frames.push({ ...frame, at: performance.now() });
    if (frame.type === "invalidate") {
      assert.ok(Object.keys(frame).every(key => ["type", "scope", "revision"].includes(key)));
      assert.deepEqual(Object.keys(frame.scope).sort(), ["id", "kind"]);
    }
    if ((frame.type === "invalidate" || frame.type === "subscribed") && frame.scope?.kind === "match") {
      const refresh = request(node, identity, `/matches/${matchId}`).then(snapshot => {
        client.snapshots.push({ snapshot, at: performance.now() });
      }).catch(error => client.errors.push(error));
      client.refreshes.push(refresh);
    }
  });
  socket.on("error", error => client.errors.push(error));
  await until(() => client.frames.find(frame => frame.type === "hello"), "live hello");
  socket.send(JSON.stringify({ type: "subscribe", requestId: randomUUID(), scope: { kind: "match", id: matchId }, knownRevision: 0 }));
  if (permitted) {
    await until(() => client.snapshots.length, "subscribed authoritative snapshot");
  } else {
    const denied = await until(() => client.frames.find(frame => frame.type === "error"), "unauthorized scope denied");
    assert.equal(denied.code, "NOT_FOUND");
    assert.equal(client.snapshots.length, 0);
  }
  return client;
}
async function refreshed(client, revision) {
  return until(() => {
    if (client.errors.length) throw client.errors[0];
    return client.snapshots.find(entry => entry.snapshot.revision >= revision);
  }, `automatic refresh revision ${revision}`, 25000);
}
async function listeners() {
  return (await pool.query("SELECT pid,application_name FROM pg_stat_activity WHERE datname=$1 AND usename=$2 ORDER BY pid", [name, role])).rows;
}

try {
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); databaseCreated = true;
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`); roleCreated = true;
  await migrateDatabase({ connectionString: dbUrl.href });
  pool = createDatabasePool({ connectionString: dbUrl.href, max: 5 });
  const a = await session("sprint2_a"); const b = await session("sprint2_b");
  const outsider = await session("sprint2_outsider");
  const policy = { schemaVersion: 1, historyVisibility: "participants", statsVisibility: "owner", rejoinChat: "full", retention: { chatDaysAfterFinish: 30, privateStateDaysAfterFinish: 30, resultDaysAfterFinish: null, notificationDays: 30 } };
  const seed = await pool.connect();
  try {
    await seed.query("BEGIN");
    await seed.query("INSERT INTO next_round.instance_policy(version,instance_name,policy,changed_by) VALUES(1,'Sprint 2',$1::jsonb,$2)", [JSON.stringify(policy), a.id]);
    await seed.query("INSERT INTO next_round.instance_singleton(id,current_policy_version) VALUES(true,1)");
    await seed.query("INSERT INTO next_round.modules(id,default_version) VALUES('test-counter','0.1.0')");
    await seed.query(`INSERT INTO next_round.module_versions(module_id,version,manifest,server_hash,client_hash,sdk_contract,state_version,result_version)
      VALUES('test-counter','0.1.0',$1::jsonb,'fixture-server','fixture-client','next-round-game/0.1',1,1)`, [JSON.stringify(manifest)]);
    await seed.query("COMMIT");
  } catch (error) { await seed.query("ROLLBACK"); throw error; } finally { seed.release(); }
  // Start the regular worker first so its next outbox sweep precedes the API
  // recovery sweeps. Measure a running worker, not its startup drain.
  const w = await worker();
  const n1 = await api(); const n2 = await api();
  assert.notEqual(n1.child.pid, n2.child.pid);
  const privateProbe = `sprint2-private-token-${randomUUID()}`;
  const loggedBefore = n1.child.lines.length;
  await request(n1, a, `/live?token=${privateProbe}`, undefined, 400);
  await until(() => n1.child.lines.length > loggedBefore, "rejected handshake log");
  assert.ok(!n1.child.lines.join("\n").includes(privateProbe), "query credentials must not enter request logs");
  const created = await request(n1, a, "/matches", { commandId: randomUUID(), moduleId: "test-counter", mode: "group", settings: { target: 20, turnSeconds: null }, visibility: "instance" }, 201);
  const matchId = created.matchId;
  let receipt = await request(n2, b, `/matches/${matchId}/join`, { commandId: randomUUID(), expectedRevision: 0 });
  receipt = await request(n1, a, `/matches/${matchId}/start`, { commandId: randomUUID(), expectedRevision: receipt.committedRevision });
  const c1 = await connect(n1, a, matchId); const c2 = await connect(n2, b, matchId);
  assert.notEqual(c1.snapshots[0].snapshot.game.myMarker, c2.snapshots[0].snapshot.game.myMarker);
  const listenerBefore = await until(async () => { const rows = await listeners(); return rows.length === 2 && rows; }, "two dedicated listeners");
  const before = await request(n1, a, `/matches/${matchId}`);
  const tNormal = performance.now();
  receipt = await request(n1, a, `/matches/${matchId}/actions`, { commandId: randomUUID(), expectedRevision: before.revision, type: "add", payload: { amount: 1 } });
  const normal = await Promise.all([refreshed(c1, receipt.committedRevision), refreshed(c2, receipt.committedRevision)]);
  assert.ok(c2.frames.some(frame => frame.type === "invalidate" && frame.revision === receipt.committedRevision));
  for (const entry of normal) assert.equal(entry.snapshot.game.count, 1);
  await until(async () => (await pool.query(
    `SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate'
       AND safe_payload @> $1::jsonb AND delivered_at IS NOT NULL`,
    [JSON.stringify({ scope: { kind: "match", id: matchId }, revision: receipt.committedRevision })],
  )).rowCount > 0, "regular worker acknowledges the normal wakeup");
  await stop(w);
  // Test-only trigger drops precisely the live wakeup while retaining durable state/revisions.
  await pool.query(`CREATE FUNCTION next_round.sprint2_drop_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.topic='live.invalidate' THEN NEW.delivered_at=clock_timestamp(); END IF; RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER sprint2_drop_wakeup BEFORE INSERT ON next_round.outbox FOR EACH ROW EXECUTE FUNCTION next_round.sprint2_drop_wakeup()");
  const tMissed = performance.now();
  const missedStartedAt = Date.now();
  receipt = await request(n2, b, `/matches/${matchId}/actions`, { commandId: randomUUID(), expectedRevision: receipt.committedRevision, type: "add", payload: { amount: 1 } });
  const missed = await Promise.all([refreshed(c1, receipt.committedRevision), refreshed(c2, receipt.committedRevision)]);
  // Frames are emitted before the sweep COMMIT and its log entry. On a loaded
  // runner that entry can therefore be timestamped after both refetches finish.
  // Give log collection its own CI budget; the snapshot timestamps above remain
  // the recovery measurement, and no further mutations run until collection ends.
  const periodicSweepSamples = await until(() => {
    // BL-048: report, per node, only the FIRST emitting sweep at or after
    // the missed change. That sweep is by construction the recovering
    // cycle for its node; later emitting samples belong to later cycles
    // and must not dilute the provenance of the reported set.
    const firstEmittingByPid = new Map();
    for (const sample of sweepSamples) {
      if (sample.time < missedStartedAt || sample.invalidationsEmitted <= 0) continue;
      const current = firstEmittingByPid.get(sample.pid);
      if (!current || sample.time < current.time) {
        firstEmittingByPid.set(sample.pid, sample);
      }
    }
    const samples = [n1.child.pid, n2.child.pid].map(pid =>
      firstEmittingByPid.get(pid));
    return samples.every(Boolean) && samples;
  }, "periodic sweep measurements on both nodes", 60000);
  const listenerAfter = await listeners();
  assert.deepEqual(listenerAfter, listenerBefore, "missed wakeup recovery must retain both listener sessions");
  for (const entry of missed) assert.equal(entry.snapshot.game.count, 2);
  // Disable new listener logins, sever both sessions, commit, then permit recovery.
  await admin.query(`ALTER ROLE "${role}" NOLOGIN`);
  for (const listener of listenerAfter) await pool.query("SELECT pg_terminate_backend($1)", [listener.pid]);
  await until(async () => (await listeners()).length === 0, "listener disconnect");
  const tRecovery = performance.now();
  receipt = await request(n1, a, `/matches/${matchId}/actions`, { commandId: randomUUID(), expectedRevision: receipt.committedRevision, type: "add", payload: { amount: 1 } });
  await admin.query(`ALTER ROLE "${role}" LOGIN`);
  const recovered = await Promise.all([refreshed(c1, receipt.committedRevision), refreshed(c2, receipt.committedRevision)]);
  const listenerRecovered = await until(async () => { const rows = await listeners(); return rows.length === 2 && rows; }, "listener reconnection");
  for (const listener of listenerRecovered) assert.ok(!listenerBefore.some(old => old.pid === listener.pid));
  for (const entry of recovered) assert.equal(entry.snapshot.game.count, 3);
  assert.equal(c1.socket.readyState, WebSocket.OPEN); assert.equal(c2.socket.readyState, WebSocket.OPEN);
  c1.socket.terminate();
  const reconnected = await connect(n1, a, matchId);
  assert.equal(reconnected.snapshots[0].snapshot.revision, receipt.committedRevision);
  assert.equal(reconnected.snapshots[0].snapshot.game.count, 3);
  // Unsubscribe/Home means no leave command; the durable membership remains active.
  c2.socket.send(JSON.stringify({ type: "unsubscribe", requestId: randomUUID(), scope: { kind: "match", id: matchId } }));
  const homeBarrier = randomUUID();
  c2.socket.send(JSON.stringify({ type: "ping", requestId: homeBarrier }));
  await until(() => c2.frames.some(frame => frame.type === "pong" && frame.requestId === homeBarrier), "Home unsubscribe processed");
  const membership = await pool.query("SELECT status FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2", [matchId, b.id]);
  assert.equal(membership.rows[0].status, "active");
  // Resubscribe, then explicit leave must revoke both active HTTP view and live scope.
  c2.socket.send(JSON.stringify({ type: "subscribe", requestId: randomUUID(), scope: { kind: "match", id: matchId }, knownRevision: receipt.committedRevision }));
  await until(() => c2.frames.filter(frame => frame.type === "subscribed").length === 2, "resubscription");
  await Promise.all(c2.refreshes);
  await request(n2, b, `/matches/${matchId}/leave`, { commandId: randomUUID(), expectedRevision: receipt.committedRevision });
  await request(n2, b, `/matches/${matchId}`, undefined, 404);
  await until(() => c2.frames.some(frame => frame.type === "access_revoked"), "leave revokes live access", 15000);
  await request(n1, outsider, `/matches/${matchId}`, undefined, 404);
  await connect(n1, outsider, matchId, false);
  await until(() => [n1.child.pid, n2.child.pid].every(pid =>
    sweepSamples.some(sample => sample.pid === pid && sample.matchCount > 0 && sample.queryCost.queries > 0)),
  "measured subscribed sweep query cost on both API nodes", 15000);
  // Install a distinguishable second renderer in each real API process.
  for (const node of [n1, n2]) {
    node.child.send({ type: "install-v02" });
    await until(() => node.child.messages.some(message => message.installed === "0.2.0"), "install second module version");
  }
  await pool.query(`INSERT INTO next_round.module_versions(module_id,version,manifest,server_hash,client_hash,sdk_contract,state_version,result_version)
    VALUES('test-counter','0.2.0',$1::jsonb,'fixture-server-v02','fixture-client-v02','next-round-game/0.1',1,1)`, [JSON.stringify({ ...manifest, version: "0.2.0" })]);
  await pool.query("UPDATE next_round.accounts SET role='admin' WHERE principal_id=$1", [a.id]);
  async function modulePatch(body) {
    const response = await fetch(`${n1.url}/api/v1/admin/games/test-counter`, { method: "PATCH",
      headers: { cookie: a.cookie, origin, "content-type": "application/json", "x-csrf-token": a.csrf }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  }
  await modulePatch({ defaultVersion: "0.2.0" });
  const v02 = await request(n2, a, "/matches", { commandId: randomUUID(), moduleId: "test-counter", mode: "solo", settings: { target: 20, turnSeconds: null }, visibility: "invite" }, 201);
  const fresh = await request(n2, a, `/matches/${v02.matchId}`);
  assert.equal(fresh.moduleVersion, "0.2.0");
  assert.equal(fresh.game.myNote, "renderer-v0.2.0");
  await modulePatch({ enabled: false });
  const pinnedBefore = await request(n1, a, `/matches/${matchId}`);
  assert.equal(pinnedBefore.moduleVersion, "0.1.0");
  const pinnedReceipt = await request(n1, a, `/matches/${matchId}/actions`, { commandId: randomUUID(), expectedRevision: pinnedBefore.revision, type: "add", payload: { amount: 1 } });
  const pinnedAfter = await request(n2, a, `/matches/${matchId}`);
  assert.equal(pinnedAfter.revision, pinnedReceipt.committedRevision);
  assert.equal(pinnedAfter.game.count, 4);
  assert.notEqual(pinnedAfter.game.myNote, "renderer-v0.2.0");
  await request(n1, a, "/matches", { commandId: randomUUID(), moduleId: "test-counter", mode: "solo", settings: { target: 20 }, visibility: "invite" }, 503);
  // A normal image containing only v0.1 must refuse startup once v0.2 is referenced.
  const missing = launch(`import {buildServer} from './apps/api/dist/server.js';
    try {const app=await buildServer({logger:false}); await app.ready(); await app.close(); process.exit(2);}
    catch(error){process.send({refused:true,message:error.message},()=>process.exit(0));}`);
  await until(() => missing.exitCode !== null, "missing referenced module startup refusal");
  assert.equal(missing.exitCode, 0);
  assert.ok(missing.messages.some(message => message.refused && message.message.includes("0.2.0")));
  const missingAsset = launch(`import {buildServer} from './apps/api/dist/server.js';
    import {GameRegistry} from './packages/platform/dist/index.js';
    import {manifest} from './games/test-counter/dist/manifest.js';
    import {server} from './games/test-counter/dist/server.js';
    import {mkdtemp,copyFile,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';
    import path from 'node:path';
    const root=await mkdtemp(path.join(tmpdir(),'sprint2-asset-'));
    let app; let failure;
    try {
      const registry=new GameRegistry();
      registry.register(manifest,server,{clientRoot:'apps/web/dist/games/test-counter/0.1.0/'});
      await copyFile('apps/web/dist/games/test-counter/0.1.0/client.js',path.join(root,'client.js'));
      registry.register({...manifest,version:'0.2.0'},server,{clientRoot:root});
      await rm(path.join(root,'client.js'));
      app=await buildServer({logger:false,gameRegistry:registry});
      await app.ready();
    } catch(error) {failure=error.message;}
    finally {await app?.close();await rm(root,{recursive:true,force:true});}
    process.send({refused:!!failure,message:failure},()=>process.exit(failure?0:2));`);
  await until(() => missingAsset.exitCode !== null, "missing referenced asset startup refusal");
  assert.equal(missingAsset.exitCode, 0);
  assert.ok(missingAsset.messages.some(message => message.refused && message.message.includes("0.2.0") && message.message.includes("client asset")));
  const version = (await pool.query("SHOW server_version")).rows[0].server_version;
  console.log(JSON.stringify({ scenario: "Sprint 2 two-process acceptance", postgres: version, apiPids: [n1.child.pid, n2.child.pid], intervalMs: 10000,
    normalDeliveryAndRefetchMs: normal.map(entry => +(entry.at - tNormal).toFixed(3)),
    missedWakeupRecoveryAndRefetchMs: missed.map(entry => +(entry.at - tMissed).toFixed(3)),
    listenerRecoveryAndRefetchMs: recovered.map(entry => +(entry.at - tRecovery).toFixed(3)),
    listenerPidsBefore: listenerBefore.map(row => row.pid), listenerPidsAfterMissed: listenerAfter.map(row => row.pid), listenerPidsRecovered: listenerRecovered.map(row => row.pid),
    periodicSweepSamples, privacy: "caller-private snapshots; invalidations carry metadata only",
    navigation: "unsubscribe preserves membership; explicit leave revokes view and scope",
    modules: "v0.2 default applies to new matches; disabled v0.1 pinned match still advances; new creation rejected; missing referenced code and assets refuse compiled API startup" }, null, 2));
} catch (error) {
  for (const child of children) console.error(`Child ${child.pid} recent output:\n${child.lines.slice(-15).join("\n")}`);
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  await Promise.all(children.map(stop));
  const disconnected = [];
  pool?.on("remove", client => {
    disconnected.push(new Promise(resolve => client.once("end", resolve)));
  });
  await pool?.end();
  await Promise.all(disconnected);
  if (databaseCreated) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}
