// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabasePool } from "@next-round/db";
import { LIVE_SUBPROTOCOL } from "@next-round/contracts";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";
const setupToken = randomBytes(32).toString("hex");
const password = "correct horse battery staple";

const policy = {
  schemaVersion: 1 as const,
  historyVisibility: "participants" as const,
  statsVisibility: "owner" as const,
  rejoinChat: "full" as const,
  retention: {
    chatDaysAfterFinish: 30,
    privateStateDaysAfterFinish: 30,
    resultDaysAfterFinish: null,
    notificationDays: 30,
  },
};

function setupBody(commandId: string) {
  return {
    setupToken,
    commandId,
    instanceName: "Integration Table",
    username: "Initial_Admin",
    password,
    displayName: "Initial Admin",
    policy,
  };
}

function jsonHeaders(): Record<string, string> {
  return { origin, "content-type": "application/json" };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

describe.skipIf(!testDatabaseUrl)("F1-01 bootstrap and registered sessions", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let databaseUrl: string;
  let staticRoot: string;

  beforeEach(async () => {
    databaseName = `next_round_auth_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    await migrateDatabase({ connectionString: databaseUrl });
    databasePool = createDatabasePool({ connectionString: databaseUrl, max: 8 });
    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-auth-"));
    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot,
      databasePool,
      setupToken,
      origin,
    });
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    const disconnected: Array<Promise<void>> = [];
    databasePool?.on("remove", (client) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      client.once("end", resolve);
      disconnected.push(promise);
    });
    await databasePool?.end();
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    await rm(staticRoot, { recursive: true, force: true });
  }, 60_000);

  it("recovers exact redemptions only with valid sessions and keeps receipts secret-free", async () => {
    await app.inject({ method: "POST", url: "/api/v1/setup", headers: jsonHeaders(), payload: setupBody(randomUUID()) });
    const admin = (await databasePool.query<{ id: string }>("SELECT id FROM next_round.principals")).rows[0].id;
    const digest = (token: string) => createHash("sha256").update(token).digest();
    const token = randomBytes(32).toString("hex");
    await databasePool.query(`INSERT INTO next_round.invitations(kind,issuer_id,token_hash,expires_at)
      VALUES('registration',$1,$2,now()+interval '1 day')`, [admin, digest(token)]);
    const body = { token, commandId: randomUUID(), username: "new_member", password, displayName: "New member" };
    const post = (url: string, payload: unknown, cookie?: string) =>
      app.inject({ method: "POST", url: `/api/v1${url}`, headers: { ...jsonHeaders(), ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(payload) });
    const registered = await post("/auth/register", body);
    expect(registered.statusCode).toBe(201);
    const cookies = cookieHeader(registered.headers["set-cookie"]);
    const principalId = registered.json().data.principal.id;
    expect((await post("/auth/register", body)).json().error.code).toBe("TOKEN_INVALID");
    const replay = await post("/auth/register", body, cookies);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data).toEqual(registered.json().data);
    expect((await post("/auth/register", { ...body, displayName: "Different" }, cookies)).json().error.code).toBe("IDEMPOTENCY_CONFLICT");

    const qr = randomBytes(32).toString("hex");
    await databasePool.query(`INSERT INTO next_round.auth_tokens(kind,token_hash,principal_id,issuer_id,expires_at)
      VALUES('signin',$1,$2,$3,now()+interval '15 minutes')`, [digest(qr), principalId, admin]);
    const qrBody = { token: qr, commandId: randomUUID() };
    const qrRace = await Promise.all([post("/auth/qr/redeem", qrBody), post("/auth/qr/redeem", qrBody)]);
    expect(qrRace.map((response) => response.statusCode).sort()).toEqual([200, 410]);
    const signedIn = qrRace.find((response) => response.statusCode === 200)!;
    expect(signedIn.statusCode).toBe(200);
    const qrCookies = cookieHeader(signedIn.headers["set-cookie"]);
    expect((await post("/auth/qr/redeem", qrBody, cookies)).json().error.code).toBe("TOKEN_INVALID");
    expect((await post("/auth/qr/redeem", qrBody, qrCookies)).json().data).toEqual(signedIn.json().data);
    await databasePool.query("DELETE FROM next_round.rate_buckets");
    const reset = randomBytes(32).toString("hex");
    await databasePool.query(`INSERT INTO next_round.auth_tokens(kind,token_hash,principal_id,issuer_id,expires_at)
      VALUES('reset',$1,$2,$3,now()+interval '30 minutes')`, [digest(reset), principalId, admin]);
    const resetBody = { token: reset, password: `${password}!`, commandId: randomUUID() };
    await databasePool.query("UPDATE next_round.principals SET disabled_at=now() WHERE id=$1", [principalId]);
    expect((await post("/auth/reset/redeem", resetBody)).json().error.code).toBe("TOKEN_INVALID");
    const unused = await databasePool.query("SELECT used_at FROM next_round.auth_tokens WHERE token_hash=$1", [digest(reset)]);
    expect(unused.rows[0].used_at).toBeNull();
    await databasePool.query("UPDATE next_round.principals SET disabled_at=NULL WHERE id=$1", [principalId]);
    expect((await post("/auth/reset/redeem", resetBody)).statusCode).toBe(204);
    expect((await post("/auth/reset/redeem", resetBody, qrCookies)).json().error.code).toBe("TOKEN_INVALID");
    const login = await post("/auth/login", { username: body.username, password: resetBody.password });
    expect(login.statusCode).toBe(200);
    expect((await post("/auth/reset/redeem", resetBody, cookieHeader(login.headers["set-cookie"]))).statusCode).toBe(204);
    const receipts = await databasePool.query("SELECT safe_receipt FROM next_round.command_receipts WHERE scope LIKE 'auth.%'");
    expect(receipts.rows).toHaveLength(3);
    const stored = JSON.stringify(receipts.rows);
    await databasePool.query("DELETE FROM next_round.rate_buckets");
    const missingAccountReset = randomBytes(32).toString("hex");
    await databasePool.query(`INSERT INTO next_round.auth_tokens(kind,token_hash,principal_id,issuer_id,expires_at)
      VALUES('reset',$1,$2,$3,now()+interval '30 minutes')`, [digest(missingAccountReset), principalId, admin]);
    await databasePool.query("DELETE FROM next_round.accounts WHERE principal_id=$1", [principalId]);
    expect((await post("/auth/reset/redeem", { token: missingAccountReset, password, commandId: randomUUID() })).json().error.code).toBe("TOKEN_INVALID");
    expect((await databasePool.query("SELECT used_at FROM next_round.auth_tokens WHERE token_hash=$1", [digest(missingAccountReset)])).rows[0].used_at).toBeNull();
    const takenToken = randomBytes(32).toString("hex");
    await databasePool.query(`INSERT INTO next_round.invitations(kind,issuer_id,token_hash,expires_at)
      VALUES('registration',$1,$2,now()+interval '1 day')`, [admin, digest(takenToken)]);
    const taken = await post("/auth/register", { ...body, token: takenToken, username: "initial_admin", commandId: randomUUID() });
    const invalid = await post("/auth/register", { ...body, token: "invalid", commandId: randomUUID() });
    expect(taken.json().error.code).toBe("TOKEN_INVALID");
    expect(taken.json().error.message).toBe(invalid.json().error.message);
    for (const secret of [token, qr, reset, password, registered.json().data.csrfToken]) expect(stored).not.toContain(secret);
  }, 120_000);

  it("does not rotate CSRF on session reads with missing or stale proof", async () => {
    await app.inject({ method: "POST", url: "/api/v1/setup", headers: jsonHeaders(), payload: setupBody(randomUUID()) });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: jsonHeaders(), payload: { username: "initial_admin", password } });
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const before = await databasePool.query("SELECT csrf_hash FROM next_round.sessions");
    const sessionOnly = cookies.split("; ").filter((value) => !value.startsWith("next-round-csrf=")).join("; ");
    for (const cookie of [sessionOnly, `${sessionOnly}; next-round-csrf=stale`]) {
      const response = await app.inject({ url: "/api/v1/auth/session", headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect((await databasePool.query("SELECT csrf_hash FROM next_round.sessions")).rows).toEqual(before.rows);
    expect((await app.inject({ url: "/api/v1/auth/session", headers: { cookie: cookies } })).statusCode).toBe(200);
  }, 120_000);

  it("rejects development cookies on HTTPS and enforces cluster-shared invitation budgets", async () => {
    await app.close();
    const secureOrigin = "https://table.example";
    app = await buildServer({ logger: false, cookieSecret: randomBytes(32).toString("hex"),
      staticRoot, databasePool, setupToken, origin: secureOrigin });
    const headers = { origin: secureOrigin, "content-type": "application/json" };
    await app.inject({ method: "POST", url: "/api/v1/setup", headers, payload: setupBody(randomUUID()) });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers, payload: { username: "initial_admin", password } });
    expect(login.statusCode).toBe(200);
    const cookies = cookieHeader(login.headers["set-cookie"]);
    const forged = cookies.replaceAll("__Host-next-round", "next-round");
    expect((await app.inject({ url: "/api/v1/auth/session", headers: { cookie: forged } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/auth/session", headers: { cookie: cookies } })).statusCode).toBe(200);
    const deniedLive = await app.inject({ url: "/api/v1/live", headers: {
      origin: secureOrigin, cookie: forged, "sec-websocket-protocol": LIVE_SUBPROTOCOL,
    } });
    expect(deniedLive.statusCode).toBe(401);
    const mintHeaders = { ...headers, cookie: cookies, "x-csrf-token": login.json().data.csrfToken };
    const results = await Promise.all(Array.from({ length: 21 }, () => app.inject({
      method: "POST", url: "/api/v1/invitations/registration", headers: mintHeaders, payload: { commandId: randomUUID() },
    })));
    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(20);
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(1);
    expect(Number(results.find((result) => result.statusCode === 429)!.headers["retry-after"])).toBeGreaterThan(0);
    await databasePool.query("DELETE FROM next_round.rate_buckets");
    const issuerId = login.json().data.principal.id;
    await databasePool.query(`INSERT INTO next_round.invitations(kind,issuer_id,expires_at)
      SELECT 'registration',$1,now()+interval '1 day' FROM generate_series(1,30)`, [issuerId]);
    const capped = await app.inject({ method: "POST", url: "/api/v1/invitations/registration",
      headers: mintHeaders, payload: { commandId: randomUUID() } });
    expect(capped.statusCode).toBe(429);
    expect(Number(capped.headers["retry-after"])).toBeGreaterThan(0);
    expect((await databasePool.query("SELECT count(*)::integer AS count FROM next_round.invitations")).rows[0].count).toBe(50);
  }, 120_000);

  it("serializes setup, authenticates without email, revokes logout, and preserves one admin", async () => {
    const before = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ data: { configured: false } });
    expect(before.body).not.toContain(setupToken);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/setup",
        headers: jsonHeaders(),
        payload: setupBody(randomUUID()),
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/setup",
        headers: jsonHeaders(),
        payload: setupBody(randomUUID()),
      }),
    ]);
    const setupResponses = [first, second].sort((left, right) => left.statusCode - right.statusCode);
    expect(setupResponses.map((response) => response.statusCode)).toEqual([201, 403]);
    const setupResponse = setupResponses[0].json() as {
      data: { principal: Record<string, unknown> };
    };
    expect(setupResponse.data.principal).toMatchObject({
      kind: "registered",
      username: "initial_admin",
      displayName: "Initial Admin",
    });
    expect(setupResponse.data.principal).not.toHaveProperty("email");
    for (const response of setupResponses) expect(response.body).not.toContain(setupToken);

    const adminCount = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM next_round.accounts a
         JOIN next_round.principals p ON p.id = a.principal_id
        WHERE a.role = 'admin' AND p.disabled_at IS NULL`,
    );
    expect(adminCount.rows[0].count).toBe(1);

    const after = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(after.json()).toMatchObject({ data: { configured: true } });
    expect(after.body).not.toContain(setupToken);

    for (const credentials of [
      { username: "initial_admin", password: `${password}!` },
      { username: "missing_admin", password: `${password}!` },
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: jsonHeaders(),
        payload: credentials,
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
      expect(rejected.body).not.toContain(credentials.password);
    }

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: jsonHeaders(),
      payload: { username: "INITIAL_ADMIN", password },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json() as {
      data: {
        principal: { id: string; username: string; [key: string]: unknown };
        csrfToken: string;
      };
    };
    expect(loginBody.data.principal.username).toBe("initial_admin");
    expect(loginBody.data.principal).not.toHaveProperty("email");
    const cookies = cookieHeader(login.headers["set-cookie"]);

    const protectedBeforeLogout = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: cookies },
    });
    expect(protectedBeforeLogout.statusCode).toBe(200);

    const lastAdmin = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${loginBody.data.principal.id}`,
      headers: {
        ...jsonHeaders(),
        cookie: cookies,
        "x-csrf-token": loginBody.data.csrfToken,
      },
      payload: { disabled: true },
    });
    expect(lastAdmin.statusCode).toBe(422);
    expect(lastAdmin.json()).toMatchObject({ error: { code: "RULE_REJECTED" } });
    const stillEnabled = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM next_round.accounts a
         JOIN next_round.principals p ON p.id = a.principal_id
        WHERE a.role = 'admin' AND p.disabled_at IS NULL`,
    );
    expect(stillEnabled.rows[0].count).toBe(1);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        ...jsonHeaders(),
        cookie: cookies,
        "x-csrf-token": loginBody.data.csrfToken,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);

    const protectedAfterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: cookies },
    });
    expect(protectedAfterLogout.statusCode).toBe(401);
    expect(protectedAfterLogout.json()).toMatchObject({ error: { code: "SESSION_EXPIRED" } });
  }, 120_000);
});
