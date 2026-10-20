// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Json } from "@next-round/contracts";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { manifest as counterManifest } from "@next-round/game-test-counter/manifest";
import { server as counterServer } from "@next-round/game-test-counter/server";
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

function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe.skipIf(!testDatabaseUrl)("F1-07 deadline semantics and durable effects", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRoot: string;
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

  async function createAndStartMatch(options: {
    target?: number;
    turnSeconds?: number | null;
  } = {}): Promise<{ matchId: string; revision: number }> {
    const target = options.target ?? 10;
    const turnSeconds = options.turnSeconds ?? 60;
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "test-counter",
        mode: "group",
        visibility: "instance",
        settings: { target, turnSeconds },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const body = createRes.json() as { data: { matchId: string } };
    const matchId = body.data.matchId;

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/join`,
      headers: headers(memberB, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 0,
      },
    });
    expect(joinRes.statusCode).toBe(200);

    const startRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/start`,
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 1,
      },
    });
    expect(startRes.statusCode).toBe(200);

    return { matchId, revision: 2 };
  }

  beforeEach(async () => {
    databaseName = `next_round_deadlines_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    await migrateDatabase({ connectionString: url.toString() });
    databasePool = createDatabasePool({ connectionString: url.toString(), max: 8 });

    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-deadlines-"));
    await writeFile(path.join(staticRoot, "client.js"), "export const clientFixture = true;\n");

    registry = new GameRegistry();
    registry.register(counterManifest, counterServer, {
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
         VALUES (1, 'Deadlines fixture policy', $1::jsonb, $2)`,
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
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    const disconnected: Array<Promise<void>> = [];
    databasePool?.on("remove", (client) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      client.once("end", () => resolve());
      disconnected.push(promise);
    });
    await databasePool?.end();
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    await rm(staticRoot, { recursive: true, force: true });
  }, 60_000);

  it("F1-07 races worker and action at due deadline: serialized database time yields one timeout, STALE_REVISION, and no backdated action", async () => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 30 });

    // Mark deadline 1 overdue
    await databasePool.query(
      `UPDATE next_round.match_deadlines
          SET due_at = now() - interval '5 seconds'
        WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    );

    const deadlineRow = (await databasePool.query<{ event_id: string }>(
      `SELECT event_id FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    )).rows[0];

    const matchService = new MatchService(databasePool, registry);
    const barrier = await databasePool.connect();

    try {
      await barrier.query("BEGIN");
      const barrierPid = (await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await barrier.query("SELECT id FROM next_round.matches WHERE id = $1 FOR UPDATE", [matchId]);

      // Worker executes processDeadline
      const workerPromise = matchService.processDeadline({
        matchId,
        key: "turn",
        generation: 1,
      });

      // Member A attempts to take the expired turn concurrently
      const actionCommandId = randomUUID();
      let actionSettled = false;
      const actionPromise = app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/actions`,
        headers: headers(memberA, true),
        payload: {
          commandId: actionCommandId,
          expectedRevision: revision,
          type: "add",
          payload: { amount: 1 },
        },
      }).then((res) => {
        actionSettled = true;
        return res;
      });

      // Deterministic gate: wait until both transactions are queued for locks across principal or match locks
      const until = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < until) {
        const result = await databasePool.query<{ waiting: number }>(
          `SELECT count(*)::integer AS waiting
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND pid <> $1
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND (query LIKE '%FOR UPDATE%' OR query LIKE '%ORDER BY id FOR UPDATE%' OR query LIKE '%principals%')`,
          [barrierPid],
        );
        waiting = result.rows[0]?.waiting ?? 0;
        if (waiting >= 2) break;
        await nextTick();
      }
      expect(waiting).toBe(2);
      expect(actionSettled).toBe(false);

      // Release the barrier to resolve the race under PostgreSQL serialized lock order
      await barrier.query("COMMIT");

      const [appliedCount, actionRes] = await Promise.all([workerPromise, actionPromise]);

      // 1. The action must be rejected with STALE_REVISION; expired action cannot backdate itself
      expect(actionRes.statusCode).toBe(409);
      const actionBody = actionRes.json() as { error: { code: string } };
      expect(actionBody.error.code).toBe("STALE_REVISION");

      // 2. Either worker reconciled the deadline (appliedCount=1) or action step 4 reconciled it first (appliedCount=0)
      expect([0, 1]).toContain(appliedCount);

      // 3. Exactly one timeout generation persisted
      const matchRow = (await databasePool.query<{ revision: number; state: { count: number } }>(
        `SELECT revision::integer AS revision, state FROM next_round.matches WHERE id = $1`,
        [matchId],
      )).rows[0];
      expect(matchRow.revision).toBe(3);
      expect(matchRow.state.count).toBe(0); // Count was NOT incremented by the action

      // 4. Stored deadline 1 is consumed
      const dl1 = (await databasePool.query<{ status: string }>(
        `SELECT status FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
        [matchId],
      )).rows[0];
      expect(dl1.status).toBe("consumed");

      // 5. Stored deadline 2 is pending
      const dl2 = (await databasePool.query<{ status: string }>(
        `SELECT status FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 2`,
        [matchId],
      )).rows[0];
      expect(dl2.status).toBe("pending");

      // 6. Action_required notification for deadline 1 was superseded
      const notif1 = (await databasePool.query<{ superseded_at: string | null }>(
        `SELECT superseded_at FROM next_round.notifications
          WHERE match_id = $1 AND kind = 'action_required' AND safe_payload->>'eventId' = $2`,
        [matchId, deadlineRow.event_id],
      )).rows[0];
      expect(notif1.superseded_at).not.toBeNull();

      // 7. Exactly one turn_missed notification was created for Member A
      const missedNotifs = await databasePool.query<{ principal_id: string; dedupe_key: string }>(
        `SELECT principal_id, dedupe_key FROM next_round.notifications
          WHERE match_id = $1 AND kind = 'turn_missed'`,
        [matchId],
      );
      expect(missedNotifs.rowCount).toBe(1);
      expect(missedNotifs.rows[0].principal_id).toBe(memberA.principalId);
      expect(missedNotifs.rows[0].dedupe_key).toBe(`missed:${deadlineRow.event_id}`);

      // 8. No receipt was created for the expired action
      const receipts = await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.command_receipts WHERE match_id = $1 AND command_id = $2`,
        [matchId, actionCommandId],
      );
      expect(receipts.rows[0].count).toBe(0);
    } finally {
      await barrier.query("ROLLBACK").catch(() => {});
      barrier.release();
    }
  }, 120_000);

  it("F1-07 reconciles due deadline during command step 4, commits timeout and returns STALE_REVISION without user receipt", async () => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 30 });

    // Mark deadline 1 overdue
    await databasePool.query(
      `UPDATE next_round.match_deadlines
          SET due_at = now() - interval '5 seconds'
        WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    );

    const deadlineRow = (await databasePool.query<{ event_id: string }>(
      `SELECT event_id FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    )).rows[0];

    const commandId = randomUUID();
    const actionRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: {
        commandId,
        expectedRevision: revision,
        type: "add",
        payload: { amount: 1 },
      },
    });

    // Step 4 reconciles the timeout first and returns STALE_REVISION without applying the user intent
    expect(actionRes.statusCode).toBe(409);
    const body = actionRes.json() as { error: { code: string; details: { currentRevision: number } } };
    expect(body.error.code).toBe("STALE_REVISION");
    expect(body.error.details.currentRevision).toBe(revision + 1);

    // Timeout committed
    const matchRow = (await databasePool.query<{ revision: number; state: { count: number } }>(
      `SELECT revision::integer AS revision, state FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(matchRow.revision).toBe(revision + 1);
    expect(matchRow.state.count).toBe(0); // Add action was not applied

    // Event at revision 3 was a deadline event
    const eventRow = (await databasePool.query<{ kind: string; event_id: string }>(
      `SELECT kind, event_id FROM next_round.match_events WHERE match_id = $1 AND revision = $2`,
      [matchId, revision + 1],
    )).rows[0];
    expect(eventRow.kind).toBe("deadline");
    expect(eventRow.event_id).toBe(deadlineRow.event_id);

    // Deadline 1 is consumed, deadline 2 is pending
    const deadlines = await databasePool.query<{ generation: number; status: string }>(
      `SELECT generation::integer AS generation, status FROM next_round.match_deadlines WHERE match_id = $1 ORDER BY generation`,
      [matchId],
    );
    expect(deadlines.rows).toEqual([
      { generation: 1, status: "consumed" },
      { generation: 2, status: "pending" },
    ]);

    // Unread notification superseded, turn_missed created
    const notifs = await databasePool.query<{ kind: string; superseded_at: string | null }>(
      `SELECT kind, superseded_at FROM next_round.notifications WHERE match_id = $1 ORDER BY created_at`,
      [matchId],
    );
    const actionReq = notifs.rows.find((n) => n.kind === "action_required");
    expect(actionReq?.superseded_at).not.toBeNull();
    const missed = notifs.rows.find((n) => n.kind === "turn_missed");
    expect(missed).toBeDefined();

    // No command receipt was written for the user's commandId
    const receipts = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.command_receipts WHERE match_id = $1 AND command_id = $2`,
      [matchId, commandId],
    );
    expect(receipts.rows[0].count).toBe(0);
  }, 120_000);

  it("F1-07 ignores early, old-generation, duplicate, and cancelled deadline jobs without mutation", async () => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 60 });
    const matchService = new MatchService(databasePool, registry);

    // 1. Early job (due in future) -> returns 0, no mutation
    const earlyResult = await matchService.processDeadline({
      matchId,
      key: "turn",
      generation: 1,
    });
    expect(earlyResult).toBe(0);

    let matchRow = (await databasePool.query<{ revision: number }>(
      `SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(matchRow.revision).toBe(revision);

    // 2. Old-generation job (generation 0) -> returns 0, no mutation
    const oldResult = await matchService.processDeadline({
      matchId,
      key: "turn",
      generation: 0,
    });
    expect(oldResult).toBe(0);
    expect(matchRow.revision).toBe(revision);

    // 3. Nonexistent key -> returns 0
    const nonexistent = await matchService.processDeadline({
      matchId,
      key: "nonexistent",
      generation: 1,
    });
    expect(nonexistent).toBe(0);

    // 4. Mark due and process once -> returns 1
    await databasePool.query(
      `UPDATE next_round.match_deadlines
          SET due_at = now() - interval '5 seconds'
        WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    );
    const applied = await matchService.processDeadline({
      matchId,
      key: "turn",
      generation: 1,
    });
    expect(applied).toBe(1);

    matchRow = (await databasePool.query<{ revision: number }>(
      `SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(matchRow.revision).toBe(revision + 1);

    // 5. Duplicate job for already consumed generation 1 -> returns 0, no revision change
    const duplicateResult = await matchService.processDeadline({
      matchId,
      key: "turn",
      generation: 1,
    });
    expect(duplicateResult).toBe(0);

    matchRow = (await databasePool.query<{ revision: number }>(
      `SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(matchRow.revision).toBe(revision + 1);

    // 6. Actual cancelled job no-op:
    // Member B (current actor after timeout rotation) acts, advancing generation 2 -> 3, cancelling generation 2
    const addRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberB, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: revision + 1,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(addRes.statusCode).toBe(200);

    const cancelledRow = (await databasePool.query<{ status: string }>(
      `SELECT status FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 2`,
      [matchId],
    )).rows[0];
    expect(cancelledRow.status).toBe("cancelled");

    const cancelledResult = await matchService.processDeadline({
      matchId,
      key: "turn",
      generation: 2,
    });
    expect(cancelledResult).toBe(0);

    const matchRowAfterCancelled = (await databasePool.query<{ revision: number }>(
      `SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(matchRowAfterCancelled.revision).toBe(revision + 2);
  }, 120_000);

  it("F1-07 preserves stored/snapshot dueAt, event ID, scheduling outbox row, and obligation notification identity through notes and late join", async () => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 60 });

    const initialDeadlines = (await databasePool.query<{
      key: string;
      generation: number;
      due_at: string;
      event_id: string;
      status: string;
    }>(
      `SELECT key, generation::integer AS generation, due_at::text, event_id::text, status
         FROM next_round.match_deadlines
        WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    )).rows[0];

    const initialOutbox = (await databasePool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM next_round.outbox WHERE aggregate_id = $1 AND topic = 'deadline.schedule'`,
      [matchId],
    )).rows;
    expect(initialOutbox.length).toBe(1);
    expect(initialOutbox[0].dedupe_key).toBe(`deadline:${initialDeadlines.event_id}`);

    const initialNotifs = (await databasePool.query<{ id: string; dedupe_key: string; superseded_at: string | null }>(
      `SELECT id, dedupe_key, superseded_at FROM next_round.notifications
        WHERE match_id = $1 AND kind = 'action_required'`,
      [matchId],
    )).rows;
    expect(initialNotifs.length).toBe(1);
    expect(initialNotifs[0].superseded_at).toBeNull();

    // Capture emitted deadline times from server.transition to prove that the reducer emitted
    // a later ctx.now dueAt, yet the platform preserved the original stored due time.
    const registered = registry.getVersion("test-counter", "0.1.0")!;
    const originalServer = registered.server!;
    const emittedDueAtList: string[] = [];
    registered.server = {
      ...originalServer,
      transition(ctx, state, event) {
        const result = originalServer.transition(ctx, state, event);
        if (result.ok && result.value.deadlines.length) {
          emittedDueAtList.push(result.value.deadlines[0].dueAt);
        }
        return result;
      },
    };

    try {
      // Player A writes a note. In test-counter, note transition recomputes dueAt from ctx.now.
      // The platform must preserve the original stored dueAt and event identity.
      const noteRes = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/actions`,
        headers: headers(memberA, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: revision,
          type: "note",
          payload: { text: "private note" },
        },
      });
      expect(noteRes.statusCode).toBe(200);

      // Verify that the reducer actually emitted a different, later dueAt
      expect(emittedDueAtList[0]).not.toBe(new Date(initialDeadlines.due_at).toISOString());
      expect(Date.parse(emittedDueAtList[0])).toBeGreaterThan(Date.parse(initialDeadlines.due_at));

      const postNoteDeadline = (await databasePool.query<{
        key: string;
        generation: number;
        due_at: string;
        event_id: string;
        status: string;
      }>(
        `SELECT key, generation::integer AS generation, due_at::text, event_id::text, status
           FROM next_round.match_deadlines
          WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
        [matchId],
      )).rows[0];

      expect(postNoteDeadline.event_id).toBe(initialDeadlines.event_id);
      expect(postNoteDeadline.due_at).toBe(initialDeadlines.due_at);
      expect(postNoteDeadline.status).toBe("pending");

      // Outbox scheduling row is unchanged (no new deadline.schedule row written)
      const postNoteOutbox = await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.outbox WHERE aggregate_id = $1 AND topic = 'deadline.schedule'`,
        [matchId],
      );
      expect(postNoteOutbox.rows[0].count).toBe(1);

      // Obligation notification unchanged & not superseded
      const postNoteNotifs = (await databasePool.query<{ id: string; superseded_at: string | null }>(
        `SELECT id, superseded_at FROM next_round.notifications WHERE match_id = $1 AND kind = 'action_required'`,
        [matchId],
      )).rows;
      expect(postNoteNotifs.length).toBe(1);
      expect(postNoteNotifs[0].id).toBe(initialNotifs[0].id);
      expect(postNoteNotifs[0].superseded_at).toBeNull();

      // Snapshot reflects stored dueAt, not recomputed dueAt
      const snapAfterNote = (await app.inject({
        method: "GET",
        url: `/api/v1/matches/${matchId}`,
        headers: headers(memberA),
      })).json() as { data: { deadlines: Array<{ dueAt: string }> } };
      expect(snapAfterNote.data.deadlines[0].dueAt).toBe(new Date(initialDeadlines.due_at).toISOString());

      // Late join by Member C
      const memberC = await seedSession("Member C", "member_c");
      const joinRes = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/join`,
        headers: headers(memberC, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: revision + 1,
        },
      });
      expect(joinRes.statusCode).toBe(200);

      // Verify that the late join transition also emitted a later dueAt
      expect(emittedDueAtList[1]).not.toBe(new Date(initialDeadlines.due_at).toISOString());
      expect(Date.parse(emittedDueAtList[1])).toBeGreaterThan(Date.parse(emittedDueAtList[0]));

      const postJoinDeadline = (await databasePool.query<{
        due_at: string;
        event_id: string;
        status: string;
      }>(
        `SELECT due_at::text, event_id::text, status
           FROM next_round.match_deadlines
          WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
        [matchId],
      )).rows[0];

      expect(postJoinDeadline.event_id).toBe(initialDeadlines.event_id);
      expect(postJoinDeadline.due_at).toBe(initialDeadlines.due_at);
      expect(postJoinDeadline.status).toBe("pending");

      const postJoinOutbox = await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.outbox WHERE aggregate_id = $1 AND topic = 'deadline.schedule'`,
        [matchId],
      );
      expect(postJoinOutbox.rows[0].count).toBe(1);

      // Verify notification remains unchanged and active after late join
      const postJoinNotifs = (await databasePool.query<{ id: string; superseded_at: string | null }>(
        `SELECT id, superseded_at FROM next_round.notifications WHERE match_id = $1 AND kind = 'action_required'`,
        [matchId],
      )).rows;
      expect(postJoinNotifs.length).toBe(1);
      expect(postJoinNotifs[0].id).toBe(initialNotifs[0].id);
      expect(postJoinNotifs[0].superseded_at).toBeNull();

      const snapAfterJoin = (await app.inject({
        method: "GET",
        url: `/api/v1/matches/${matchId}`,
        headers: headers(memberA),
      })).json() as { data: { deadlines: Array<{ dueAt: string }> } };
      expect(snapAfterJoin.data.deadlines[0].dueAt).toBe(new Date(initialDeadlines.due_at).toISOString());
    } finally {
      registered.server = originalServer;
    }
  }, 120_000);

  it("F1-07 advances to fresh generation on gameplay action: cancels previous pending deadline, schedules new time, and supersedes notification without turn_missed", async () => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 60 });

    const dl1 = (await databasePool.query<{ event_id: string }>(
      `SELECT event_id FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    )).rows[0];

    // Member A takes voluntary gameplay action 'add'
    const addRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: revision,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(addRes.statusCode).toBe(200);

    // Generation 1 is cancelled, generation 2 is pending
    const deadlines = await databasePool.query<{ generation: number; status: string; event_id: string }>(
      `SELECT generation::integer AS generation, status, event_id::text
         FROM next_round.match_deadlines WHERE match_id = $1 ORDER BY generation`,
      [matchId],
    );
    expect(deadlines.rows).toMatchObject([
      { generation: 1, status: "cancelled", event_id: dl1.event_id },
      { generation: 2, status: "pending" },
    ]);
    const dl2EventId = deadlines.rows[1].event_id;
    expect(dl2EventId).not.toBe(dl1.event_id);

    // Outbox has schedule row for generation 2
    const outboxRows = await databasePool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM next_round.outbox WHERE aggregate_id = $1 AND topic = 'deadline.schedule' ORDER BY created_at`,
      [matchId],
    );
    expect(outboxRows.rows.map((r) => r.dedupe_key)).toContain(`deadline:${dl2EventId}`);

    // Notification for Member A was superseded
    const notif1 = (await databasePool.query<{ superseded_at: string | null }>(
      `SELECT superseded_at FROM next_round.notifications
        WHERE match_id = $1 AND kind = 'action_required' AND safe_payload->>'eventId' = $2`,
      [matchId, dl1.event_id],
    )).rows[0];
    expect(notif1.superseded_at).not.toBeNull();

    // NO turn_missed notification was created for Member A
    const missed = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.notifications WHERE match_id = $1 AND kind = 'turn_missed'`,
      [matchId],
    );
    expect(missed.rows[0].count).toBe(0);

    // Member B now has an unread action_required notification for generation 2
    const notif2 = (await databasePool.query<{ principal_id: string; superseded_at: string | null }>(
      `SELECT principal_id, superseded_at FROM next_round.notifications
        WHERE match_id = $1 AND kind = 'action_required' AND safe_payload->>'eventId' = $2`,
      [matchId, dl2EventId],
    )).rows[0];
    expect(notif2.principal_id).toBe(memberB.principalId);
    expect(notif2.superseded_at).toBeNull();
  }, 120_000);

  it("F1-07 voluntary [] cancels all pending deadlines; deadline [] consumes fired identity and cancels others", async () => {
    // Part A: Voluntary [] on completion cancels ALL pending identities (multi-deadline)
    const { matchId: matchA, revision: revA } = await createAndStartMatch({ target: 1, turnSeconds: 60 });
    const extraEventId = randomUUID();
    await databasePool.query(
      `INSERT INTO next_round.match_deadlines (match_id, key, generation, due_at, status, event_id)
       VALUES ($1, 'extra', 1, now() + interval '10 minutes', 'pending', $2)`,
      [matchA, extraEventId],
    );

    const finishRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchA}/actions`,
      headers: headers(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: revA,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(finishRes.statusCode).toBe(200);

    const matchRowA = (await databasePool.query<{ phase: string }>(
      `SELECT phase FROM next_round.matches WHERE id = $1`,
      [matchA],
    )).rows[0];
    expect(matchRowA.phase).toBe("finished");

    const dlA = await databasePool.query<{ key: string; status: string }>(
      `SELECT key, status FROM next_round.match_deadlines WHERE match_id = $1 ORDER BY key`,
      [matchA],
    );
    expect(dlA.rows).toEqual([
      { key: "extra", status: "cancelled" },
      { key: "turn", status: "cancelled" },
    ]);

    const missedA = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.notifications WHERE match_id = $1 AND kind = 'turn_missed'`,
      [matchA],
    );
    expect(missedA.rows[0].count).toBe(0);

    // Part B: Deadline [] consumes fired identity and cancels others
    const { matchId: matchB } = await createAndStartMatch({ target: 10, turnSeconds: 60 });
    const matchService = new MatchService(databasePool, registry);

    // Add a secondary pending deadline to the match
    const secondaryEventId = randomUUID();
    await databasePool.query(
      `INSERT INTO next_round.match_deadlines (match_id, key, generation, due_at, status, event_id)
       VALUES ($1, 'secondary', 1, now() + interval '10 minutes', 'pending', $2)`,
      [matchB, secondaryEventId],
    );
    // Mark 'turn' generation 1 overdue
    await databasePool.query(
      `UPDATE next_round.match_deadlines
          SET due_at = now() - interval '5 seconds'
        WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchB],
    );

    // Wrap registered server so deadline event transition emits []
    const registered = registry.getVersion("test-counter", "0.1.0")!;
    const originalServer = registered.server!;
    registered.server = {
      ...originalServer,
      transition(ctx, state, event) {
        const result = originalServer.transition(ctx, state, event);
        if (result.ok && event.kind === "deadline") {
          result.value.deadlines = []; // Emits []!
        }
        return result;
      },
    };

    try {
      const applied = await matchService.processDeadline({
        matchId: matchB,
        key: "turn",
        generation: 1,
      });
      expect(applied).toBe(1);

      const dls = await databasePool.query<{ key: string; status: string }>(
        `SELECT key, status FROM next_round.match_deadlines WHERE match_id = $1 ORDER BY key`,
        [matchB],
      );
      expect(dls.rows).toEqual([
        { key: "secondary", status: "cancelled" },
        { key: "turn", status: "consumed" },
      ]);

      // Fired deadline creates turn_missed
      const missedB = await databasePool.query<{ principal_id: string }>(
        `SELECT principal_id FROM next_round.notifications WHERE match_id = $1 AND kind = 'turn_missed'`,
        [matchB],
      );
      expect(missedB.rowCount).toBe(1);
      expect(missedB.rows[0].principal_id).toBe(memberA.principalId);
    } finally {
      registered.server = originalServer;
    }
  }, 120_000);

  it.each([
    "duplicate keys",
    "consumed reuse",
    "cancelled reuse",
    "re-emitted fired",
  ])("F1-07 rejects malformed reducer output '%s' with MODULE_FAILURE and no partial writes", async (fault) => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 60 });
    const matchService = new MatchService(databasePool, registry);
    const registered = registry.getVersion("test-counter", "0.1.0")!;
    const originalServer = registered.server!;

    if (fault === "consumed reuse") {
      // Consume generation 1 first (actor rotates to memberB)
      await databasePool.query(
        `UPDATE next_round.match_deadlines SET due_at = now() - interval '5 seconds'
          WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
        [matchId],
      );
      await matchService.processDeadline({ matchId, key: "turn", generation: 1 });
    } else if (fault === "cancelled reuse") {
      // Cancel generation 1 via an add action (actor rotates to memberB)
      const addRes = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/actions`,
        headers: headers(memberA, true),
        payload: { commandId: randomUUID(), expectedRevision: revision, type: "add", payload: { amount: 1 } },
      });
      expect(addRes.statusCode).toBe(200);
    }

    const stateBefore = (await databasePool.query<{ revision: number; state: Json }>(
      `SELECT revision::integer AS revision, state FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    const deadlinesBefore = (await databasePool.query<{ key: string; generation: number; status: string }>(
      `SELECT key, generation::integer AS generation, status FROM next_round.match_deadlines WHERE match_id = $1 ORDER BY key, generation`,
      [matchId],
    )).rows;
    const eventsBefore = (await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.match_events WHERE match_id = $1`,
      [matchId],
    )).rows[0].count;
    const outboxBefore = (await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.outbox WHERE aggregate_id = $1`,
      [matchId],
    )).rows[0].count;
    const notifsBefore = (await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.notifications WHERE match_id = $1`,
      [matchId],
    )).rows[0].count;
    const receiptsBefore = (await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.command_receipts WHERE match_id = $1`,
      [matchId],
    )).rows[0].count;
    const countersBefore = (await databasePool.query<{ id: string; inbox_revision: number; home_revision: number }>(
      `SELECT id, inbox_revision::integer AS inbox_revision, home_revision::integer AS home_revision
         FROM next_round.principals WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[memberA.principalId, memberB.principalId]],
    )).rows;

    registered.server = {
      ...originalServer,
      transition(ctx, state, event) {
        const result = originalServer.transition(ctx, state, event);
        if (!result.ok) return result;
        if (fault === "duplicate keys" && event.kind === "action") {
          result.value.deadlines = [
            { key: "turn", generation: 2, dueAt: new Date(Date.now() + 60000).toISOString() },
            { key: "turn", generation: 3, dueAt: new Date(Date.now() + 120000).toISOString() },
          ];
        } else if ((fault === "consumed reuse" || fault === "cancelled reuse") && event.kind === "action") {
          result.value.deadlines = [
            { key: "turn", generation: 1, dueAt: new Date(Date.now() + 60000).toISOString() },
          ];
        } else if (fault === "re-emitted fired" && event.kind === "deadline") {
          result.value.deadlines = [
            { key: "turn", generation: 1, dueAt: new Date(Date.now() + 60000).toISOString() },
          ];
        }
        return result;
      },
    };

    try {
      if (fault === "re-emitted fired") {
        await databasePool.query(
          `UPDATE next_round.match_deadlines SET due_at = now() - interval '5 seconds'
            WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
          [matchId],
        );
        await expect(
          matchService.processDeadline({ matchId, key: "turn", generation: 1 })
        ).rejects.toMatchObject({ code: "MODULE_FAILURE" });
      } else {
        // Dynamically select the current actor according to match state
        const matchActorRow = (await databasePool.query<{ current_actor: string }>(
          `SELECT m.state->>'currentActorMemberId' AS current_actor FROM next_round.matches m WHERE id = $1`,
          [matchId],
        )).rows[0];
        const memberAId = (await databasePool.query<{ id: string }>(
          `SELECT id FROM next_round.match_members WHERE match_id = $1 AND principal_id = $2`,
          [matchId, memberA.principalId],
        )).rows[0].id;
        const currentActor = matchActorRow.current_actor === memberAId ? memberA : memberB;

        const res = await app.inject({
          method: "POST",
          url: `/api/v1/matches/${matchId}/actions`,
          headers: headers(currentActor, true),
          payload: {
            commandId: randomUUID(),
            expectedRevision: stateBefore.revision,
            type: "add",
            payload: { amount: 1 },
          },
        });
        expect(res.statusCode).toBe(500);
        const resBody = res.json() as { error: { code: string } };
        expect(resBody.error.code).toBe("MODULE_FAILURE");
      }

      // Assert complete absence of partial writes across state, deadlines, events, outbox, notifications, receipts, and counters
      const stateAfter = (await databasePool.query<{ revision: number; state: Json }>(
        `SELECT revision::integer AS revision, state FROM next_round.matches WHERE id = $1`,
        [matchId],
      )).rows[0];
      expect(stateAfter).toEqual(stateBefore);

      const deadlinesAfter = (await databasePool.query<{ key: string; generation: number; status: string }>(
        `SELECT key, generation::integer AS generation, status FROM next_round.match_deadlines WHERE match_id = $1 ORDER BY key, generation`,
        [matchId],
      )).rows;
      expect(deadlinesAfter).toEqual(deadlinesBefore);

      const eventsAfter = (await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.match_events WHERE match_id = $1`,
        [matchId],
      )).rows[0].count;
      expect(eventsAfter).toBe(eventsBefore);

      const outboxAfter = (await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.outbox WHERE aggregate_id = $1`,
        [matchId],
      )).rows[0].count;
      expect(outboxAfter).toBe(outboxBefore);

      const notifsAfter = (await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.notifications WHERE match_id = $1`,
        [matchId],
      )).rows[0].count;
      expect(notifsAfter).toBe(notifsBefore);

      const receiptsAfter = (await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.command_receipts WHERE match_id = $1`,
        [matchId],
      )).rows[0].count;
      expect(receiptsAfter).toBe(receiptsBefore);

      const countersAfter = (await databasePool.query<{ id: string; inbox_revision: number; home_revision: number }>(
        `SELECT id, inbox_revision::integer AS inbox_revision, home_revision::integer AS home_revision
           FROM next_round.principals WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[memberA.principalId, memberB.principalId]],
      )).rows;
      expect(countersAfter).toEqual(countersBefore);
    } finally {
      registered.server = originalServer;
    }
  }, 120_000);

  it("F1-07 rolls back effects, state, and status on failure before commit", async () => {
    const { matchId, revision } = await createAndStartMatch({ turnSeconds: 60 });
    const matchService = new MatchService(databasePool, registry);

    // Mark deadline 1 overdue
    await databasePool.query(
      `UPDATE next_round.match_deadlines SET due_at = now() - interval '5 seconds'
        WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    );

    // Install an explosive trigger on outbox to simulate failure before commit
    await databasePool.query(`
      CREATE OR REPLACE FUNCTION next_round.test_fail_before_commit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure before commit';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_test_fail_before_commit
      BEFORE INSERT ON next_round.outbox
      FOR EACH ROW EXECUTE FUNCTION next_round.test_fail_before_commit();
    `);

    try {
      await expect(
        matchService.processDeadline({ matchId, key: "turn", generation: 1 })
      ).rejects.toThrow("injected failure before commit");

      // Verify complete rollback: revision unchanged, status still pending
      const matchRow = (await databasePool.query<{ revision: number }>(
        `SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1`,
        [matchId],
      )).rows[0];
      expect(matchRow.revision).toBe(revision);

      const dl = (await databasePool.query<{ status: string }>(
        `SELECT status FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
        [matchId],
      )).rows[0];
      expect(dl.status).toBe("pending");

      const notifs = await databasePool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM next_round.notifications WHERE match_id = $1 AND kind = 'turn_missed'`,
        [matchId],
      );
      expect(notifs.rows[0].count).toBe(0);
    } finally {
      await databasePool.query(`
        DROP TRIGGER IF EXISTS trg_test_fail_before_commit ON next_round.outbox;
        DROP FUNCTION IF EXISTS next_round.test_fail_before_commit();
      `);
    }

    // Now re-run after removing trigger: succeeds cleanly
    const applied = await matchService.processDeadline({ matchId, key: "turn", generation: 1 });
    expect(applied).toBe(1);

    const committedDl = (await databasePool.query<{ status: string }>(
      `SELECT status FROM next_round.match_deadlines WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
      [matchId],
    )).rows[0];
    expect(committedDl.status).toBe("consumed");
  }, 120_000);

  it("BL-001 returns STALE_REVISION before MATCH_CLOSED for lifecycle and action commands, and checks authorization first", async () => {
    // Finish a match at revision 3
    const { matchId, revision } = await createAndStartMatch({ target: 1, turnSeconds: null });
    const finishRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: revision, type: "add", payload: { amount: 1 } },
    });
    expect(finishRes.statusCode).toBe(200);

    const finishedRev = revision + 1; // 3
    const matchRow = (await databasePool.query<{ phase: string; revision: number }>(
      `SELECT phase, revision::integer AS revision FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(matchRow.phase).toBe("finished");
    expect(matchRow.revision).toBe(finishedRev);

    // 1. Unauthorized outsider sending lifecycle command receives 404 NOT_FOUND (authorization checked before revision)
    const outsiderLeave = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/leave`,
      headers: headers(outsider, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });
    expect(outsiderLeave.statusCode).toBe(404);
    const outsiderBody = outsiderLeave.json() as { error: { code: string } };
    expect(outsiderBody.error.code).toBe("NOT_FOUND");

    // 2. Authorized member sending lifecycle command with stale revision receives 409 STALE_REVISION
    const staleLeave = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/leave`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });
    expect(staleLeave.statusCode).toBe(409);
    const staleBody = staleLeave.json() as { error: { code: string; details: { currentRevision: number } } };
    expect(staleBody.error.code).toBe("STALE_REVISION");
    expect(staleBody.error.details.currentRevision).toBe(finishedRev);

    // 3. Authorized member sending lifecycle command with current revision receives 409 MATCH_CLOSED
    const closedLeave = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/leave`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: finishedRev },
    });
    expect(closedLeave.statusCode).toBe(409);
    const closedBody = closedLeave.json() as { error: { code: string } };
    expect(closedBody.error.code).toBe("MATCH_CLOSED");

    // 4. Authorized member sending action command with stale revision also receives 409 STALE_REVISION
    const staleAction = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: 0, type: "add", payload: { amount: 1 } },
    });
    expect(staleAction.statusCode).toBe(409);
    const staleActionBody = staleAction.json() as { error: { code: string } };
    expect(staleActionBody.error.code).toBe("STALE_REVISION");
  }, 120_000);

  it("BL-003 recovers missing statsVisibility from pinned policy_version on finalization, never current singleton, and fails closed if invalid", async () => {
    // 1. Success case: pinned policy_version 1 has statsVisibility: 'owner'. Current policy_version 2 has statsVisibility: 'instance'.
    const { matchId, revision } = await createAndStartMatch({ target: 1, turnSeconds: null });

    // Insert instance_policy v2 with statsVisibility: 'instance' and update singleton
    await databasePool.query(
      `INSERT INTO next_round.instance_policy (version, instance_name, policy, changed_by)
       VALUES (2, 'Policy V2', jsonb_build_object(
         'schemaVersion', 1,
         'historyVisibility', 'instance',
         'statsVisibility', 'instance',
         'rejoinChat', 'full',
         'retention', jsonb_build_object('chatDaysAfterFinish', 30, 'privateStateDaysAfterFinish', 30, 'resultDaysAfterFinish', null, 'notificationDays', 30)
       ), $1)`,
      [memberA.principalId],
    );
    await databasePool.query("UPDATE next_round.instance_singleton SET current_policy_version = 2");

    // Strip statsVisibility from matches.policy_snapshot
    await databasePool.query(
      `UPDATE next_round.matches SET policy_snapshot = policy_snapshot - 'statsVisibility' WHERE id = $1`,
      [matchId],
    );

    // Verify snapshot lacks statsVisibility
    const preSnapshot = (await databasePool.query<{ has_field: boolean }>(
      `SELECT policy_snapshot ? 'statsVisibility' AS has_field FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(preSnapshot.has_field).toBe(false);

    // Finish match
    const finishRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/actions`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: revision, type: "add", payload: { amount: 1 } },
    });
    expect(finishRes.statusCode).toBe(200);

    // Verify policy_snapshot backfilled with 'owner' (from pinned v1, NOT 'instance' from v2)
    const postSnapshot = (await databasePool.query<{ visibility: string }>(
      `SELECT policy_snapshot->>'statsVisibility' AS visibility FROM next_round.matches WHERE id = $1`,
      [matchId],
    )).rows[0];
    expect(postSnapshot.visibility).toBe("owner");

    // Verify career_contributions recorded visibility as 'owner'
    const contributions = await databasePool.query<{ visibility: string }>(
      `SELECT visibility FROM next_round.career_contributions WHERE match_id = $1`,
      [matchId],
    );
    expect(contributions.rows).toEqual([{ visibility: "owner" }, { visibility: "owner" }]);

    // 2. Failure case: pinned policy_version has invalid statsVisibility -> must fail closed with MODULE_FAILURE and no partial writes
    const { matchId: badMatchId, revision: badRev } = await createAndStartMatch({ target: 1, turnSeconds: null });

    // Insert policy version 99 with invalid statsVisibility and pin match to v99
    await databasePool.query(
      `INSERT INTO next_round.instance_policy (version, instance_name, policy, changed_by)
       VALUES (99, 'Invalid Policy', jsonb_build_object(
         'schemaVersion', 1,
         'historyVisibility', 'instance',
         'statsVisibility', 'invalid-value',
         'rejoinChat', 'full',
         'retention', jsonb_build_object('chatDaysAfterFinish', 30, 'privateStateDaysAfterFinish', 30, 'resultDaysAfterFinish', null, 'notificationDays', 30)
       ), $1)`,
      [memberA.principalId],
    );
    await databasePool.query(
      `UPDATE next_round.matches
          SET policy_version = 99, policy_snapshot = policy_snapshot - 'statsVisibility'
        WHERE id = $1`,
      [badMatchId],
    );

    const badFinishRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${badMatchId}/actions`,
      headers: headers(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: badRev, type: "add", payload: { amount: 1 } },
    });
    expect(badFinishRes.statusCode).toBe(500);
    const badFinishBody = badFinishRes.json() as { error: { code: string } };
    expect(badFinishBody.error.code).toBe("MODULE_FAILURE");

    // No partial writes to match_results or career_contributions
    const badResults = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.match_results WHERE match_id = $1`,
      [badMatchId],
    );
    expect(badResults.rows[0].count).toBe(0);

    const badContributions = await databasePool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM next_round.career_contributions WHERE match_id = $1`,
      [badMatchId],
    );
    expect(badContributions.rows[0].count).toBe(0);

    const badMatchState = (await databasePool.query<{ phase: string }>(
      `SELECT phase FROM next_round.matches WHERE id = $1`,
      [badMatchId],
    )).rows[0];
    expect(badMatchState.phase).toBe("active");
  }, 120_000);
});
