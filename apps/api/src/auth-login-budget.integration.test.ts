// SPDX-License-Identifier: Apache-2.0
import crypto, { randomBytes, randomUUID } from "node:crypto";
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
if (
  !testDatabaseUrl &&
  process.env.npm_lifecycle_event === "test:integration"
) {
  throw new Error(
    "TEST_DATABASE_URL is required for database integration tests",
  );
}

const origin = "http://localhost:3000";
const setupToken = randomBytes(32).toString("hex");
const password = "correct horse battery staple";

async function postLogin(
  app: FastifyInstance,
  username: string,
  candidatePassword: string,
  remoteAddress: string,
  forwardedFor?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress,
    headers: {
      origin,
      "content-type": "application/json",
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    payload: { username, password: candidatePassword },
  });
}

describe.skipIf(!testDatabaseUrl)("BL-010 shared login failure budgets", () => {
  let adminPool: DatabasePool | undefined;
  let poolA: DatabasePool | undefined;
  let poolB: DatabasePool | undefined;
  let appA: FastifyInstance | undefined;
  let appB: FastifyInstance | undefined;
  let databaseName = "";
  let staticRootA = "";
  let staticRootB = "";

  beforeEach(async () => {
    databaseName = `next_round_login_budget_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({
      connectionString: testDatabaseUrl,
      max: 1,
    });
    await adminPool.query(
      `CREATE DATABASE "${databaseName}" TEMPLATE template0`,
    );
    const databaseUrl = new URL(testDatabaseUrl!);
    databaseUrl.pathname = `/${databaseName}`;
    await migrateDatabase({ connectionString: databaseUrl.toString() });
    poolA = createDatabasePool({
      connectionString: databaseUrl.toString(),
      max: 8,
    });
    poolB = createDatabasePool({
      connectionString: databaseUrl.toString(),
      max: 8,
    });
    staticRootA = await mkdtemp(path.join(tmpdir(), "next-round-login-a-"));
    staticRootB = await mkdtemp(path.join(tmpdir(), "next-round-login-b-"));
    appA = await buildServer({
      logger: false,
      trustProxy: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot: staticRootA,
      databasePool: poolA,
      setupToken,
      origin,
      enableLiveListener: false,
    });
    appB = await buildServer({
      logger: false,
      trustProxy: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot: staticRootB,
      databasePool: poolB,
      setupToken,
      origin,
      enableLiveListener: false,
    });

    const setup = await appA.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin, "content-type": "application/json" },
      payload: {
        setupToken,
        commandId: randomUUID(),
        instanceName: "Login Budget Integration",
        username: "Initial_Admin",
        password,
        displayName: "Initial Admin",
        policy: {
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
        },
      },
    });
    expect(setup.statusCode).toBe(201);
  }, 120_000);

  afterEach(async () => {
    await appA?.close();
    await appB?.close();
    // Pool.end resolves before every client socket emits end. Wait for those
    // events before dropping the database instead of terminating closing clients.
    const disconnected: Array<Promise<void>> = [];
    for (const pool of [poolA, poolB]) {
      pool?.on("remove", (client) => {
        disconnected.push(
          new Promise<void>((resolve) => client.once("end", resolve)),
        );
      });
    }
    await Promise.all([poolA?.end(), poolB?.end()]);
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    await rm(staticRootA, { recursive: true, force: true });
    await rm(staticRootB, { recursive: true, force: true });
  }, 60_000);

  it("enforces normalized username and source-IP rolling limits across API nodes", async () => {
    const normalizedUsernameAttempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        postLogin(
          index % 2 === 0 ? appA! : appB!,
          index % 2 === 0 ? "INITIAL_ADMIN" : "initial_admin",
          "wrong password",
          "198.51.100.10",
          `192.0.2.${index + 1}`,
        ),
      ),
    );
    const usernameFailures = normalizedUsernameAttempts.filter(
      (response) => response.statusCode === 401,
    );
    const usernameLimited = normalizedUsernameAttempts.filter(
      (response) => response.statusCode === 429,
    );
    expect(usernameFailures).toHaveLength(5);
    expect(usernameLimited).toHaveLength(3);
    expect(usernameFailures[0]?.json()).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Username or password is incorrect.",
      },
    });
    for (const response of usernameLimited) {
      const retryAfter = Number(response.headers["retry-after"]);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
      expect(response.json().error.details.retryAfterSeconds).toBe(retryAfter);
    }
    const usernameKeyHash = crypto
      .createHash("sha256")
      .update("login:username:initial_admin", "utf8")
      .digest();
    const expectedRetryAfter = await poolA!.query<{ seconds: number }>(
      `SELECT GREATEST(
                1,
                ceil(extract(epoch FROM (
                  min(window_start) + interval '15 minutes' - clock_timestamp()
                )))::integer
              ) AS seconds
         FROM next_round.rate_buckets
        WHERE key_hash = $1`,
      [usernameKeyHash],
    );
    const reportedRetryAfter = Number(
      usernameLimited[0]?.headers["retry-after"],
    );
    expect(reportedRetryAfter).toBeGreaterThanOrEqual(
      expectedRetryAfter.rows[0]!.seconds,
    );
    expect(reportedRetryAfter).toBeLessThanOrEqual(
      expectedRetryAfter.rows[0]!.seconds + 2,
    );

    await poolA!.query(
      `UPDATE next_round.rate_buckets
          SET window_start = window_start - interval '15 minutes 1 second',
              expires_at = expires_at - interval '15 minutes 1 second'
        WHERE key_hash = $1`,
      [usernameKeyHash],
    );

    const successBoundaryIp = "198.51.100.11";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await postLogin(
        appA!,
        "initial_admin",
        "wrong password",
        successBoundaryIp,
      );
      expect(failed.statusCode).toBe(401);
    }
    const successfulLogin = await postLogin(
      appB!,
      "INITIAL_ADMIN",
      password,
      successBoundaryIp,
    );
    expect(successfulLogin.statusCode).toBe(200);
    const sourceIpKeyHash = crypto
      .createHash("sha256")
      .update(`login:source-ip:${successBoundaryIp}`, "utf8")
      .digest();
    const successFailureCounts = await poolA!.query<{ count: number }>(
      `SELECT sum(count)::integer AS count
         FROM next_round.rate_buckets
        WHERE key_hash = ANY($1::bytea[])
          AND window_start > clock_timestamp() - interval '15 minutes'
        GROUP BY key_hash`,
      [[usernameKeyHash, sourceIpKeyHash]],
    );
    expect(successFailureCounts.rows.map((row) => row.count)).toEqual([4, 4]);
    expect(
      (
        await postLogin(
          appA!,
          "initial_admin",
          "wrong password",
          successBoundaryIp,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await postLogin(appB!, "initial_admin", password, successBoundaryIp))
        .statusCode,
    ).toBe(429);
    await poolA!.query(
      `WITH oldest AS (
         SELECT window_start
           FROM next_round.rate_buckets
          WHERE key_hash = $1
            AND window_start > clock_timestamp() - interval '15 minutes'
          ORDER BY window_start
          LIMIT 1
       )
       UPDATE next_round.rate_buckets AS bucket
          SET window_start = bucket.window_start - interval '15 minutes 1 second',
              expires_at = bucket.expires_at - interval '15 minutes 1 second'
         FROM oldest
        WHERE bucket.key_hash = $1
          AND bucket.window_start = oldest.window_start`,
      [usernameKeyHash],
    );
    expect(
      (
        await postLogin(
          appA!,
          "initial_admin",
          "wrong password",
          successBoundaryIp,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await postLogin(
          appB!,
          "INITIAL_ADMIN",
          "wrong password",
          successBoundaryIp,
        )
      ).statusCode,
    ).toBe(429);

    await poolA!.query(
      `UPDATE next_round.rate_buckets
          SET window_start = window_start - interval '15 minutes 1 second',
              expires_at = expires_at - interval '15 minutes 1 second'
        WHERE key_hash = $1`,
      [usernameKeyHash],
    );
    const afterWindow = await postLogin(
      appB!,
      "initial_admin",
      "wrong password",
      "198.51.100.12",
    );
    expect(afterWindow.statusCode).toBe(401);

    const sourceIpAttempts = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        postLogin(
          index % 2 === 0 ? appA! : appB!,
          `missing_user_${index}`,
          "wrong password",
          "198.51.100.13",
          `203.0.113.${index + 1}`,
        ),
      ),
    );
    expect(
      sourceIpAttempts.filter((response) => response.statusCode === 401),
    ).toHaveLength(20);
    const ipLimited = sourceIpAttempts.filter(
      (response) => response.statusCode === 429,
    );
    expect(ipLimited).toHaveLength(1);
    expect(ipLimited[0]?.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    expect(ipLimited[0]?.headers["retry-after"]).toMatch(/^[1-9]\d*$/);

    const unknownUserFailure = sourceIpAttempts.find(
      (response) => response.statusCode === 401,
    );
    expect(unknownUserFailure?.json()).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Username or password is incorrect.",
      },
    });
  }, 120_000);
});
