// SPDX-License-Identifier: Apache-2.0
// Test-service-only process controls. Production processes gain no fault/clock routes.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "../packages/db/dist/index.js";
import { migrateDatabase } from "../packages/db/dist/migrate.js";
import { hashPassword } from "../packages/platform/dist/auth.js";
import { manifest } from "../games/test-counter/dist/manifest.js";
import { HarnessEnvironment } from "../packages/game-harness/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function until(check, label, timeoutMs = 30000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(timer);
}

/** Isolated real PostgreSQL + compiled production API and worker, reusable by browser smoke. */
export async function createSprint4Fixture({ port = 0, browserOrigin } = {}) {
  const source = process.env.TEST_DATABASE_URL;
  assert.ok(
    source,
    "TEST_DATABASE_URL is required; the fixture creates/drops a disposable database",
  );
  const name = `sprint4_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(source);
  databaseUrl.pathname = `/${name}`;
  const admin = createDatabasePool({ connectionString: source, max: 2 });
  const sessionSecret = randomBytes(32).toString("hex");
  const children = new Set();
  const environments = new Set();
  let created = false;
  let pool;
  let api;
  let worker;
  let url;
  let disposed = false;
  const accounts = new Map();

  function launch(code, extra = {}) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.href,
        DATABASE_DIRECT_URL: databaseUrl.href,
        SESSION_SECRET: sessionSecret,
        NEXT_ROUND_ENABLE_TEST_COUNTER: "true",
        LIVE_RECONCILE_INTERVAL_MS: "10000",
        LOG_LEVEL: "error",
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.messages = [];
    child.lines = [];
    child.on("message", (message) => child.messages.push(message));
    child.on("error", (error) => {
      child.startError = error;
    });
    const record = (data) => {
      child.lines.push(data.toString());
      if (child.lines.length > 100) child.lines.shift();
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    children.add(child);
    return child;
  }

  async function startApi() {
    api = launch(
      `import {buildServer} from './apps/api/dist/server.js';
      const app=await buildServer({origin:${JSON.stringify(browserOrigin ?? "http://127.0.0.1:3000")},rateLimitMax:10000});
      const url=await app.listen({port:${Number(port)},host:'127.0.0.1'});
      process.send({ready:true,url});
      process.on('SIGTERM',()=>void app.close().then(()=>process.exit(0)));`,
      {
        APP_ORIGIN: browserOrigin ?? "http://127.0.0.1:3000",
      },
    );
    const message = await until(() => {
      if (api.startError) throw api.startError;
      if (api.exitCode !== null)
        throw new Error(`API exited: ${api.lines.join("")}`);
      return api.messages.find((value) => value.ready);
    }, "compiled API readiness");
    url = message.url;
    if (port === 0) port = Number(new URL(url).port);
    return api.pid;
  }

  async function startWorker() {
    worker = launch("await import('./apps/worker/dist/index.js');", {
      APP_ORIGIN: browserOrigin ?? url,
    });
    await until(() => {
      if (worker.startError) throw worker.startError;
      if (worker.exitCode !== null)
        throw new Error(`Worker exited: ${worker.lines.join("")}`);
      return worker.lines.some((line) =>
        line.includes("Background worker running"),
      );
    }, "compiled worker startup drain");
    return worker.pid;
  }

  async function provisionRegistered({
    username,
    displayName = username,
    role = "member",
    password,
  }) {
    if (accounts.has(username)) return accounts.get(username);
    assert.match(
      username,
      /^[a-z][a-z0-9_]{2,31}$/,
      "Use a valid fixture username",
    );
    const account = {
      id: randomUUID(),
      username,
      password: password ?? randomBytes(24).toString("hex"),
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO next_round.principals(id,kind,display_name) VALUES($1,'registered',$2)",
        [account.id, displayName],
      );
      await client.query(
        "INSERT INTO next_round.accounts(principal_id,username,password_hash,role,can_invite_guests,can_invite_registrations) VALUES($1,$2,$3,$4,true,true)",
        [account.id, username, await hashPassword(account.password), role],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    accounts.set(username, account);
    return account;
  }

  function environment() {
    const env = new HarnessEnvironment({
      baseUrl: url,
      origin: browserOrigin ?? "http://127.0.0.1:3000",
      timeoutMs: 10000,
      provisionRegistered,
    });
    environments.add(env);
    return env;
  }

  async function request(
    path,
    {
      client,
      body,
      method = body === undefined ? "GET" : "POST",
      headers = {},
    } = {},
  ) {
    return fetch(`${url}/api/v1${path}`, {
      method,
      headers: {
        origin: browserOrigin ?? "http://127.0.0.1:3000",
        "content-type": "application/json",
        ...(client
          ? {
              cookie: client.session.cookie,
              "x-csrf-token": client.session.csrfToken,
            }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function data(path, options, status = 200) {
    const response = await request(path, options);
    const envelope = await response.json();
    assert.equal(
      response.status,
      status,
      `${path}: ${JSON.stringify(envelope)}`,
    );
    return envelope.data;
  }

  async function close() {
    if (disposed) return;
    disposed = true;
    let error;
    const attempt = async (action) => {
      try {
        await action();
      } catch (caught) {
        error ??= caught;
      }
    };
    for (const env of environments) env.reset();
    await attempt(() => Promise.all([...children].map(stop)));
    await attempt(() => pool?.end());
    if (created)
      await attempt(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`));
    await attempt(() => admin.end());
    if (error) throw error;
  }

  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await migrateDatabase({ connectionString: databaseUrl.href });
    pool = createDatabasePool({ connectionString: databaseUrl.href, max: 5 });
    const host = await provisionRegistered({
      username: "s4_host",
      displayName: "Sprint 4 Host",
      role: "admin",
    });
    await provisionRegistered({
      username: "s4_peer",
      displayName: "Sprint 4 Peer",
    });
    await provisionRegistered({
      username: "s4_outsider",
      displayName: "Sprint 4 Outsider",
    });
    await pool.query(
      "INSERT INTO next_round.instance_policy(version,instance_name,policy,changed_by) VALUES(1,'Sprint 4',$1::jsonb,$2)",
      [
        JSON.stringify({
          schemaVersion: 1,
          historyVisibility: "participants",
          statsVisibility: "instance",
          rejoinChat: "full",
          retention: {
            chatDaysAfterFinish: null,
            privateStateDaysAfterFinish: null,
            resultDaysAfterFinish: null,
            notificationDays: null,
          },
        }),
        host.id,
      ],
    );
    await pool.query(
      "INSERT INTO next_round.instance_singleton(id,current_policy_version) VALUES(true,1)",
    );
    const seed = await pool.connect();
    try {
      await seed.query("BEGIN");
      await seed.query(
        "INSERT INTO next_round.modules(id,default_version) VALUES('test-counter','0.1.0')",
      );
      await seed.query(
        "INSERT INTO next_round.module_versions(module_id,version,manifest,server_hash,client_hash,sdk_contract,state_version,result_version) VALUES('test-counter','0.1.0',$1::jsonb,'sprint4-server','sprint4-client','next-round-game/0.1',1,1)",
        [JSON.stringify(manifest)],
      );
      await seed.query("COMMIT");
    } catch (error) {
      await seed.query("ROLLBACK");
      throw error;
    } finally {
      seed.release();
    }
    await startApi();
    await startWorker();
    return {
      get url() {
        return url;
      },
      databaseUrl: databaseUrl.href,
      pool,
      accounts,
      environment,
      provisionRegistered,
      request,
      data,
      until,
      get pids() {
        return { api: api.pid, worker: worker.pid };
      },
      async restart(target = "all") {
        assert.ok(
          ["api", "worker", "all"].includes(target),
          "restart target must be api, worker or all",
        );
        if (target !== "worker") {
          await stop(api);
          await startApi();
        }
        if (target !== "api") {
          await stop(worker);
          await startWorker();
        }
        return this.pids;
      },
      async stopWorker() {
        await stop(worker);
      },
      async resumeWorker() {
        return startWorker();
      },
      // Database fixture control, not a production route and not a client-side pretend clock.
      async expireDeadline(matchId) {
        const result = await pool.query(
          "UPDATE next_round.match_deadlines SET due_at=clock_timestamp()-interval '1 second' WHERE match_id=$1 AND status='pending' RETURNING key,generation,event_id",
          [matchId],
        );
        assert.equal(
          result.rowCount,
          1,
          "Fixture requires one pending Test Counter deadline",
        );
        return result.rows[0];
      },
      close,
    };
  } catch (error) {
    await close().catch((cleanup) =>
      console.error(`Fixture cleanup failed: ${cleanup.message}`),
    );
    throw error;
  }
}
