// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabasePool } from "@next-round/db";
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
      staticRoot,
      databasePool,
      setupToken,
      origin,
    });
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    await databasePool?.end();
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
