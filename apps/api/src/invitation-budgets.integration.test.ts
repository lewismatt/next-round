// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { GameRegistry } from "@next-round/platform";
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

interface SessionFixture {
  principalId: string;
  cookie: string;
  csrf: string;
}

function headers(session: SessionFixture): Record<string, string> {
  return {
    cookie: session.cookie,
    origin,
    "content-type": "application/json",
    "x-csrf-token": session.csrf,
  };
}

// BL-043: BL-017's regression coverage originally exercised only the
// registration-token mint path. These tests drive the member-invitation,
// guest-invitation and match-link paths in packages/platform's
// invitation-service and prove they share the same rolling-hour and
// outstanding budgets, including the match-link rotation credit.
describe.skipIf(!testDatabaseUrl)("BL-043 shared invitation budgets (invitation-service paths)", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRoot: string;
  let host: SessionFixture;
  let matchId: string;
  let recipientIds: string[] = [];

  async function seedPrincipal(
    displayName: string,
    username: string,
    options: { session?: boolean; canInviteGuests?: boolean } = {},
  ): Promise<SessionFixture> {
    const principalId = randomUUID();
    const sessionId = randomUUID();
    const sessionToken = generateOpaqueSessionToken();
    const csrfToken = generateCsrfToken();
    await databasePool.query(
      `INSERT INTO next_round.principals (id, kind, display_name)
       VALUES ($1, 'registered', $2)`,
      [principalId, displayName],
    );
    await databasePool.query(
      `INSERT INTO next_round.accounts
         (principal_id, username, password_hash, role, can_invite_guests)
       VALUES ($1, $2, 'unused-in-integration-fixture', 'member', $3)`,
      [principalId, username, options.canInviteGuests ?? false],
    );
    if (options.session) {
      await databasePool.query(
        `INSERT INTO next_round.sessions
           (id, principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 0, now() + interval '1 day', now() + interval '1 day')`,
        [sessionId, principalId, sessionToken.tokenHash, csrfToken.csrfHash],
      );
    }
    return {
      principalId,
      cookie: `${SESSION_DEV_COOKIE_NAME}=${sessionToken.rawToken}`,
      csrf: csrfToken.rawToken,
    };
  }

  function post(url: string, payload: unknown) {
    return app.inject({
      method: "POST",
      url: `/api/v1${url}`,
      headers: headers(host),
      payload: JSON.stringify(payload),
    });
  }

  const inviteMember = (recipientId: string) =>
    post(`/matches/${matchId}/invitations`, {
      commandId: randomUUID(),
      recipientPrincipalId: recipientId,
    });
  const inviteGuest = () =>
    post(`/matches/${matchId}/guest-invitations`, { commandId: randomUUID() });
  const createLink = (rotate: boolean) =>
    post(`/matches/${matchId}/link`, { commandId: randomUUID(), rotate });

  async function insertOutstandingRegistrations(count: number) {
    await databasePool.query(
      `INSERT INTO next_round.invitations(kind, issuer_id, expires_at)
       SELECT 'registration', $1, now() + interval '1 day'
         FROM generate_series(1, $2)`,
      [host.principalId, count],
    );
  }

  beforeEach(async () => {
    databaseName = `next_round_budgets_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    await migrateDatabase({ connectionString: url.toString() });
    databasePool = createDatabasePool({ connectionString: url.toString(), max: 8 });

    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-budgets-"));
    await writeFile(path.join(staticRoot, "client.js"), "export const clientFixture = true;\n");
    const manifestModule = await import(
      new URL("../../../games/test-counter/src/manifest.ts", import.meta.url).href
    );
    const serverModule = await import(
      new URL("../../../games/test-counter/src/server.ts", import.meta.url).href
    );
    const registry = new GameRegistry();
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

    host = await seedPrincipal("Host", "budget_host", {
      session: true,
      canInviteGuests: true,
    });
    // Instance policy + module availability, mirroring the worker
    // recovery harness: match creation requires both. The modules /
    // module_versions pair is a circular FK, so seed it in one
    // transaction where the constraint defers to commit.
    const seedClient = await databasePool.connect();
    try {
      await seedClient.query("BEGIN");
      await seedClient.query(
        `INSERT INTO next_round.instance_policy (version, instance_name, policy, changed_by)
       VALUES (1, 'Budget test instance', $1::jsonb, $2)`,
        [
          JSON.stringify({
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
          }),
          host.principalId,
        ],
      );
      await seedClient.query(
        "INSERT INTO next_round.instance_singleton (id, current_policy_version) VALUES (true, 1)",
      );
      await seedClient.query(
        "INSERT INTO next_round.modules (id, default_version) VALUES ('test-counter', '0.1.0')",
      );
      await seedClient.query(
        `INSERT INTO next_round.module_versions
         (module_id, version, manifest, server_hash, client_hash, sdk_contract, state_version, result_version)
       VALUES ('test-counter', '0.1.0', '{}'::jsonb, 'fixture-server', 'fixture-client', 'next-round-game/0.1', 1, 1)`,
      );
      await seedClient.query("COMMIT");
    } finally {
      seedClient.release();
    }
    recipientIds = [];
    for (let index = 0; index < 20; index += 1) {
      const recipient = await seedPrincipal(
        `Recipient ${index}`,
        `budget_recipient_${index}`,
      );
      recipientIds.push(recipient.principalId);
    }

    const created = await post("/matches", {
      commandId: randomUUID(),
      moduleId: "test-counter",
      mode: "group",
      settings: { target: 10, turnSeconds: null },
      visibility: "invite",
    });
    expect(created.statusCode).toBe(201);
    matchId = created.json().data.matchId;
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

  it("shares the rolling-hour cap across guest, member and link mints", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await inviteGuest()).statusCode).toBe(201);
    }
    const memberOverCap = await inviteMember(recipientIds[0]);
    expect(memberOverCap.statusCode).toBe(429);
    expect(memberOverCap.json().error.code).toBe("RATE_LIMITED");
    expect(Number(memberOverCap.headers["retry-after"])).toBeGreaterThan(0);
    const linkOverCap = await createLink(false);
    expect(linkOverCap.statusCode).toBe(429);
    expect(Number(linkOverCap.headers["retry-after"])).toBeGreaterThan(0);

    await databasePool.query("DELETE FROM next_round.rate_buckets");
    for (const recipientId of recipientIds) {
      expect((await inviteMember(recipientId)).statusCode).toBe(201);
    }
    const guestOverCap = await inviteGuest();
    expect(guestOverCap.statusCode).toBe(429);
    expect(guestOverCap.json().error.code).toBe("RATE_LIMITED");
    expect(Number(guestOverCap.headers["retry-after"])).toBeGreaterThan(0);
  }, 120_000);

  it("enforces the outstanding cap on every path and credits link rotation", async () => {
    await insertOutstandingRegistrations(30);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await inviteGuest()).statusCode).toBe(201);
    }
    // 30 inserted + 20 guest invitations = 50 outstanding: every path caps.
    expect((await inviteMember(recipientIds[0])).statusCode).toBe(429);
    expect((await inviteGuest()).statusCode).toBe(429);
    expect((await createLink(false)).statusCode).toBe(429);

    // Rotation credit: with one live link inside the 50, rotating it must
    // succeed because the old link is revoked before the count is taken.
    await databasePool.query("DELETE FROM next_round.rate_buckets");
    await databasePool.query(
      "DELETE FROM next_round.invitations WHERE issuer_id = $1",
      [host.principalId],
    );
    expect((await createLink(false)).statusCode).toBe(200);
    await insertOutstandingRegistrations(49);
    const rotated = await createLink(true);
    expect(rotated.statusCode).toBe(200);
    const links = await databasePool.query<{ total: number; live: number }>(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE revoked_at IS NULL)::integer AS live
         FROM next_round.match_links WHERE match_id = $1`,
      [matchId],
    );
    expect(links.rows[0]).toEqual({ total: 2, live: 1 });
    // The cap still binds after rotation.
    expect((await inviteMember(recipientIds[0])).statusCode).toBe(429);
  }, 120_000);
});
