// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import {
  AuthService,
  GameRegistry,
  MatchService,
} from "@next-round/platform";
import type { AuthenticatedSession } from "@next-round/platform";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import { manifest } from "@next-round/game-test-counter/manifest";
import { server } from "@next-round/game-test-counter/server";
import {
  WorkerRunner,
  isLiveInvalidatePayload,
  isDeadlineSchedulePayload,
} from "./worker.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  !testDatabaseUrl &&
  process.env.npm_lifecycle_event === "test:integration"
) {
  throw new Error(
    "TEST_DATABASE_URL is required for database integration tests",
  );
}

interface SessionFixture {
  principalId: string;
  cookie: string;
  csrf: string;
}

describe.skipIf(!testDatabaseUrl)("Worker recovery and durable effects integration", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let databaseName: string;
  let connectionString: string;
  let staticRoot: string;
  let registry: GameRegistry;
  let memberA: SessionFixture;

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

  async function authenticated(fixture: SessionFixture): Promise<AuthenticatedSession> {
    return new AuthService(databasePool, undefined, new MatchService(databasePool, registry)).authenticate(
      fixture.cookie.split("=", 2)[1],
    );
  }

  beforeEach(async () => {
    databaseName = `next_round_recovery_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    connectionString = url.toString();
    await migrateDatabase({ connectionString });

    databasePool = createDatabasePool({ connectionString, max: 8 });

    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-worker-test-"));
    await writeFile(path.join(staticRoot, "client.js"), "export const clientFixture = true;\n");

    registry = new GameRegistry();
    registry.register(manifest, server, {
      clientRoot: staticRoot,
    });

    memberA = await seedSession("Member A", "member_a");

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
      await client.query(
        `INSERT INTO next_round.instance_policy
           (version, instance_name, policy, changed_by)
         VALUES (1, 'Worker recovery test instance', $1::jsonb, $2)`,
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
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }, 120_000);

  afterEach(async () => {
    try {
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
      }
    } finally {
      await adminPool?.end();
      await rm(staticRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("unscheduled commit survives worker restart: startup drains outbox and creates pg-boss jobs", async () => {
    const session = await authenticated(memberA);
    const matchService = new MatchService(databasePool, registry);

    const created = await matchService.create(session, {
      commandId: randomUUID(),
      moduleId: "test-counter",
      mode: "solo",
      settings: { target: 10, turnSeconds: 60 },
      visibility: "instance",
    });
    expect(created.revision).toBe(0);

    await matchService.start(created.matchId, session, {
      commandId: randomUUID(),
      expectedRevision: 0,
    });

    // Before worker starts: state and outbox rows are committed in PostgreSQL
    const { rows: pendingOutbox } = await databasePool.query<{ topic: string }>(
      "SELECT topic FROM next_round.outbox WHERE delivered_at IS NULL AND topic = 'deadline.schedule'",
    );
    expect(pendingOutbox).toEqual([{ topic: "deadline.schedule" }]);

    const { rows: pendingDeadlines } = await databasePool.query<{ key: string; status: string }>(
      "SELECT key, status FROM next_round.match_deadlines WHERE match_id = $1",
      [created.matchId],
    );
    expect(pendingDeadlines.length).toBe(1);
    expect(pendingDeadlines[0].status).toBe("pending");

    // Worker starts fresh against the populated database
    const worker = new WorkerRunner({ connectionString, registry });
    try {
      await worker.start();

      // Startup drain has processed all outbox rows without manual intervention
      const { rows: remainingOutbox } = await databasePool.query<{ id: string }>(
        "SELECT id FROM next_round.outbox WHERE delivered_at IS NULL",
      );
      expect(remainingOutbox.length).toBe(0);

      // Verify deadline job was scheduled in pg-boss
      const { rows: bossJobs } = await databasePool.query<{ name: string; data: unknown }>(
        "SELECT name, data FROM pgboss.job WHERE name = 'match-deadline'",
      );
      expect(bossJobs).toEqual([{
        name: "match-deadline",
        data: { matchId: created.matchId, key: "turn", generation: 1 },
      }]);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("overdue pending deadline reconciles once and duplicate reconcile runs are no-ops", async () => {
    const session = await authenticated(memberA);
    const matchService = new MatchService(databasePool, registry);

    const created = await matchService.create(session, {
      commandId: randomUUID(),
      moduleId: "test-counter",
      mode: "solo",
      settings: { target: 10, turnSeconds: 60 },
      visibility: "instance",
    });

    await matchService.start(created.matchId, session, {
      commandId: randomUUID(),
      expectedRevision: 0,
    });

    // Artificially age the deadline so it is overdue
    await databasePool.query(
      "UPDATE next_round.match_deadlines SET due_at = now() - interval '10 seconds' WHERE match_id = $1",
      [created.matchId],
    );

    const worker = new WorkerRunner({ connectionString, registry });
    try {
      // First reconciliation applies the overdue deadline
      const appliedCount = await worker.reconcileDeadlines();
      expect(appliedCount).toBe(1);

      // Status of generation 1 deadline is now consumed
      const { rows: gen1Rows } = await databasePool.query<{ status: string }>(
        "SELECT status FROM next_round.match_deadlines WHERE match_id = $1 AND generation = 1",
        [created.matchId],
      );
      expect(gen1Rows[0].status).toBe("consumed");

      // Match revision was advanced
      const { rows: matchRows } = await databasePool.query<{ revision: number }>(
        "SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1",
        [created.matchId],
      );
      expect(matchRows[0].revision).toBe(2);

      // Second reconciliation run is idempotent and applies nothing
      const secondRunApplied = await worker.reconcileDeadlines();
      expect(secondRunApplied).toBe(0);

      const { rows: matchRowsAfter } = await databasePool.query<{ revision: number }>(
        "SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1",
        [created.matchId],
      );
      expect(matchRowsAfter[0].revision).toBe(2);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("outbox lease expiry and retry redelivers properly with lease fencing on ack", async () => {
    const matchId = randomUUID();
    const outboxId = randomUUID();

    // Insert an expired lease row
    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, available_at, attempts, leased_until)
       VALUES ($1, 'live.invalidate', $2, $3, $4::jsonb, now() - interval '1 minute', 1, now() - interval '10 seconds')`,
      [
        outboxId,
        matchId,
        `test:dedupe:${outboxId}`,
        JSON.stringify({ scope: { kind: "match", id: matchId }, revision: 1 }),
      ],
    );

    const worker = new WorkerRunner({ connectionString, registry });
    try {
      const deliveredCount = await worker.processOutboxBatch();
      expect(deliveredCount).toBe(1);

      const { rows } = await databasePool.query<{ delivered_at: Date; attempts: number }>(
        "SELECT delivered_at, attempts FROM next_round.outbox WHERE id = $1",
        [outboxId],
      );
      expect(rows[0].delivered_at).not.toBeNull();
      expect(rows[0].attempts).toBe(2);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("outbox lease fencing protects against delayed/stale acks via actual worker execution", async () => {
    const matchId = randomUUID();
    const outboxId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, available_at)
       VALUES ($1, 'live.invalidate', $2, $3, $4::jsonb, now())`,
      [
        outboxId,
        matchId,
        `test:fencing:${outboxId}`,
        JSON.stringify({ scope: { kind: "match", id: matchId }, revision: 1 }),
      ],
    );

    // Wrapped pool intercepts the worker's ACK query:
    // Right before the worker executes the ACK query, a concurrent update steals the lease by bumping attempts.
    const customPool = createDatabasePool({ connectionString, max: 2 });
    const realQuery = customPool.query.bind(customPool);
    customPool.query = (async (
      queryTextOrConfig: string | pg.QueryConfig<unknown[]>,
      values?: unknown[],
    ): Promise<pg.QueryResult<pg.QueryResultRow>> => {
      const queryText = typeof queryTextOrConfig === "string" ? queryTextOrConfig : queryTextOrConfig.text;
      if (queryText.includes("UPDATE next_round.outbox") && queryText.includes("SET delivered_at = clock_timestamp()")) {
        // Concurrently bump attempts to simulate another worker claiming the row
        await databasePool.query(
          "UPDATE next_round.outbox SET attempts = attempts + 1, leased_until = clock_timestamp() + interval '30 seconds' WHERE id = $1",
          [outboxId],
        );
      }
      return realQuery(queryTextOrConfig as string, values);
    }) as unknown as typeof customPool.query;

    const worker = new WorkerRunner({ connectionString, pool: customPool, registry });
    try {
      // Worker claims the row, publishes effect, but its real ACK query matches 0 rows because attempts changed
      const delivered = await worker.processOutboxBatch();
      expect(delivered).toBe(0);

      // Verify the row in PostgreSQL remains undelivered
      const { rows } = await databasePool.query<{ delivered_at: Date | null }>(
        "SELECT delivered_at FROM next_round.outbox WHERE id = $1",
        [outboxId],
      );
      expect(rows[0].delivered_at).toBeNull();
    } finally {
      await worker.stop();
      await customPool.end();
    }
  }, 60_000);

  it("scheduling ack recovery redelivers with stable singleton dedupe identity without extra schedules", async () => {
    const matchId = randomUUID();
    const eventId = randomUUID();
    const outboxId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, available_at)
       VALUES ($1, 'deadline.schedule', $2, $3, $4::jsonb, now())`,
      [
        outboxId,
        matchId,
        `deadline:${eventId}`,
        JSON.stringify({
          matchId,
          key: "turn",
          generation: 1,
          dueAt: new Date(Date.now() + 60_000).toISOString(),
          eventId,
        }),
      ],
    );

    // Fault wrapper: simulates ACK failure on the first delivery attempt after effect (boss.send) has succeeded
    let hasFaulted = false;
    const customPool = createDatabasePool({ connectionString, max: 2 });
    const realQuery = customPool.query.bind(customPool);
    customPool.query = (async (
      queryTextOrConfig: string | pg.QueryConfig<unknown[]>,
      values?: unknown[],
    ): Promise<pg.QueryResult<pg.QueryResultRow>> => {
      const queryText = typeof queryTextOrConfig === "string" ? queryTextOrConfig : queryTextOrConfig.text;
      if (
        !hasFaulted &&
        queryText.includes("UPDATE next_round.outbox") &&
        queryText.includes("SET delivered_at = clock_timestamp()")
      ) {
        hasFaulted = true;
        throw new Error("SIMULATED_NETWORK_FAULT_DURING_ACK");
      }
      return realQuery(queryTextOrConfig as string, values);
    }) as unknown as typeof customPool.query;

    const worker = new WorkerRunner({ connectionString, pool: customPool, registry });
    try {
      await worker.start();

      // Startup drain attempted delivery: effect succeeded (job sent to pg-boss), but ACK query faulted
      expect(hasFaulted).toBe(true);

      // Row was never marked delivered
      const { rows: rowsAfterFault } = await databasePool.query<{ delivered_at: Date | null }>(
        "SELECT delivered_at FROM next_round.outbox WHERE id = $1",
        [outboxId],
      );
      expect(rowsAfterFault[0].delivered_at).toBeNull();

      // Subsequent processOutboxBatch honors exponential backoff window and returns 0
      const deliveredDuringBackoff = await worker.processOutboxBatch();
      expect(deliveredDuringBackoff).toBe(0);

      // Reset available_at to past so second delivery can pick it up immediately
      await databasePool.query(
        "UPDATE next_round.outbox SET available_at = now() - interval '1 second', leased_until = NULL WHERE id = $1",
        [outboxId],
      );

      // Second delivery attempt: boss.send uses same id & singletonKey, ACK succeeds
      const delivered2 = await worker.processOutboxBatch();
      expect(delivered2).toBe(1);
      // Verify row is now marked delivered
      const { rows: rowsAfterSuccess } = await databasePool.query<{ delivered_at: Date | null }>(
        "SELECT delivered_at FROM next_round.outbox WHERE id = $1",
        [outboxId],
      );
      expect(rowsAfterSuccess[0].delivered_at).not.toBeNull();

      // Verify that pg-boss retained only a single scheduled job for this dedupe singleton identity
      const { rows: jobs } = await databasePool.query<{ id: string; singleton_key: string }>(
        "SELECT id, singleton_key FROM pgboss.job WHERE name = 'match-deadline' AND id = $1",
        [eventId],
      );
      expect(jobs.length).toBe(1);
      expect(jobs[0].singleton_key).toBe(`deadline:${eventId}`);
    } finally {
      await worker.stop();
      await customPool.end();
    }
  }, 60_000);

  it("live.invalidate publishes to PostgreSQL channel next_round_live with strictly no state", async () => {
    const matchId = randomUUID();
    const outboxId = randomUUID();
    const safePayload = {
      scope: { kind: "match", id: matchId },
      revision: 4,
    };

    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, available_at)
       VALUES ($1, 'live.invalidate', $2, $3, $4::jsonb, now())`,
      [outboxId, matchId, `match:${matchId}:4`, JSON.stringify(safePayload)],
    );

    const listenerClient = new pg.Client({ connectionString });
    await listenerClient.connect();

    const { promise: noticePromise, resolve: resolveNotice } = Promise.withResolvers<string>();
    listenerClient.on("notification", (msg) => {
      if (msg.channel === "next_round_live" && msg.payload) {
        resolveNotice(msg.payload);
      }
    });

    await listenerClient.query("LISTEN next_round_live");

    const worker = new WorkerRunner({ connectionString, registry });
    try {
      const delivered = await worker.processOutboxBatch();
      expect(delivered).toBe(1);

      const notificationText = await noticePromise;
      const parsed = JSON.parse(notificationText) as Record<string, unknown>;
      expect(parsed).toEqual(safePayload);

      // Strictly verify no state or reducer leaks
      expect(parsed).not.toHaveProperty("state");
      expect(parsed).not.toHaveProperty("game");
      expect(parsed).not.toHaveProperty("notes");
      expect(parsed).not.toHaveProperty("secret");
    } finally {
      await worker.stop();
      await listenerClient.end();
    }
  }, 60_000);

  it("rejects invalid outbox payloads and refuses to publish state in live invalidations", async () => {
    // 1. Unit validations on payload guard
    expect(isLiveInvalidatePayload({ scope: { kind: "match", id: randomUUID() }, revision: 1 })).toBe(true);
    expect(isLiveInvalidatePayload({ scope: { kind: "home", principalId: randomUUID() }, revision: 1 })).toBe(true);
    expect(isLiveInvalidatePayload({ scope: { kind: "notifications", principalId: randomUUID() }, revision: 1 })).toBe(true);

    // Rejects non-UUID IDs
    expect(isLiveInvalidatePayload({ scope: { kind: "match", id: "arbitrary-private-string" }, revision: 1 })).toBe(false);
    expect(isLiveInvalidatePayload({ scope: { kind: "home", principalId: "arbitrary-private-string" }, revision: 1 })).toBe(false);

    // Rejects state pollution
    expect(isLiveInvalidatePayload({
      scope: { kind: "match", id: randomUUID() },
      revision: 1,
      state: { count: 1 },
    })).toBe(false);

    // Rejects scope pollution
    expect(isLiveInvalidatePayload({
      scope: { kind: "match", id: randomUUID(), extra: "forbidden" },
      revision: 1,
    })).toBe(false);

    // Rejects invalid scope kind
    expect(isLiveInvalidatePayload({
      scope: { kind: "unknown", id: randomUUID() },
      revision: 1,
    })).toBe(false);

    // 2. Integration check: poisoned outbox row is rejected and not delivered
    const outboxId = randomUUID();
    const badPayload = {
      scope: { kind: "match", id: randomUUID() },
      revision: 1,
      state: { secret: "leaked-data" },
    };

    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload, available_at)
       VALUES ($1, 'live.invalidate', 'bad-id', 'bad-dedupe', $2::jsonb, now())`,
      [outboxId, JSON.stringify(badPayload)],
    );

    const worker = new WorkerRunner({ connectionString, registry });
    try {
      const delivered = await worker.processOutboxBatch();
      expect(delivered).toBe(0);

      // Row remains undelivered and inspectable
      const { rows } = await databasePool.query<{ delivered_at: Date | null; attempts: number }>(
        "SELECT delivered_at, attempts FROM next_round.outbox WHERE id = $1",
        [outboxId],
      );
      expect(rows[0].delivered_at).toBeNull();
      expect(rows[0].attempts).toBe(1);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("handleDeadline rejects malformed input and rethrows processing failures for pg-boss retry", async () => {
    const worker = new WorkerRunner({ connectionString, registry });
    try {
      // Malformed inputs return 0 without invoking MatchService
      expect(await worker.handleDeadline({ matchId: "bad-id", key: "turn", generation: 1 })).toBe(0);
      expect(await worker.handleDeadline({ matchId: randomUUID(), key: "", generation: 1 })).toBe(0);
      expect(await worker.handleDeadline({ matchId: randomUUID(), key: "turn", generation: -1 })).toBe(0);

      const session = await authenticated(memberA);
      const matches = new MatchService(databasePool, registry);
      const created = await matches.create(session, {
        commandId: randomUUID(), moduleId: "test-counter", mode: "solo",
        settings: { target: 10, turnSeconds: 60 }, visibility: "instance",
      });
      await matches.start(created.matchId, session, { commandId: randomUUID(), expectedRevision: 0 });
      await databasePool.query(
        "UPDATE next_round.match_deadlines SET due_at = clock_timestamp() - interval '1 second' WHERE match_id = $1",
        [created.matchId],
      );
      const registered = registry.getVersion("test-counter", "0.1.0")!;
      const originalServer = registered.server!;
      registered.server = {
        ...originalServer,
        transition(ctx, state, event) {
          if (event.kind === "deadline") throw new Error("private reducer failure");
          return originalServer.transition(ctx, state, event);
        },
      };
      try {
        await expect(worker.handleDeadline({ matchId: created.matchId, key: "turn", generation: 1 }))
          .rejects.toMatchObject({ code: "MODULE_FAILURE" });
        const result = await databasePool.query(
          `SELECT m.revision::integer AS revision, d.status FROM next_round.matches m
             JOIN next_round.match_deadlines d ON d.match_id = m.id WHERE m.id = $1`, [created.matchId],
        );
        expect(result.rows).toEqual([{ revision: 1, status: "pending" }]);
      } finally { registered.server = originalServer; }
    } finally {
      await worker.stop();
    }
  }, 60_000);
  it("parks finite failures and crash-exhausted claims across competing workers", async () => {
    const a = new WorkerRunner({ connectionString, pool: databasePool, registry });
    const b = new WorkerRunner({ connectionString, pool: databasePool, registry });
    const id = randomUUID();
    await databasePool.query(
      `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload)
       VALUES ($1::uuid, 'unknown.private-secret', 'test', $1::text, '{"secret":"never logged"}')`, [id],
    );
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await Promise.all([a.handleOutbox({ outboxId: id }), b.handleOutbox({ outboxId: id })]);
      const result = await databasePool.query("SELECT attempts, dead_lettered_at, last_error_code FROM next_round.outbox WHERE id=$1", [id]);
      expect(result.rows[0].attempts).toBe(attempt);
      expect(Boolean(result.rows[0].dead_lettered_at)).toBe(attempt === 8);
      expect(result.rows[0].last_error_code).toBe("UNKNOWN_TOPIC");
      await databasePool.query("UPDATE next_round.outbox SET available_at=clock_timestamp() WHERE id=$1", [id]);
    }
    await a.handleOutbox({ outboxId: id });
    expect((await databasePool.query("SELECT attempts FROM next_round.outbox WHERE id=$1", [id])).rows[0].attempts).toBe(8);
    await databasePool.query("UPDATE next_round.outbox SET dead_lettered_at=NULL, leased_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await b.processOutboxBatch();
    const parked = (await databasePool.query("SELECT attempts, dead_lettered_at FROM next_round.outbox WHERE id=$1", [id])).rows[0];
    expect(parked.attempts).toBe(8);
    expect(parked.dead_lettered_at).not.toBeNull();
  });

  it("dispatches committed inserts promptly without the periodic sweep and ignores rollbacks", async () => {
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry, reconcileIntervalMs: 600_000 });
    const client = await databasePool.connect();
    try {
      await worker.start();
      const id = randomUUID();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload)
         VALUES ($1::uuid, 'live.invalidate', 'test', $1::text, $2)`,
        [id, JSON.stringify({ scope: { kind: "home", principalId: memberA.principalId }, revision: 1 })],
      );
      expect((await databasePool.query("SELECT id FROM next_round.outbox WHERE id=$1", [id])).rows).toHaveLength(0);
      await client.query("COMMIT");
      await expect.poll(async () => (await databasePool.query(
        "SELECT delivered_at IS NOT NULL AS delivered FROM next_round.outbox WHERE id=$1", [id],
      )).rows[0].delivered, { timeout: 5000 }).toBe(true);
      const rolledBack = randomUUID();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload)
         VALUES ($1::uuid, 'unknown', 'test', $1::text, '{}')`, [rolledBack],
      );
      await client.query("ROLLBACK");
      expect((await databasePool.query("SELECT id FROM next_round.outbox WHERE id=$1", [rolledBack])).rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await worker.stop();
    }
  }, 60_000);

  it("recovers prompt delivery after its LISTEN backend is terminated (BL-047)", async () => {
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry, reconcileIntervalMs: 600_000 });
    try {
      await worker.start();
      const listenerPids = async () => (await databasePool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%'",
      )).rows.map((row) => row.pid);
      const before = await listenerPids();
      expect(before.length).toBeGreaterThan(0);
      for (const pid of before) {
        await databasePool.query("SELECT pg_terminate_backend($1)", [pid]);
      }
      await expect.poll(async () => (await listenerPids()).length, { timeout: 15_000 }).toBe(0);
      const id = randomUUID();
      await databasePool.query(
        `INSERT INTO next_round.outbox (id, topic, aggregate_id, dedupe_key, safe_payload)
         VALUES ($1::uuid, 'live.invalidate', 'test', $1::text, $2)`,
        [id, JSON.stringify({ scope: { kind: "home", principalId: memberA.principalId }, revision: 1 })],
      );
      // The periodic sweep is ten minutes out, so delivery within seconds
      // can only come from the reconnected listener (catch-up drain/NOTIFY).
      await expect.poll(async () => (await databasePool.query(
        "SELECT delivered_at IS NOT NULL AS delivered FROM next_round.outbox WHERE id=$1", [id],
      )).rows[0].delivered, { timeout: 20_000 }).toBe(true);
      const after = await listenerPids();
      expect(after.length).toBeGreaterThan(0);
      expect(after.some((pid) => !before.includes(pid))).toBe(true);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("publishes a heartbeat at startup and refreshes it on each sweep (BL-039)", async () => {
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry, reconcileIntervalMs: 250 });
    try {
      await worker.start();
      const heartbeats = async () => (await databasePool.query<{ worker_id: string; last_seen_at: Date }>(
        "SELECT worker_id, last_seen_at FROM next_round.worker_heartbeats",
      )).rows;
      await expect.poll(async () => (await heartbeats()).length, { timeout: 10_000 }).toBe(1);
      const first = (await heartbeats())[0];
      expect(first.worker_id).toBeTruthy();
      await expect.poll(
        async () => (await heartbeats())[0].last_seen_at.getTime(),
        { timeout: 10_000 },
      ).toBeGreaterThan(first.last_seen_at.getTime());
      await worker.stop();
      expect(await heartbeats()).toHaveLength(0);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("keeps the heartbeat fresh on its own cadence when the sweep interval is long (BL-051)", async () => {
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry, reconcileIntervalMs: 60_000 });
    try {
      await worker.start();
      const heartbeats = async () => (await databasePool.query<{ worker_id: string; last_seen_at: Date }>(
        "SELECT worker_id, last_seen_at FROM next_round.worker_heartbeats",
      )).rows;
      await expect.poll(async () => (await heartbeats()).length, { timeout: 10_000 }).toBe(1);
      const first = (await heartbeats())[0];
      // The next sweep is ~60 s out, so only the decoupled 10 s heartbeat
      // timer can advance last_seen_at inside this window. On the pre-fix
      // code the heartbeat moved only on sweeps and this poll times out.
      await expect.poll(
        async () => (await heartbeats())[0].last_seen_at.getTime(),
        { timeout: 20_000 },
      ).toBeGreaterThan(first.last_seen_at.getTime());
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("prunes heartbeat rows past the retention window at startup (BL-053)", async () => {
    await databasePool.query(
      `INSERT INTO next_round.worker_heartbeats (worker_id, started_at, last_seen_at)
       VALUES ('crashed-old', now() - interval '2 days', now() - interval '25 hours'),
              ('crashed-recent', now() - interval '3 hours', now() - interval '2 hours')`,
    );
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry, reconcileIntervalMs: 250 });
    try {
      await worker.start();
      const workerIds = (await databasePool.query<{ worker_id: string }>(
        "SELECT worker_id FROM next_round.worker_heartbeats",
      )).rows.map((row) => row.worker_id);
      expect(workerIds).not.toContain("crashed-old");
      expect(workerIds).toContain("crashed-recent");
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("bounds global expiry cleanup and preserves live rate budgets", async () => {
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry });
    await databasePool.query(
      `INSERT INTO next_round.rate_buckets (key_hash, window_start, expires_at)
       SELECT decode(md5(n::text), 'hex'), clock_timestamp(), clock_timestamp()-interval '1 day'
       FROM generate_series(1, 601) n`,
    );
    await databasePool.query(
      `INSERT INTO next_round.rate_buckets (key_hash, window_start, expires_at)
       VALUES (decode(md5('live'), 'hex'), clock_timestamp(), clock_timestamp()+interval '1 day')`,
    );
    await worker.drainOverdueAndOutbox();
    expect((await databasePool.query("SELECT count(*)::integer AS count FROM next_round.rate_buckets")).rows[0].count).toBe(102);
    await worker.drainOverdueAndOutbox();
    expect((await databasePool.query("SELECT count(*)::integer AS count FROM next_round.rate_buckets")).rows[0].count).toBe(1);
  });
  it("continues past a failed-only batch and collects only expired unaccepted guests", async () => {
    const worker = new WorkerRunner({ connectionString, pool: databasePool, registry });
    await databasePool.query(
      `INSERT INTO next_round.outbox (topic, aggregate_id, dedupe_key, safe_payload)
       SELECT 'unknown', 'test', 'failed-'||n, '{}' FROM generate_series(1, 51) n`,
    );
    await databasePool.query(
      `INSERT INTO next_round.invitations (kind, issuer_id, status, expires_at)
       VALUES ('guest', $1, 'pending', clock_timestamp()-interval '1 day'),
              ('guest', $1, 'accepted', clock_timestamp()-interval '1 day'),
              ('guest', $1, 'pending', clock_timestamp()+interval '1 day'),
              ('registration', $1, 'pending', clock_timestamp()-interval '1 day')`,
      [memberA.principalId],
    );
    await worker.drainOverdueAndOutbox();
    expect((await databasePool.query("SELECT count(*)::integer AS count FROM next_round.outbox WHERE attempts=1")).rows[0].count).toBe(51);
    const invitations = await databasePool.query(
      "SELECT kind, status FROM next_round.invitations ORDER BY kind, status",
    );
    expect(invitations.rows).toEqual([
      { kind: "guest", status: "accepted" },
      { kind: "guest", status: "pending" },
      { kind: "registration", status: "pending" },
    ]);
  });
});
