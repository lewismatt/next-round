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

  async function authenticated(fixture: SessionFixture) {
    return new AuthService(databasePool, undefined).authenticate(fixture.cookie.split("=", 2)[1]);
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
        await expect(new AuthService(databasePool, undefined).rotateCsrf(session))
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
    const auth = new AuthService(databasePool, undefined);
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
    await expect(new AuthService(databasePool, undefined).setUserDisabled(admin, memberA.principalId, true))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
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

    const subscribe = await app.inject({
      method: "GET",
      url: "/api/v1/live",
      headers: headers(outsider),
    });
    expect(subscribe.statusCode).toBe(404);
    expectNoPrivateValues(subscribe.body);

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
});
