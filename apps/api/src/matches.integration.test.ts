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
const markerA = "P-f103-member-a-private";
const markerB = "P-f103-member-b-private";
const noteA = "member-a-private-guess";
const noteB = "member-b-private-guess";
const rejectedGuess = "request-private-guess";
const serverFixtureSecret = "next-round-test-counter-server-fixture-secret-v1";

interface SessionFixture {
  principalId: string;
  cookie: string;
  csrf: string;
}

function headers(session: SessionFixture, mutation = false): Record<string, string> {
  const result: Record<string, string> = { cookie: session.cookie };
  if (mutation) {
    result.origin = origin;
    result["content-type"] = "application/json";
    result["x-csrf-token"] = session.csrf;
  }
  return result;
}

function expectNoPrivateValues(body: string): void {
  for (const value of [
    markerA,
    markerB,
    noteA,
    noteB,
    rejectedGuess,
    serverFixtureSecret,
  ]) {
    expect(body).not.toContain(value);
  }
}

describe.skipIf(!testDatabaseUrl)("F1-03 authorized match views", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRoot: string;
  let matchId: string;
  let memberAId: string;
  let memberBId: string;
  let memberA: SessionFixture;
  let memberB: SessionFixture;
  let outsider: SessionFixture;
  let registry: GameRegistry;

  async function seedSession(displayName: string, username: string): Promise<SessionFixture> {
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
         (principal_id, username, password_hash, role)
       VALUES ($1, $2, 'unused-in-integration-fixture', 'member')`,
      [principalId, username],
    );
    await databasePool.query(
      `INSERT INTO next_round.sessions
         (id, principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, 0, now() + interval '1 day', now() + interval '1 day')`,
      [sessionId, principalId, sessionToken.tokenHash, csrfToken.csrfHash],
    );
    return {
      principalId,
      cookie: `${SESSION_DEV_COOKIE_NAME}=${sessionToken.rawToken}`,
      csrf: csrfToken.rawToken,
    };
  }

  async function seedDevice(principalId: string): Promise<SessionFixture> {
    const sessionId = randomUUID();
    const sessionToken = generateOpaqueSessionToken();
    const csrfToken = generateCsrfToken();
    await databasePool.query(
      `INSERT INTO next_round.sessions
         (id, principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, 0, now() + interval '1 day', now() + interval '1 day')`,
      [sessionId, principalId, sessionToken.tokenHash, csrfToken.csrfHash],
    );
    return {
      principalId,
      cookie: `${SESSION_DEV_COOKIE_NAME}=${sessionToken.rawToken}`,
      csrf: csrfToken.rawToken,
    };
  }


  beforeEach(async () => {
    databaseName = `next_round_views_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    await migrateDatabase({ connectionString: url.toString() });
    databasePool = createDatabasePool({ connectionString: url.toString(), max: 8 });

    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-views-"));
    await writeFile(path.join(staticRoot, "client.js"), "export const clientFixture = true;\n");
    // Game modules are runtime registry plugins, and the API package must not depend on one game.
    const manifestUrl = new URL(
      "../../../games/test-counter/src/manifest.ts",
      import.meta.url,
    );
    const serverUrl = new URL(
      "../../../games/test-counter/src/server.ts",
      import.meta.url,
    );
    const manifestModule = await import(manifestUrl.href);
    const serverModule = await import(serverUrl.href);
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

    memberA = await seedSession("Member A", "member_a");
    memberB = await seedSession("Member B", "member_b");
    outsider = await seedSession("Outsider", "outsider");
    matchId = randomUUID();
    memberAId = randomUUID();
    memberBId = randomUUID();

    const state = {
      count: 2,
      target: 10,
      turnSeconds: null,
      scores: { [memberAId]: 1, [memberBId]: 1 },
      notes: { [memberAId]: noteA, [memberBId]: noteB },
      markers: { [memberAId]: markerA, [memberBId]: markerB },
      turnOrder: [memberAId, memberBId],
      currentActorMemberId: memberAId,
      deadlineGeneration: 1,
    };
    const policy = {
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

    const client = await databasePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO next_round.instance_policy
           (version, instance_name, policy, changed_by)
         VALUES (1, 'Authorized views fixture', $1::jsonb, $2)`,
        [JSON.stringify(policy), memberA.principalId],
      );
      await client.query(
        "INSERT INTO next_round.instance_singleton (id, current_policy_version) VALUES (true, 1)",
      );
      await client.query(
        "INSERT INTO next_round.modules (id, default_version) VALUES ('test-counter', '0.1.0')",
      );
      await client.query(
        `INSERT INTO next_round.module_versions
           (module_id, version, manifest, server_hash, client_hash, sdk_contract,
            state_version, result_version)
         VALUES ('test-counter', '0.1.0', '{}'::jsonb, 'fixture-server', 'fixture-client',
                 'next-round-game/0.1', 1, 1)`,
      );
      await client.query(
        `INSERT INTO next_round.matches
           (id, module_id, module_version, state_version, mode, phase, creator_id,
            settings, visibility, policy_version, policy_snapshot, revision, state,
            needs_action_from, started_at)
         VALUES ($1, 'test-counter', '0.1.0', 1, 'group', 'active', $2,
                 $3::jsonb, 'invite', 1, $4::jsonb, 3, $5::jsonb, $6::uuid[], now())`,
        [
          matchId,
          memberA.principalId,
          JSON.stringify({ target: 10, turnSeconds: null }),
          JSON.stringify(policy),
          JSON.stringify(state),
          [memberAId],
        ],
      );
      await client.query(
        `INSERT INTO next_round.match_members
           (id, match_id, principal_id, join_ordinal)
         VALUES ($1, $3, $4, 1), ($2, $3, $5, 2)`,
        [memberAId, memberBId, matchId, memberA.principalId, memberB.principalId],
      );
      await client.query(
        "UPDATE next_round.matches SET host_member_id = $2 WHERE id = $1",
        [matchId, memberAId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    // Pool.end releases clients before their socket 'end' events. Wait for those
    // events rather than terminating a backend while its client is still closing.
    const disconnected: Array<Promise<void>> = [];
    databasePool?.on("remove", (client) => {
      disconnected.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
    await databasePool?.end();
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    await rm(staticRoot, { recursive: true, force: true });
  }, 60_000);

  async function authenticated(fixture: SessionFixture) {
    return new AuthService(databasePool, undefined, new MatchService(databasePool, registry)).authenticate(fixture.cookie.split("=", 2)[1]);
  }

  async function waitForLock(fragment: string): Promise<void> {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const result = await databasePool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (result.rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Expected database lock wait: ${fragment}`);
  }

  it("lists only authorized Home metadata and paginates tied timestamps without gaps", async () => {
    const service = new MatchService(databasePool, registry);
    const actor = await authenticated(memberA);
    const created = await service.create(actor, {
      commandId: randomUUID(), moduleId: "test-counter", mode: "group",
      settings: { target: 10, turnSeconds: null }, visibility: "instance",
    });
    await databasePool.query(
      "UPDATE next_round.matches SET created_at='2026-01-01T00:00:00.000123Z'",
    );
    const first = await app.inject({
      url: "/api/v1/matches?scope=mine&limit=1", headers: headers(memberA),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await app.inject({
      url: `/api/v1/matches?scope=mine&limit=1&cursor=${page.nextCursor}`,
      headers: headers(memberA),
    });
    const ids = [page.data[0].id, second.json().data[0].id];
    expect(ids.sort()).toEqual([matchId, created.matchId].sort());
    expect(second.json().nextCursor).toBeNull();
    expectNoPrivateValues(first.body + second.body);
    const outsiderMine = await app.inject({
      url: "/api/v1/matches?scope=mine", headers: headers(outsider),
    });
    expect(outsiderMine.json().data).toEqual([]);
    const open = await app.inject({
      url: "/api/v1/matches?scope=open", headers: headers(outsider),
    });
    expect(open.json().data.map((row: { id: string }) => row.id)).toEqual([created.matchId]);
    expectNoPrivateValues(open.body);
    await databasePool.query(
      "UPDATE next_round.match_members SET status='removed' WHERE match_id=$1 AND principal_id=$2",
      [created.matchId, memberA.principalId],
    );
    const removed = await app.inject({
      url: "/api/v1/matches?scope=open", headers: headers(memberA),
    });
    expect(removed.json().data).toEqual([]);
    const malformed = await app.inject({
      url: "/api/v1/matches?cursor=not-a-cursor", headers: headers(memberA),
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("permits an enabled nonmember admin to revoke a match link but not an outsider", async () => {
    await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/link`,
      headers: headers(memberA, true), payload: { commandId: randomUUID() },
    });
    const denied = await app.inject({
      method: "DELETE", url: `/api/v1/matches/${matchId}/link`,
      headers: headers(outsider, true), payload: {},
    });
    expect(denied.statusCode).toBe(403);
    await databasePool.query(
      "UPDATE next_round.accounts SET role='admin' WHERE principal_id=$1",
      [outsider.principalId],
    );
    const revoked = await app.inject({
      method: "DELETE", url: `/api/v1/matches/${matchId}/link`,
      headers: headers(outsider, true), payload: {},
    });
    expect(revoked.statusCode).toBe(204);
    const links = await databasePool.query(
      "SELECT revoked_at FROM next_round.match_links WHERE match_id=$1", [matchId],
    );
    expect(links.rows[0].revoked_at).toBeInstanceOf(Date);
  });

  it("authorizes host finish and replays it without another result or departed membership", async () => {
    const input = { commandId: randomUUID(), expectedRevision: 3 };
    const denied = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/finish`,
      headers: headers(memberB, true), payload: input,
    });
    expect(denied.statusCode).toBe(403);
    const accepted = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/finish`,
      headers: headers(memberA, true), payload: input,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toMatchObject({ committedRevision: 4, replayed: false });
    const replay = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/finish`,
      headers: headers(memberA, true), payload: input,
    });
    expect(replay.json().data).toMatchObject({ committedRevision: 4, replayed: true });
    const result = await app.inject({
      url: `/api/v1/matches/${matchId}/result`, headers: headers(memberB),
    });
    expect(result.statusCode).toBe(200);
    expectNoPrivateValues(result.body);
    const stored = await databasePool.query(
      "SELECT outcome,finished_revision::integer FROM next_round.match_results WHERE match_id=$1",
      [matchId],
    );
    expect(stored.rows).toEqual([{ outcome: "ended_early", finished_revision: 4 }]);
    const members = await databasePool.query(
      "SELECT status FROM next_round.match_members WHERE match_id=$1", [matchId],
    );
    expect(members.rows).toEqual([{ status: "active" }, { status: "active" }]);
  });

  it.each(["disable", "reset", "expiry", "logout"])(
    "rejects a preauthenticated action after %s wins the principal lock",
    async (change) => {
      const session = await authenticated(memberA);
      const service = new MatchService(databasePool, registry);
      const barrier = await databasePool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await barrier.query("BEGIN");
        await barrier.query("SELECT id FROM next_round.principals WHERE id = $1 FOR UPDATE", [memberA.principalId]);
        if (change === "disable") {
          await barrier.query("UPDATE next_round.principals SET disabled_at = now() WHERE id = $1", [memberA.principalId]);
        } else if (change === "reset") {
          await barrier.query("UPDATE next_round.principals SET auth_epoch = auth_epoch + 1 WHERE id = $1", [memberA.principalId]);
        } else {
          await barrier.query(
            change === "expiry"
              ? "UPDATE next_round.sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1"
              : "UPDATE next_round.sessions SET revoked_at = now() WHERE id = $1",
            [session.id],
          );
        }
        // Attach rejection handling before releasing the transaction barrier.
        pending = service.act(matchId, session, {
          commandId: randomUUID(), expectedRevision: 3, type: "add", payload: { amount: 1 },
        }).then(() => "unexpected acceptance", (error: unknown) => error);
        await waitForLock("ORDER BY id FOR UPDATE");
        await barrier.query("COMMIT");
        expect(await pending).toMatchObject({ code: change === "disable" ? "ACCOUNT_DISABLED" : "SESSION_EXPIRED" });
        await expect(new AuthService(databasePool, undefined, new MatchService(databasePool, registry)).rotateCsrf(session))
          .rejects.toMatchObject({ code: change === "disable" ? "ACCOUNT_DISABLED" : "SESSION_EXPIRED" });
        const stored = await databasePool.query("SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1", [matchId]);
        expect(stored.rows[0].revision).toBe(3);
        const receipts = await databasePool.query("SELECT 1 FROM next_round.command_receipts");
        expect(receipts.rowCount).toBe(0);
        const response = await app.inject({ url: `/api/v1/matches/${matchId}`, headers: headers(memberA) });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        await barrier.query("ROLLBACK");
        barrier.release();
        await pending;
      }
    }, 120_000,
  );

  it.each(["disable", "reset"])("lets an action that owns the principal lock finish before %s", async (change) => {
    await databasePool.query("UPDATE next_round.accounts SET role = 'admin' WHERE principal_id = $1", [memberB.principalId]);
    const auth = new AuthService(databasePool, undefined, new MatchService(databasePool, registry));
    const session = await authenticated(memberA);
    const admin = await authenticated(memberB);
    const barrier = await databasePool.connect();
    const commandId = randomUUID();
    let action: Promise<unknown> | undefined;
    let disable: Promise<unknown> | undefined;
    try {
      await barrier.query("BEGIN");
      await barrier.query("SELECT id FROM next_round.matches WHERE id = $1 FOR UPDATE", [matchId]);
      action = new MatchService(databasePool, registry).act(matchId, session, {
        commandId, expectedRevision: 3, type: "add", payload: { amount: 1 },
      }).then((value) => value, (error: unknown) => error);
      await waitForLock("FOR UPDATE OF m, viewer");
      // Reset routes are a later H1 deliverable. Exercise the required auth-epoch
      // writer protocol on a real connection, without claiming a reset endpoint.
      const reset = async () => {
        const client = await databasePool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM next_round.principals WHERE id = $1 ORDER BY id FOR UPDATE", [memberA.principalId]);
          await client.query("UPDATE next_round.principals SET auth_epoch = auth_epoch + 1 WHERE id = $1", [memberA.principalId]);
          await client.query("COMMIT");
          return { id: memberA.principalId };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      disable = (change === "disable" ? auth.setUserDisabled(admin, memberA.principalId, true) : reset())
        .then((value) => value, (error: unknown) => error);
      await waitForLock("ORDER BY id FOR UPDATE");
      await barrier.query("COMMIT");
      expect(await action).toMatchObject({ committedRevision: 4 });
      expect(await disable).toMatchObject({ id: memberA.principalId });
      await expect(new MatchService(databasePool, registry).act(matchId, session, {
        commandId, expectedRevision: 3, type: "add", payload: { amount: 1 },
      })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    } finally {
      await barrier.query("ROLLBACK");
      barrier.release();
      await Promise.allSettled([action, disable]);
    }
  }, 120_000);

  it("rechecks administrator permission rather than trusting a preauthenticated session", async () => {
    await databasePool.query("UPDATE next_round.accounts SET role = 'admin' WHERE principal_id = $1", [memberB.principalId]);
    const admin = await authenticated(memberB);
    await databasePool.query("UPDATE next_round.accounts SET role = 'member' WHERE principal_id = $1", [memberB.principalId]);
    await expect(new AuthService(databasePool, undefined, new MatchService(databasePool, registry)).setUserDisabled(admin, memberA.principalId, true))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a revision-zero lobby atomically and replays an exact create receipt", async () => {
    const commandId = randomUUID();
    const payload = {
      commandId,
      moduleId: "test-counter",
      mode: "group",
      settings: { target: 10, turnSeconds: null },
      visibility: "invite",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(memberA, true),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const created = first.json().data;
    expect(created).toMatchObject({ revision: 0, commandId });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(memberA, true),
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data).toEqual(created);

    const rows = await databasePool.query(
      `SELECT m.phase, m.revision::integer AS revision, m.host_member_id,
              (SELECT count(*)::integer FROM next_round.match_members mm WHERE mm.match_id = m.id) AS members,
              (SELECT count(*)::integer FROM next_round.match_events e WHERE e.match_id = m.id) AS events,
              (SELECT count(*)::integer FROM next_round.command_receipts r WHERE r.match_id = m.id) AS receipts
         FROM next_round.matches m WHERE m.id = $1`,
      [created.matchId],
    );
    expect(rows.rows[0]).toMatchObject({ phase: "lobby", revision: 0, members: 1, events: 1, receipts: 1 });
    expect(rows.rows[0].host_member_id).toBeTruthy();

    const conflicting = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(memberA, true),
      payload: { ...payload, mode: "solo" },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("joins, starts, leaves, and rejoins through revisioned lifecycle receipts", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "test-counter",
        mode: "group",
        settings: { target: 10, turnSeconds: 30 },
        visibility: "instance",
      },
    });
    expect(created.statusCode).toBe(201);
    const matchId = created.json().data.matchId as string;

    const joinCommand = { commandId: randomUUID(), expectedRevision: 0 };
    const joined = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/join`,
      headers: headers(memberB, true),
      payload: joinCommand,
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().data).toMatchObject({ committedRevision: 1, replayed: false });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/join`,
      headers: headers(memberB, true),
      payload: joinCommand,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({ committedRevision: 1, replayed: true });

    const nonHostStart = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/start`,
      headers: headers(memberB, true),
      payload: { commandId: randomUUID(), expectedRevision: 1 },
    });
    expect(nonHostStart.statusCode).toBe(403);

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/start`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: 1 },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().data).toMatchObject({ committedRevision: 2, replayed: false });

    const left = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/leave`,
      headers: headers(memberB, true),
      payload: { commandId: randomUUID(), expectedRevision: 2 },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json().data).toMatchObject({ committedRevision: 3, replayed: false });
    expect((await app.inject({ url: `/api/v1/matches/${matchId}`, headers: headers(memberB) })).statusCode).toBe(404);

    const rejoined = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/join`,
      headers: headers(memberB, true),
      payload: { commandId: randomUUID(), expectedRevision: 3 },
    });
    expect(rejoined.statusCode).toBe(200);
    expect(rejoined.json().data).toMatchObject({ committedRevision: 4, replayed: false });
    expect((await app.inject({ url: `/api/v1/matches/${matchId}`, headers: headers(memberB) })).statusCode).toBe(200);
    const periods = await databasePool.query(
      `SELECT mp.access_epoch::integer AS access_epoch, mp.departed_at IS NOT NULL AS departed
         FROM next_round.member_periods mp
         JOIN next_round.match_members mm ON mm.id = mp.member_id
        WHERE mm.match_id = $1 AND mm.principal_id = $2
        ORDER BY mp.access_epoch`,
      [matchId, memberB.principalId],
    );
    expect(periods.rows).toEqual([
      { access_epoch: 0, departed: true },
      { access_epoch: 1, departed: false },
    ]);
  });

  it("requires registration for catalog/schema routes and confines guests to their pinned manifest", async () => {
    expect((await app.inject("/api/v1/games")).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/games", headers: headers(memberA) })).statusCode).toBe(200);
    // Convert the fixture identity without changing its session or membership.
    await databasePool.query("DELETE FROM next_round.accounts WHERE principal_id = $1", [memberA.principalId]);
    await databasePool.query("UPDATE next_round.principals SET kind = 'guest', guest_match_id = $2 WHERE id = $1", [memberA.principalId, matchId]);
    for (const url of ["/api/v1/games", "/api/v1/games/test-counter", "/api/v1/games/test-counter?version=0.2.0", "/api/v1/games/another-game?version=0.1.0"]) {
      expect((await app.inject({ url, headers: headers(memberA) })).statusCode).toBe(403);
    }
    const pinned = await app.inject({ url: "/api/v1/games/test-counter?version=0.1.0", headers: headers(memberA) });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.headers["cache-control"]).toBe("no-store");
    for (const route of ["settings", "actions"]) {
      const response = await app.inject({ method: "POST", url: `/api/v1/games/test-counter/${route}`, headers: headers(memberA, true), payload: {} });
      expect(response.statusCode).toBe(403);
    }
    await databasePool.query("UPDATE next_round.match_members SET status = 'left', departed_at = now() WHERE id = $1", [memberAId]);
    expect((await app.inject({ url: "/api/v1/games/test-counter?version=0.1.0", headers: headers(memberA) })).statusCode).toBe(403);
  });

  it("serves private reducer views, denies outsiders and raw state, and projects finished results", async () => {
    const snapshotA = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(memberA),
    });
    expect(snapshotA.statusCode).toBe(200);
    expect(snapshotA.headers["cache-control"]).toBe("no-store");
    expect(snapshotA.json().data.game).toMatchObject({
      myMarker: markerA,
      myNote: noteA,
      myScore: 1,
    });
    expect(snapshotA.body).not.toContain(markerB);
    expect(snapshotA.body).not.toContain(noteB);
    expect(snapshotA.body).not.toContain(serverFixtureSecret);

    const snapshotB = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(memberB),
    });
    expect(snapshotB.statusCode).toBe(200);
    expect(snapshotB.json().data.game).toMatchObject({
      myMarker: markerB,
      myNote: noteB,
      myScore: 1,
    });
    expect(snapshotB.body).not.toContain(markerA);
    expect(snapshotB.body).not.toContain(noteA);
    expect(snapshotB.body).not.toContain(serverFixtureSecret);

    const outsiderSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(outsider),
    });
    expect(outsiderSnapshot.statusCode).toBe(404);
    expectNoPrivateValues(outsiderSnapshot.body);

    const outsiderAction = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(outsider, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 3,
        type: "note",
        payload: { text: rejectedGuess },
      },
    });
    expect(outsiderAction.statusCode).toBe(404);
    expectNoPrivateValues(outsiderAction.body);

    const invalidAction = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 3,
        type: "note",
        payload: { text: "valid note", guess: rejectedGuess },
      },
    });
    expect(invalidAction.statusCode).toBe(400);
    expect(invalidAction.json().error).toMatchObject({ code: "INVALID_REQUEST" });
    expectNoPrivateValues(invalidAction.body);

    const rejectedAction = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberB, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 3,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(rejectedAction.statusCode).toBe(422);
    expect(rejectedAction.json().error).toMatchObject({
      code: "RULE_REJECTED",
      details: { ruleCode: "test-counter/RULE_REJECTED" },
    });
    expectNoPrivateValues(rejectedAction.body);

    const acceptedPrivateAction = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 3,
        type: "note",
        payload: { text: rejectedGuess },
      },
    });
    expect(acceptedPrivateAction.statusCode).toBe(200);
    expect(acceptedPrivateAction.json().data).toMatchObject({
      committedRevision: 4,
      replayed: false,
      outcome: "accepted",
    });
    expectNoPrivateValues(acceptedPrivateAction.body);

    const privateViewA = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(memberA),
    });
    expect(privateViewA.statusCode).toBe(200);
    expect(privateViewA.json().data.game.myNote).toBe(rejectedGuess);

    const privateViewB = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(memberB),
    });
    expect(privateViewB.statusCode).toBe(200);
    expect(privateViewB.body).not.toContain(rejectedGuess);

    const actionEvent = await databasePool.query<{ safe_metadata: { type: string } }>(
      `SELECT safe_metadata
         FROM next_round.match_events
        WHERE match_id = $1 AND revision = 4`,
      [matchId],
    );
    expect(actionEvent.rows[0]?.safe_metadata).toEqual({ type: "note" });
    expect(JSON.stringify(actionEvent.rows)).not.toContain(rejectedGuess);

    const rawState = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}/state`,
      headers: headers(memberA),
    });
    expect(rawState.statusCode).toBe(404);
    expectNoPrivateValues(rawState.body);

    const finalResult = {
      outcome: "completed",
      data: { count: 7, target: 10, winners: [memberAId] },
      participants: [
        {
          memberId: memberAId,
          score: 4,
          contribution: { actionsTaken: 4, mode: "group" },
          win: true,
          careerEligible: true,
          exclusionReasons: [],
        },
        {
          memberId: memberBId,
          score: 3,
          contribution: { actionsTaken: 3, mode: "group" },
          win: false,
          careerEligible: true,
          exclusionReasons: [],
        },
      ],
    };
    const privateFinishedState = {
      count: 99,
      target: 100,
      turnSeconds: null,
      scores: { [memberAId]: 50, [memberBId]: 49 },
      notes: { [memberAId]: rejectedGuess, [memberBId]: noteB },
      markers: { [memberAId]: markerA, [memberBId]: markerB },
      turnOrder: [memberAId, memberBId],
      currentActorMemberId: null,
      deadlineGeneration: 9,
    };
    const resultClient = await databasePool.connect();
    try {
      await resultClient.query("BEGIN");
      await resultClient.query(
        `UPDATE next_round.matches
            SET phase = 'finished', revision = 5, state = $2::jsonb,
                finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [matchId, JSON.stringify(privateFinishedState)],
      );
      await resultClient.query(
        `UPDATE next_round.match_members
            SET status = 'left', departed_at = now()
          WHERE id = $1`,
        [memberBId],
      );
      await resultClient.query(
        `INSERT INTO next_round.match_results
           (match_id, module_id, module_version, result_version, outcome, raw_result,
            eligibility_reasons, finished_revision, finished_at)
         VALUES ($1, 'test-counter', '0.1.0', 1, 'completed', $2::jsonb,
                 '[]'::jsonb, 5, now())`,
        [matchId, JSON.stringify(finalResult)],
      );
      await resultClient.query("COMMIT");
    } catch (error) {
      await resultClient.query("ROLLBACK");
      throw error;
    } finally {
      resultClient.release();
    }

    const departedSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(memberB),
    });
    expect(departedSnapshot.statusCode).toBe(404);
    expectNoPrivateValues(departedSnapshot.body);

    const projectedResult = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}/result`,
      headers: headers(memberB),
    });
    expect(projectedResult.statusCode).toBe(200);
    expect(projectedResult.headers["cache-control"]).toBe("no-store");
    expect(projectedResult.json().data).toEqual({
      outcome: "completed",
      data: { count: 7, target: 10, winners: [memberAId] },
      participants: [
        { memberId: memberAId, score: 4, win: true, careerEligible: true },
        { memberId: memberBId, score: 3, win: false, careerEligible: true },
      ],
    });
    expectNoPrivateValues(projectedResult.body);

    const outsiderResult = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}/result`,
      headers: headers(outsider),
    });
    expect(outsiderResult.statusCode).toBe(404);
    expectNoPrivateValues(outsiderResult.body);
  }, 120_000);

  it("retries an identical score command and rejects a conflicting body", async () => {
    const commandId = randomUUID();
    const scoreBody = {
      commandId,
      expectedRevision: 3,
      type: "add",
      payload: { amount: 1 },
    };
    const conflictingNote = "conflicting-score-body";
    const committed = {
      revision: 4,
      score: 2,
      count: 3,
      note: noteA,
      events: 1,
      receipts: 1,
    };

    async function persisted() {
      const match = await databasePool.query<{
        revision: number;
        state: {
          count: number;
          scores: Record<string, number>;
          notes: Record<string, string>;
        };
      }>(
        `SELECT revision::integer AS revision, state
           FROM next_round.matches
          WHERE id = $1`,
        [matchId],
      );
      const effects = await databasePool.query<{ events: number; receipts: number }>(
        `SELECT
           (SELECT count(*)::integer FROM next_round.match_events WHERE match_id = $1) AS events,
           (SELECT count(*)::integer FROM next_round.command_receipts WHERE match_id = $1) AS receipts`,
        [matchId],
      );
      const row = match.rows[0];
      return {
        revision: row.revision,
        score: row.state.scores[memberAId],
        count: row.state.count,
        note: row.state.notes[memberAId],
        events: effects.rows[0].events,
        receipts: effects.rows[0].receipts,
      };
    }

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: scoreBody,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    const receipt = {
      commandId,
      matchId,
      committedRevision: 4,
      replayed: false,
      outcome: "accepted",
    };
    expect(accepted.json().data).toEqual(receipt);
    expectNoPrivateValues(accepted.body);
    const scored = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(memberA),
    });
    expect(scored.json().data.revision).toBe(4);
    expect(scored.json().data.game).toMatchObject({ myScore: 2, count: 3 });
    expect(await persisted()).toEqual(committed);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: scoreBody,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual({ ...receipt, replayed: true });
    expectNoPrivateValues(replay.body);
    expect(await persisted()).toEqual(committed);

    for (const requestMatchId of [matchId, matchId.toUpperCase()]) {
      const caseReplay = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${requestMatchId}/actions`,
        headers: headers(memberA, true),
        payload: { ...scoreBody, commandId: commandId.toUpperCase() },
      });
      expect(caseReplay.statusCode).toBe(200);
      expect(caseReplay.json().data).toEqual({ ...receipt, replayed: true });
      expect(await persisted()).toEqual(committed);
    }

    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: {
        commandId,
        expectedRevision: 4,
        type: "note",
        payload: { text: conflictingNote },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(conflict.body).not.toContain(conflictingNote);
    expectNoPrivateValues(conflict.body);
    expect(await persisted()).toEqual(committed);

    const stored = await databasePool.query<{ safe_receipt: Record<string, unknown> }>(
      `SELECT safe_receipt FROM next_round.command_receipts WHERE match_id = $1`,
      [matchId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].safe_receipt).toEqual(receipt);

    await databasePool.query(
      `UPDATE next_round.match_members
          SET status = 'left', departed_at = now()
        WHERE id = $1`,
      [memberAId],
    );
    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: scoreBody,
    });
    expect(revoked.statusCode).toBe(404);
    expectNoPrivateValues(revoked.body);
    expect(await persisted()).toEqual(committed);
  }, 120_000);

  it("overlaps two sessions at one revision and commits exactly one transition", async () => {
    const device = await seedDevice(memberA.principalId);
    expect(device.principalId).toBe(memberA.principalId);
    expect(device.cookie).not.toBe(memberA.cookie);
    const expectedRevision = 3;
    const firstCommand = randomUUID();
    const secondCommand = randomUUID();
    const action = (commandId: string) => ({
      commandId,
      expectedRevision,
      type: "add",
      payload: { amount: 1 },
    });
    const races = [
      { session: memberA, commandId: firstCommand },
      { session: device, commandId: secondCommand },
    ];
    let settled = 0;
    const barrier = await databasePool.connect();
    let released = false;
    try {
      await barrier.query("BEGIN");
      const barrierPid = await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      // The barrier only forces both requests into the action path's row lock.
      // Serialization still comes from that FOR UPDATE, not from this connection.
      await barrier.query("SELECT id FROM next_round.matches WHERE id = $1 FOR UPDATE", [matchId]);
      const pending = races.map((race) => app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/actions`,
        headers: headers(race.session, true),
        payload: action(race.commandId),
      }).then((response) => {
        settled += 1;
        return { ...race, response };
      }));
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const observed = await databasePool.query<{ waiting: number }>(
          `SELECT count(*)::integer AS waiting
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND pid <> $1
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND (query LIKE '%FOR UPDATE OF m, viewer%'
                OR query LIKE '%ORDER BY id FOR UPDATE%')`,
          [barrierPid.rows[0].pid],
        );
        waiting = observed.rows[0].waiting;
        if (waiting === 2 && settled === 0) break;
        // Yield so the waiting backends can appear. Fake timers cannot advance a
        // PostgreSQL lock, and a fixed sleep would not observe the waiters.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (waiting !== 2 || settled !== 0) {
        const activity = await databasePool.query(
          `SELECT pid, state, wait_event_type, wait_event, left(query, 180) AS query
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()`,
        );
        await barrier.query("COMMIT");
        released = true;
        await Promise.allSettled(pending);
        throw new Error(
          `F1-05 overlap was not observed (waiting=${waiting}, settled=${settled}): ${JSON.stringify(activity.rows)}`,
        );
      }
      await barrier.query("COMMIT");
      released = true;
      const results = await Promise.all(pending);
      const accepted = results.filter((result) => result.response.statusCode === 200);
      const rejected = results.filter((result) => result.response.statusCode === 409);
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const winner = accepted[0];
      const loser = rejected[0];
      expect(winner.response.headers["cache-control"]).toBe("no-store");
      expect(winner.response.json().data).toEqual({
        commandId: winner.commandId,
        matchId,
        committedRevision: 4,
        replayed: false,
        outcome: "accepted",
      });
      expect(loser.response.statusCode).toBe(409);
      expect(loser.response.json().error).toMatchObject({
        code: "STALE_REVISION",
        message: "Refresh this match before acting.",
        details: { currentRevision: 4 },
      });
      expect(Object.keys(loser.response.json().error.details as Record<string, unknown>)).toEqual([
        "currentRevision",
      ]);
      expectNoPrivateValues(winner.response.body);
      expectNoPrivateValues(loser.response.body);

      const stored = await databasePool.query<{
        revision: number;
        count: number;
        score: number;
        otherScore: number;
        note: string;
        actor: string | null;
        events: number;
        receipts: number;
        winnerReceipts: number;
        loserReceipts: number;
      }>(
        `SELECT m.revision::integer AS revision,
                (m.state->>'count')::integer AS count,
                (m.state->'scores'->>$2)::integer AS score,
                (m.state->'scores'->>$3)::integer AS "otherScore",
                m.state->'notes'->>$2 AS note,
                (SELECT min(e.actor_id::text) FROM next_round.match_events e
                  WHERE e.match_id = m.id) AS actor,
                (SELECT count(*)::integer FROM next_round.match_events e
                  WHERE e.match_id = m.id) AS events,
                (SELECT count(*)::integer FROM next_round.command_receipts r
                  WHERE r.match_id = m.id) AS receipts,
                (SELECT count(*)::integer FROM next_round.command_receipts r
                  WHERE r.match_id = m.id AND r.command_id = $4) AS "winnerReceipts",
                (SELECT count(*)::integer FROM next_round.command_receipts r
                  WHERE r.match_id = m.id AND r.command_id = $5) AS "loserReceipts"
           FROM next_round.matches m
          WHERE m.id = $1`,
        [matchId, memberAId, memberBId, winner.commandId, loser.commandId],
      );
      expect(stored.rows[0]).toEqual({
        revision: 4,
        count: 3,
        score: 2,
        otherScore: 1,
        note: noteA,
        actor: memberA.principalId,
        events: 1,
        receipts: 1,
        winnerReceipts: 1,
        loserReceipts: 0,
      });

      const refreshed = await app.inject({
        method: "GET",
        url: `/api/v1/matches/${matchId}`,
        headers: headers(loser.session),
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.headers["cache-control"]).toBe("no-store");
      expect(refreshed.json().data.revision).toBe(4);
      expect(refreshed.json().data.game).toMatchObject({
        count: 3,
        myScore: 2,
        myNote: noteA,
        myMarker: markerA,
        currentActorMemberId: memberBId,
      });
      expect(refreshed.body).not.toContain(markerB);
      expect(refreshed.body).not.toContain(noteB);
    } finally {
      if (!released) await barrier.query("ROLLBACK");
      barrier.release();
    }
  }, 120_000);

  async function prepareCompletion(): Promise<void> {
    await databasePool.query(
      `UPDATE next_round.matches SET state = jsonb_set(state, '{target}', '3'::jsonb),
         settings = jsonb_set(settings, '{target}', '3'::jsonb) WHERE id = $1`,
      [matchId],
    );
    await databasePool.query(
      `INSERT INTO next_round.match_deadlines (match_id, key, generation, due_at, status, event_id)
       VALUES ($1, 'turn', 1, now() + interval '1 hour', 'pending', $2)`,
      [matchId, randomUUID()],
    );
  }

  async function finalLedger() {
    const match = await databasePool.query(
      `SELECT phase, revision::integer AS revision, state,
         (SELECT count(*)::integer FROM next_round.match_results WHERE match_id = m.id) AS results,
         (SELECT count(*)::integer FROM next_round.match_events WHERE match_id = m.id) AS events,
         (SELECT count(*)::integer FROM next_round.command_receipts WHERE match_id = m.id) AS receipts,
         (SELECT status FROM next_round.match_deadlines WHERE match_id = m.id AND key = 'turn' AND generation = 1) AS deadline
       FROM next_round.matches m WHERE id = $1`, [matchId],
    );
    const participants = await databasePool.query(
      `SELECT member_id, principal_id, score, contribution, win, career_eligible,
              exclusion_reasons, display_name_snapshot
       FROM next_round.participant_results WHERE match_id = $1 ORDER BY display_name_snapshot`, [matchId],
    );
    const career = await databasePool.query(
      `SELECT principal_id, module_id, metric_version, points::integer, played::integer,
              wins::integer, visibility
       FROM next_round.career_contributions WHERE match_id = $1 ORDER BY principal_id`, [matchId],
    );
    return { match: match.rows[0], participants: participants.rows, career: career.rows };
  }

  it("F1-06 serializes final actions and replays without another result or win", async () => {
    await prepareCompletion();
    // A later default-policy change must not rewrite this match's owner-only stats.
    await databasePool.query(
      `UPDATE next_round.instance_policy SET policy = jsonb_set(policy, '{statsVisibility}', '"instance"'::jsonb)`,
    );
    const device = await seedDevice(memberA.principalId);
    const commands = [memberA, device].map((session) => ({
      session, payload: { commandId: randomUUID(), expectedRevision: 3, type: "add", payload: { amount: 1 } },
    }));
    const barrier = await databasePool.connect();
    let pending: Array<Promise<{
      status: number; body: { error: { code: string } }; command: typeof commands[number];
    }>> = [];
    try {
      await barrier.query("BEGIN");
      await barrier.query("SELECT id FROM next_round.matches WHERE id = $1 FOR UPDATE", [matchId]);
      pending = commands.map(async (command) => {
        const response = await app.inject({
          method: "POST", url: `/api/v1/matches/${matchId}/actions`,
          headers: headers(command.session, true), payload: command.payload,
        });
        return { status: response.statusCode, body: response.json(), command };
      });
      const until = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < until) {
        const locks = await databasePool.query(
          `SELECT count(*)::integer AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND (query LIKE '%FOR UPDATE OF m, viewer%' OR query LIKE '%ORDER BY id FOR UPDATE%')`,
        );
        waiting = locks.rows[0].waiting;
        if (waiting === 2) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(waiting).toBe(2);
      await barrier.query("COMMIT");
      const results = await Promise.all(pending);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const winner = results.find((result) => result.status === 200)!;
      expect(results.find((result) => result.status === 409)!.body.error.code).toBe("STALE_REVISION");
      const ledger = await finalLedger();
      expect(ledger.match).toMatchObject({
        phase: "finished", revision: 4, results: 1, events: 1, receipts: 1, deadline: "cancelled",
        state: { count: 3, scores: { [memberAId]: 2, [memberBId]: 1 } },
      });
      expect(ledger.participants).toEqual([
        { member_id: memberAId, principal_id: memberA.principalId, score: 2,
          contribution: { actionsTaken: 2, mode: "group" }, win: true, career_eligible: true,
          exclusion_reasons: [], display_name_snapshot: "Member A" },
        { member_id: memberBId, principal_id: memberB.principalId, score: 1,
          contribution: { actionsTaken: 1, mode: "group" }, win: false, career_eligible: true,
          exclusion_reasons: [], display_name_snapshot: "Member B" },
      ]);
      expect(ledger.career).toEqual([
        { principal_id: memberA.principalId, module_id: "test-counter", metric_version: 1,
          points: 2, played: 1, wins: 1, visibility: "owner" },
        { principal_id: memberB.principalId, module_id: "test-counter", metric_version: 1,
          points: 1, played: 1, wins: 0, visibility: "owner" },
      ].sort((a, b) => a.principal_id.localeCompare(b.principal_id)));
      const raw = await databasePool.query(
        "SELECT raw_result, finished_revision::integer AS revision, eligibility_reasons FROM next_round.match_results WHERE match_id = $1", [matchId],
      );
      expect(raw.rows[0]).toMatchObject({
        revision: 4, eligibility_reasons: [],
        raw_result: { outcome: "completed", data: { count: 3, target: 3, winners: [memberAId] } },
      });
      const replay = await app.inject({
        method: "POST", url: `/api/v1/matches/${matchId}/actions`,
        headers: headers(winner.command.session, true), payload: winner.command.payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data).toMatchObject({ committedRevision: 4, replayed: true });
      expect(await finalLedger()).toEqual(ledger);
    } finally {
      await barrier.query("ROLLBACK");
      barrier.release();
      await Promise.allSettled(pending);
    }
  }, 120_000);

  it("F1-06 rolls back every final effect on commit failure, then accepts the identical retry once", async () => {
    await prepareCompletion();
    const before = await finalLedger();
    await databasePool.query(`
      CREATE FUNCTION next_round.fail_final_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM next_round.match_results WHERE match_id = NEW.match_id)
           AND (SELECT count(*) FROM next_round.participant_results WHERE match_id = NEW.match_id) = 2
           AND (SELECT count(*) FROM next_round.career_contributions WHERE match_id = NEW.match_id) = 2 THEN
          RAISE EXCEPTION 'test-only final commit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER fail_final_commit AFTER INSERT ON next_round.command_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION next_round.fail_final_commit();
    `);
    const payload = { commandId: randomUUID(), expectedRevision: 3, type: "add", payload: { amount: 1 } };
    const failed = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/actions`, headers: headers(memberA, true), payload,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe("INTERNAL_ERROR");
    expect(failed.body).not.toContain("test-only");
    expect(await finalLedger()).toEqual(before);
    await databasePool.query("DROP TRIGGER fail_final_commit ON next_round.command_receipts; DROP FUNCTION next_round.fail_final_commit()");
    const accepted = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/actions`, headers: headers(memberA, true), payload,
    });
    expect(accepted.statusCode).toBe(200);
    const committed = await finalLedger();
    expect(committed.match).toMatchObject({ phase: "finished", revision: 4, results: 1, receipts: 1 });
    expect(committed.career.map((row) => row.wins).sort()).toEqual([0, 1]);
    const retry = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/actions`, headers: headers(memberA, true), payload,
    });
    expect(retry.json().data.replayed).toBe(true);
    expect(await finalLedger()).toEqual(committed);
  }, 120_000);

  it("F1-06 retains guest attribution without excluding the registered player's career credit", async () => {
    await prepareCompletion();
    await databasePool.query("DELETE FROM next_round.accounts WHERE principal_id = $1", [memberB.principalId]);
    await databasePool.query(
      "UPDATE next_round.principals SET kind = 'guest', guest_match_id = $2 WHERE id = $1",
      [memberB.principalId, matchId],
    );
    const response = await app.inject({
      method: "POST", url: `/api/v1/matches/${matchId}/actions`, headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: 3, type: "add", payload: { amount: 1 } },
    });
    expect(response.statusCode).toBe(200);
    const ledger = await finalLedger();
    expect(ledger.participants[1]).toMatchObject({
      principal_id: memberB.principalId, score: 1, career_eligible: false, exclusion_reasons: ["guest_player"],
    });
    expect(ledger.career).toEqual([{
      principal_id: memberA.principalId, module_id: "test-counter", metric_version: 1,
      points: 2, played: 1, wins: 1, visibility: "owner",
    }]);
    const raw = await databasePool.query(
      "SELECT eligibility_reasons FROM next_round.match_results WHERE match_id = $1", [matchId],
    );
    expect(raw.rows[0].eligibility_reasons).toEqual([]);
  }, 120_000);

  it("F1-06 projects the final leave and replays after membership access is revoked", async () => {
    const service = new MatchService(databasePool, registry);
    await service.leave(matchId, await authenticated(memberB), { commandId: randomUUID(), expectedRevision: 3 });
    const command = { commandId: randomUUID(), expectedRevision: 4 };
    const session = await authenticated(memberA);
    expect(await service.leave(matchId, session, command)).toMatchObject({ committedRevision: 5, replayed: false });
    const ledger = await finalLedger();
    expect(ledger.match).toMatchObject({ phase: "finished", revision: 5, results: 1 });
    expect(ledger.participants.map((row) => ({ score: row.score, win: row.win }))).toEqual([
      { score: 1, win: false }, { score: 1, win: false },
    ]);
    expect(ledger.career.map((row) => ({ points: row.points, played: row.played, wins: row.wins }))).toEqual([
      { points: 1, played: 1, wins: 0 }, { points: 1, played: 1, wins: 0 },
    ]);
    expect(await service.leave(matchId, session, command)).toMatchObject({ committedRevision: 5, replayed: true });
    expect(await finalLedger()).toEqual(ledger);
  }, 120_000);

  it.each(["unknown participant", "duplicate participant", "missing participant", "bad data", "missing final",
    "early final", "negative metrics", "duplicate metrics", "missing metrics", "ineligible metrics"])(
    "F1-06 rejects %s without persisting partial results", async (fault) => {
      await prepareCompletion();
      const before = await finalLedger();
      const registered = registry.getVersion("test-counter", "0.1.0")!;
      const original = registered.server!;
      registered.server = {
        ...original,
        transition(ctx, state, event) {
          const result = original.transition(ctx, state, event);
          if (!result.ok || !result.value.final) return result;
          const final = result.value.final;
          if (fault === "unknown participant") final.participants[0].memberId = randomUUID();
          if (fault === "duplicate participant") final.participants.push(final.participants[0]);
          if (fault === "missing participant") final.participants.pop();
          if (fault === "bad data") final.data = { count: "private-invalid-value" };
          if (fault === "missing final") result.value.final = null;
          if (fault === "early final") result.value.phase = "active";
          if (fault === "ineligible metrics") final.participants[0].careerEligible = false;
          return result;
        },
        career(final) {
          const metrics = original.career(final);
          if (fault === "negative metrics") metrics[0].points = -1;
          if (fault === "duplicate metrics") metrics.push(metrics[0]);
          if (fault === "missing metrics") metrics.pop();
          if (fault === "ineligible metrics") metrics.push({ memberId: memberAId, points: 2, played: 1, wins: 1 });
          return metrics;
        },
      };
      const response = await app.inject({
        method: "POST", url: `/api/v1/matches/${matchId}/actions`, headers: headers(memberA, true),
        payload: { commandId: randomUUID(), expectedRevision: 3, type: "add", payload: { amount: 1 } },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe("MODULE_FAILURE");
      expect(response.body).not.toContain("private-invalid-value");
      expect(await finalLedger()).toEqual(before);
    }, 120_000,
  );
});
