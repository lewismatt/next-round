// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { AuthService, GameRegistry, MatchService } from "@next-round/platform";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";

// BL-039: the admin health surface (spec section 8) — worker heartbeats,
// oldest pending deadline/outbox ages and parked (dead-lettered) effects,
// behind an admin session, with no payload or secret exposure.
describe.skipIf(!testDatabaseUrl)("BL-039 admin health surface", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRoot: string;
  let registry: GameRegistry;

  interface Fixture {
    principalId: string;
    cookie: string;
    rawToken: string;
  }

  async function seedSession(
    displayName: string,
    username: string,
    role: "admin" | "member",
  ): Promise<Fixture> {
    const principalId = randomUUID();
    const sessionToken = generateOpaqueSessionToken();
    const csrfToken = generateCsrfToken();
    await databasePool.query(
      `INSERT INTO next_round.principals (id, kind, display_name)
       VALUES ($1, 'registered', $2)`,
      [principalId, displayName],
    );
    await databasePool.query(
      `INSERT INTO next_round.accounts (principal_id, username, password_hash, role)
       VALUES ($1, $2, 'unused-in-integration-fixture', $3)`,
      [principalId, username, role],
    );
    await databasePool.query(
      `INSERT INTO next_round.sessions
         (id, principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, 0, now() + interval '1 day', now() + interval '1 day')`,
      [randomUUID(), principalId, sessionToken.tokenHash, csrfToken.csrfHash],
    );
    return {
      principalId,
      cookie: `${SESSION_DEV_COOKIE_NAME}=${sessionToken.rawToken}`,
      rawToken: sessionToken.rawToken,
    };
  }

  beforeEach(async () => {
    databaseName = `next_round_health_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    const databaseUrl = url.toString();
    await migrateDatabase({ connectionString: databaseUrl });
    databasePool = createDatabasePool({ connectionString: databaseUrl, max: 8 });

    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-health-"));
    await writeFile(path.join(staticRoot, "client.js"), "export const clientFixture = true;\n");
    const manifestModule = await import(
      new URL("../../../games/test-counter/src/manifest.ts", import.meta.url).href
    );
    const serverModule = await import(
      new URL("../../../games/test-counter/src/server.ts", import.meta.url).href
    );
    registry = new GameRegistry();
    registry.register(manifestModule.manifest, serverModule.server, {
      clientRoot: staticRoot,
    });

    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot,
      databasePool,
      setupToken: randomBytes(32).toString("hex"),
      origin,
      gameRegistry: registry,
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

  it("requires an admin session and reports workers, ages and parked effects", async () => {
    const admin = await seedSession("Admin", "health_admin", "admin");
    const member = await seedSession("Member", "health_member", "member");

    expect(
      (await app.inject({ url: "/api/v1/admin/health" })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({
        url: "/api/v1/admin/health",
        headers: { cookie: member.cookie },
      })).statusCode,
    ).toBe(403);

    // An overdue pending deadline via a real started match.
    const matchService = new MatchService(databasePool, registry);
    const authService = new AuthService(databasePool, undefined, matchService);
    const hostSession = await authService.authenticate(member.rawToken);
    const created = await matchService.create(hostSession, {
      commandId: randomUUID(),
      moduleId: "test-counter",
      mode: "solo",
      settings: { target: 10, turnSeconds: 60 },
      visibility: "instance",
    });
    await matchService.start(created.matchId, hostSession, {
      commandId: randomUUID(),
      expectedRevision: 0,
    });
    await databasePool.query(
      "UPDATE next_round.match_deadlines SET due_at = now() - interval '90 seconds' WHERE match_id = $1",
      [created.matchId],
    );

    // Heartbeats: one fresh, one stale.
    await databasePool.query(
      `INSERT INTO next_round.worker_heartbeats (worker_id, started_at, last_seen_at)
       VALUES ('worker-fresh', now() - interval '1 hour', now() - interval '5 seconds'),
              ('worker-stale', now() - interval '2 hours', now() - interval '120 seconds')`,
    );
    // Outbox: an aged pending row with a private payload marker, and a
    // parked (dead-lettered) row.
    const marker = "health-payload-marker-039";
    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, created_at)
       VALUES ($1::uuid, 'live.invalidate', 'test', $1::text, $2::jsonb, now() - interval '120 seconds')`,
      [randomUUID(), JSON.stringify({ scope: { kind: "home" }, revision: 1, marker })],
    );
    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, attempts, last_error_code, dead_lettered_at)
       VALUES ($1::uuid, 'unknown.topic', 'test', $1::text, '{}'::jsonb, 8, 'UNKNOWN_TOPIC', now() - interval '60 seconds')`,
      [randomUUID()],
    );

    const response = await app.inject({
      url: "/api/v1/admin/health",
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(marker);
    const data = response.json().data;
    expect(data.workers).toHaveLength(2);
    expect(data.workers[0]).toMatchObject({ workerId: "worker-fresh", status: "ok" });
    expect(data.workers[0].ageSeconds).toBeGreaterThanOrEqual(4);
    expect(data.workers[1]).toMatchObject({ workerId: "worker-stale", status: "stale" });
    expect(data.oldestPendingOutboxAgeSeconds).toBeGreaterThanOrEqual(110);
    expect(data.oldestPendingDeadlineAgeSeconds).toBeGreaterThanOrEqual(80);
    expect(data.parkedEffects.total).toBe(1);
    expect(data.parkedEffects.recent).toHaveLength(1);
    expect(data.parkedEffects.recent[0]).toMatchObject({
      topic: "unknown.topic",
      attempts: 8,
      lastErrorCode: "UNKNOWN_TOPIC",
    });
  }, 120_000);

  it("reports null ages and no workers on an idle instance", async () => {
    const admin = await seedSession("Admin", "health_admin_idle", "admin");
    const response = await app.inject({
      url: "/api/v1/admin/health",
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.workers).toEqual([]);
    expect(data.oldestPendingOutboxAgeSeconds).toBeNull();
    expect(data.oldestPendingDeadlineAgeSeconds).toBeNull();
    expect(data.parkedEffects).toEqual({ total: 0, recent: [] });
  }, 120_000);
});
