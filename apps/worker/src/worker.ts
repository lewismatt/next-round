// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { ERROR_CODES } from "@next-round/contracts";
import {
  GameRegistry,
  MatchService,
  parsePositiveIntegerInterval,
  verifyModuleRetentionReadiness,
} from "@next-round/platform";
import { loadTestCounterFixtureIfEnabled } from "./test-counter-fixture.js";
import { registerCrosswordModule } from "./crossword-fixture.js";

const { Pool } = pg;

const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;
/** BL-051: heartbeats run on their own fixed cadence, decoupled from the
 *  configurable reconciliation interval. The admin health stale threshold
 *  (30 s) is three missed heartbeats at this cadence, so a healthy worker
 *  reads fresh whatever LIVE_RECONCILE_INTERVAL_MS is configured to. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** BL-053: heartbeat rows left behind by crashed workers are pruned at
 *  worker startup once their last heartbeat is older than this window. */
const HEARTBEAT_RETENTION_INTERVAL = "24 hours";
const DEFAULT_BATCH_SIZE = 50;
const OUTBOX_LEASE_DURATION_MS = 30_000;
const OUTBOX_MAX_ATTEMPTS = 8;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_SQLSTATE_REGEX = /^[0-9A-Z]{5}$/;
const KNOWN_ERROR_CODES: Record<string, true> = Object.fromEntries(
  Object.values(ERROR_CODES).map((code) => [code, true]),
);
// Worker-internal delivery failure codes (BL-042): recorded verbatim in
// outbox.last_error_code so an operator can triage a dead-lettered row
// without reading source.
const WORKER_DELIVERY_ERROR_CODES: Record<string, true> = {
  INVALID_PAYLOAD: true,
  PGBOSS_UNAVAILABLE: true,
  UNKNOWN_TOPIC: true,
};

function deliveryError(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

export function safeErrorCode(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof err.code === "string"
  ) {
    if (Object.hasOwn(KNOWN_ERROR_CODES, err.code)) {
      return err.code;
    }
    if (Object.hasOwn(WORKER_DELIVERY_ERROR_CODES, err.code)) {
      return err.code;
    }
    if (PG_SQLSTATE_REGEX.test(err.code)) {
      return err.code;
    }
  }
  return "INTERNAL_ERROR";
}

export interface WorkerOptions {
  connectionString?: string;
  databaseDirectUrl?: string;
  schema?: string;
  reconcileIntervalMs?: number;
  pool?: pg.Pool;
  registry?: GameRegistry;
  skipRetentionCheck?: boolean;
}

export interface DeadlineJobData {
  matchId: string;
  key: string;
  generation: number;
}

export interface OutboxJobData {
  outboxId: string;
  topic?: string;
  payload?: unknown;
}

export interface WorkerStatus {
  running: boolean;
  bossStarted: boolean;
  lastReconcileAt: string | null;
  reconcileCount: number;
  uptimeSeconds: number;
}

export interface DeadlineSchedulePayload {
  matchId: string;
  key: string;
  generation: number;
  dueAt: string;
  eventId: string;
}

export interface LiveInvalidatePayload {
  scope:
    | { kind: "match"; id: string }
    | { kind: "chat"; id: string }
    | { kind: "home"; principalId: string }
    | { kind: "notifications"; principalId: string };
  revision: number;
}

interface BossJob<T> {
  data: T;
}

function isJobWithData<T>(job: unknown): job is BossJob<T> {
  if (typeof job !== "object" || job === null || !("data" in job)) {
    return false;
  }
  const data = job.data;
  return typeof data === "object" && data !== null;
}

export function isDeadlineSchedulePayload(
  payload: unknown,
): payload is DeadlineSchedulePayload {
  if (typeof payload !== "object" || payload === null) return false;
  if (
    !("matchId" in payload) ||
    !isUuid(payload.matchId) ||
    !("key" in payload) ||
    typeof payload.key !== "string" ||
    !payload.key.length ||
    !("generation" in payload) ||
    typeof payload.generation !== "number" ||
    !Number.isSafeInteger(payload.generation) ||
    payload.generation < 0 ||
    !("dueAt" in payload) ||
    typeof payload.dueAt !== "string" ||
    !Number.isFinite(Date.parse(payload.dueAt)) ||
    !("eventId" in payload) ||
    !isUuid(payload.eventId)
  ) {
    return false;
  }
  const keys = Object.keys(payload);
  return keys.length === 5;
}

export function isLiveInvalidatePayload(
  payload: unknown,
): payload is LiveInvalidatePayload {
  if (typeof payload !== "object" || payload === null) return false;
  if (
    !("revision" in payload) ||
    typeof payload.revision !== "number" ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 0
  ) {
    return false;
  }
  if (
    !("scope" in payload) ||
    typeof payload.scope !== "object" ||
    payload.scope === null
  ) {
    return false;
  }
  const scope = payload.scope;
  if (!("kind" in scope) || typeof scope.kind !== "string") {
    return false;
  }
  const scopeKeys = Object.keys(scope);
  if (scope.kind === "match" || scope.kind === "chat") {
    if (!("id" in scope) || !isUuid(scope.id) || scopeKeys.length !== 2) {
      return false;
    }
  } else if (scope.kind === "home" || scope.kind === "notifications") {
    if (
      !("principalId" in scope) ||
      !isUuid(scope.principalId) ||
      scopeKeys.length !== 2
    ) {
      return false;
    }
  } else {
    return false;
  }
  const topKeys = Object.keys(payload);
  return topKeys.length === 2;
}

/**
 * WorkerRunner encapsulates background job processing using pg-boss and PostgreSQL.
 * Handles match deadline wakeups, periodic deadline reconciliation, and outbox delivery.
 */
export class WorkerRunner {
  private boss: PgBoss | null = null;
  private pool: pg.Pool;
  private ownsPool: boolean;
  private listener: pg.Client | null = null;
  private listenerEnabled = false;
  private wakeupPending = false;
  private wakeupDraining = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private startedAt: number | null = null;
  private lastReconcileAt: string | null = null;
  private reconcileCount = 0;
  private isReconciling = false;
  private inFlightWork = 0;
  private inFlightWaiters: Array<() => void> = [];
  private readonly workerId = randomUUID();
  public readonly registry: GameRegistry;
  public readonly matchService: MatchService;
  private readonly skipRetentionCheck: boolean;
  private readonly config: {
    connectionString: string;
    listenerConnectionString: string;
    schema: string;
    reconcileIntervalMs: number;
  };

  constructor(options: WorkerOptions = {}) {
    const connectionString =
      options.connectionString ||
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5432/next_round";

    const reconcileIntervalMs =
      options.reconcileIntervalMs !== undefined
        ? parsePositiveIntegerInterval(
            options.reconcileIntervalMs,
            "reconcileIntervalMs",
          )
        : parsePositiveIntegerInterval(
            process.env.LIVE_RECONCILE_INTERVAL_MS,
            "LIVE_RECONCILE_INTERVAL_MS",
            DEFAULT_RECONCILE_INTERVAL_MS,
          );

    this.config = {
      connectionString,
      listenerConnectionString:
        options.databaseDirectUrl ??
        (options.connectionString ? connectionString : process.env.DATABASE_DIRECT_URL ?? connectionString),
      schema: options.schema || process.env.PGBOSS_SCHEMA || "pgboss",
      reconcileIntervalMs,
    };
    this.skipRetentionCheck = options.skipRetentionCheck ?? false;

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        connectionString: this.config.connectionString,
        max: Number(process.env.WORKER_POOL_MAX || 5),
      });
      // Same guard as createDatabasePool: an idle client whose backend
      // dies must not take the process down via an unlistened pool error.
      this.pool.on("error", (err) => {
        console.error(`[worker:pool] Idle client error: ${safeErrorCode(err)}`);
      });
      this.ownsPool = true;
    }

    if (options.registry) {
      this.registry = options.registry;
    } else {
      this.registry = new GameRegistry();
      loadTestCounterFixtureIfEnabled(
        this.registry,
        process.env.NEXT_ROUND_ENABLE_TEST_COUNTER === "true",
      );
      registerCrosswordModule(this.registry);
    }

    this.matchService = new MatchService(this.pool, this.registry);
  }

  private notifyWaitersIfIdle(): void {
    if (this.inFlightWork === 0 && !this.isReconciling) {
      for (const resolve of this.inFlightWaiters) {
        resolve();
      }
      this.inFlightWaiters = [];
    }
  }

  private async withInFlight<T>(action: () => Promise<T>): Promise<T> {
    this.inFlightWork += 1;
    try {
      return await action();
    } finally {
      this.inFlightWork -= 1;
      this.notifyWaitersIfIdle();
    }
  }

  private requestOutboxDrain(): void {
    this.wakeupPending = true;
    if (!this.running || this.wakeupDraining) return;
    this.wakeupDraining = true;
    void this.withInFlight(async () => {
      try {
        do {
          this.wakeupPending = false;
          while (this.running && (await this.dispatchOutboxBatch()).claimed > 0) {
            // Drain committed backlog without waiting for the recovery interval.
          }
        } while (this.running && this.wakeupPending);
      } catch (err) {
        console.error(`[worker:outbox] Wakeup drain failed: ${safeErrorCode(err)}`);
      } finally {
        this.wakeupDraining = false;
      }
    });
  }

  private async connectOutboxListener(): Promise<void> {
    if (this.stopped || !this.listenerEnabled) return;
    const listener = new pg.Client({ connectionString: this.config.listenerConnectionString });
    this.listener = listener;
    const reconnect = () => {
      if (this.listener !== listener || this.stopped || !this.listenerEnabled) return;
      this.listener = null;
      void listener.end().catch(() => {});
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connectOutboxListener().catch(() => {
          reconnect();
        });
      }, 1000);
    };
    listener.on("error", (err) => {
      console.error(`[worker:listen] ${safeErrorCode(err)}`);
      reconnect();
    });
    listener.on("end", reconnect);
    listener.on("notification", () => this.requestOutboxDrain());
    try {
      await listener.connect();
      await listener.query("LISTEN next_round_outbox");
      this.requestOutboxDrain();
    } catch (err) {
      reconnect();
      throw err;
    }
  }

  private async parkExhaustedOutbox(): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      `WITH exhausted AS (
         SELECT id FROM next_round.outbox
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL
            AND attempts >= $1
            AND (leased_until IS NULL OR leased_until < clock_timestamp())
          ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED
       )
       UPDATE next_round.outbox o SET dead_lettered_at = clock_timestamp(),
         leased_until = NULL, last_error_code = COALESCE(last_error_code, 'ATTEMPTS_EXHAUSTED')
       FROM exhausted WHERE o.id = exhausted.id RETURNING o.id`,
      [OUTBOX_MAX_ATTEMPTS],
    );
    for (const row of result.rows) {
      console.error(`[worker:outbox] Dead-lettered exhausted outbox row id=${row.id}`);
    }
  }
  /**
   * BL-039: persist a liveness heartbeat so the admin health surface can
   * report worker presence and staleness (spec section 8). Written at
   * startup, on every reconciliation sweep, and on a dedicated fixed
   * 10-second timer (BL-051). Best-effort: a failed write is logged,
   * never fatal — the next write retries.
   */
  private async recordHeartbeat(): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO next_round.worker_heartbeats (worker_id, started_at, last_seen_at)
         VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = clock_timestamp()`,
        [this.workerId, new Date(this.startedAt ?? Date.now())],
      );
    } catch (err) {
      console.error(`[worker:heartbeat] Write failed: ${safeErrorCode(err)}`);
    }
  }

  /**
   * BL-053: bound the heartbeat table's growth. A gracefully stopped
   * worker deletes its own row, but a crashed worker's row stays behind;
   * prune rows whose last heartbeat is older than the retention window.
   * Runs at startup, so the table self-cleans on every worker boot while
   * recent crash rows survive as diagnostics. Best-effort, like the
   * heartbeat write itself.
   */
  private async pruneStaleHeartbeats(): Promise<void> {
    try {
      await this.pool.query(
        `DELETE FROM next_round.worker_heartbeats
          WHERE last_seen_at < clock_timestamp() - interval '${HEARTBEAT_RETENTION_INTERVAL}'`,
      );
    } catch (err) {
      console.error(`[worker:heartbeat] Prune failed: ${safeErrorCode(err)}`);
    }
  }

  /**
   * Initialize pg-boss, register queue workers, and start periodic reconciliation.
   */
  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    const boss = new PgBoss({
      connectionString: this.config.connectionString,
      schema: this.config.schema,
    });
    this.boss = boss;

    boss.on("error", (err: Error) => {
      console.error(`[worker:pg-boss] Error: ${safeErrorCode(err)}`);
    });

    if (!this.skipRetentionCheck) {
      await verifyModuleRetentionReadiness(this.pool, this.registry);
    }

    try {
      this.listenerEnabled = true;
      await boss.start();
      console.log(
        `[worker:pg-boss] Started successfully with schema "${this.config.schema}"`,
      );

      await this.connectOutboxListener();
      await this.registerHandlers();
      await this.drainOverdueAndOutbox();

      this.reconcileTimer = setInterval(async () => {
        if (!this.running || this.isReconciling) {
          return;
        }
        this.isReconciling = true;
        try {
          await this.withInFlight(async () => {
            await this.recordHeartbeat();
            await this.drainOverdueAndOutbox();
          });
        } catch (err) {
          console.error(
            `[worker] Error in periodic reconciliation: ${safeErrorCode(err)}`,
          );
        } finally {
          this.isReconciling = false;
          this.notifyWaitersIfIdle();
        }
      }, this.config.reconcileIntervalMs);

      this.running = true;
      this.requestOutboxDrain();
      this.startedAt = Date.now();
      await this.recordHeartbeat();
      await this.pruneStaleHeartbeats();
      this.heartbeatTimer = setInterval(() => {
        if (this.running) {
          void this.recordHeartbeat();
        }
      }, HEARTBEAT_INTERVAL_MS);
      console.log(
        `[worker] Running. Periodic reconciliation scheduled every ${this.config.reconcileIntervalMs}ms`,
      );
    } catch (err) {
      if (this.reconcileTimer) {
        clearInterval(this.reconcileTimer);
        this.reconcileTimer = null;
      }
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.running = false;
      this.listenerEnabled = false;
      clearTimeout(this.reconnectTimer ?? undefined);
      this.reconnectTimer = null;
      const listener = this.listener;
      this.listener = null;
      await listener?.end().catch(() => {});
      try {
        await boss.stop({ graceful: false, timeout: 1000 });
      } catch {
        // Safe cleanup
      }
      this.boss = null;
      throw err;
    }
  }

  /**
   * Graceful shutdown of pg-boss, background timers, and database pool.
   * Awaits in-flight work and active reconciliations before closing.
   */
  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const wasRunning = this.running;
    this.running = false;
    this.listenerEnabled = false;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => {});

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (wasRunning && (this.inFlightWork > 0 || this.isReconciling)) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timeout = setTimeout(resolve, 10_000);
      this.inFlightWaiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
      this.notifyWaitersIfIdle();
      await promise;
    }

    if (this.boss) {
      try {
        await this.boss.stop({ graceful: true, timeout: 5000 });
      } catch {
        // Safe cleanup
      }
      this.boss = null;
    }

    // BL-039: a gracefully stopped worker leaves the admin health view;
    // a crashed one is exposed by its heartbeat going stale instead.
    try {
      await this.pool.query(
        "DELETE FROM next_round.worker_heartbeats WHERE worker_id = $1",
        [this.workerId],
      );
    } catch {
      // Best effort: if this delete fails, the next worker startup prunes
      // the row once it passes the retention window (BL-053).
    }

    if (this.ownsPool) {
      await this.pool.end();
    }

    console.log("[worker] Stopped gracefully");
  }

  /**
   * Returns current health and runtime status of the worker.
   */
  public getStatus(): WorkerStatus {
    return {
      running: this.running,
      bossStarted: this.boss !== null,
      lastReconcileAt: this.lastReconcileAt,
      reconcileCount: this.reconcileCount,
      uptimeSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
    };
  }

  /**
   * Register pg-boss job subscribers for deadlines and outbox.
   */
  private async registerHandlers(): Promise<void> {
    if (!this.boss) return;

    await this.boss.createQueue("match-deadline");
    await this.boss.createQueue("outbox-delivery");

    await this.boss.work("match-deadline", async (jobOrJobs: unknown) => {
      const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
      for (const job of jobs) {
        if (isJobWithData<DeadlineJobData>(job)) {
          await this.handleDeadline(job.data);
        }
      }
    });

    await this.boss.work("outbox-delivery", async (jobOrJobs: unknown) => {
      const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
      for (const job of jobs) {
        if (isJobWithData<OutboxJobData>(job)) {
          await this.handleOutbox(job.data);
        }
      }
    });
  }

  /**
   * Deadline handler per Master Spec §4:
   * Delegates generation/status/due checks and state transition to MatchService.processDeadline.
   * Duplicate, early, or already-consumed wakeups are harmless and return 0.
   * Rethrows errors so pg-boss records failure and retries.
   */
  public async handleDeadline(data: DeadlineJobData): Promise<number> {
    if (
      !data ||
      typeof data.matchId !== "string" ||
      !isUuid(data.matchId) ||
      typeof data.key !== "string" ||
      !data.key.length ||
      typeof data.generation !== "number" ||
      !Number.isSafeInteger(data.generation) ||
      data.generation < 0
    ) {
      console.error("[worker:deadline] Invalid deadline job data received");
      return 0;
    }

    return this.withInFlight(async () => {
      try {
        return await this.matchService.processDeadline({
          matchId: data.matchId,
          key: data.key,
          generation: data.generation,
        });
      } catch (err) {
        console.error(
          `[worker:deadline] Deadline processing failed: ${safeErrorCode(err)}`,
        );
        throw err;
      }
    });
  }

  /**
   * Targeted outbox delivery for a specific row id, if triggered by job queue.
   */
  public async handleOutbox(data: OutboxJobData): Promise<void> {
    if (!data || typeof data.outboxId !== "string" || !isUuid(data.outboxId)) {
      return;
    }

    await this.withInFlight(async () => {
      await this.parkExhaustedOutbox();
      const { rows } = await this.pool.query<{
        id: string;
        topic: string;
        aggregate_id: string;
        aggregate_revision: number | null;
        dedupe_key: string;
        safe_payload: unknown;
        attempts: number;
      }>(
        `WITH claimable AS (
           SELECT id
             FROM next_round.outbox
            WHERE id = $1
              AND delivered_at IS NULL
              AND dead_lettered_at IS NULL
              AND attempts < ${OUTBOX_MAX_ATTEMPTS}
              AND available_at <= clock_timestamp()
              AND (leased_until IS NULL OR leased_until < clock_timestamp())
            FOR UPDATE SKIP LOCKED
         )
         UPDATE next_round.outbox o
            SET leased_until = clock_timestamp() + ($2 || ' milliseconds')::interval,
                attempts = o.attempts + 1
           FROM claimable
          WHERE o.id = claimable.id
         RETURNING o.id,
                   o.topic,
                   o.aggregate_id,
                   o.aggregate_revision::float8 AS aggregate_revision,
                   o.dedupe_key,
                   o.safe_payload,
                   o.attempts`,
        [data.outboxId, OUTBOX_LEASE_DURATION_MS],
      );

      if (rows.length > 0) {
        await this.deliverOutboxRow(rows[0]);
      }
    });
  }

  /**
   * Reconcile overdue pending deadlines per Master Spec §4.
   * Selects overdue pending deadline rows in bounded batches and delegates
   * reconciliation to MatchService.processDeadline.
   */
  public async reconcileDeadlines(
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    this.lastReconcileAt = new Date().toISOString();
    this.reconcileCount += 1;

    let rows: Array<{
      match_id: string;
      key: string;
      generation: string | number;
    }>;
    try {
      const result = await this.pool.query<{
        match_id: string;
        key: string;
        generation: string | number;
      }>(
        `SELECT match_id, key, generation
           FROM next_round.match_deadlines
          WHERE status = 'pending' AND due_at <= clock_timestamp()
          ORDER BY due_at ASC, match_id ASC, key ASC
          LIMIT $1`,
        [batchSize],
      );
      rows = result.rows;
    } catch (err) {
      console.error(
        `[worker:reconcile] Error checking overdue deadlines: ${safeErrorCode(err)}`,
      );
      throw err;
    }

    let totalApplied = 0;
    for (const row of rows) {
      try {
        const applied = await this.matchService.processDeadline({
          matchId: row.match_id,
          key: row.key,
          generation: Number(row.generation),
        });
        totalApplied += applied;
      } catch (err) {
        console.error(
          `[worker:reconcile] Error reconciling deadline: ${safeErrorCode(err)}`,
        );
      }
    }
    return totalApplied;
  }

  /**
   * Claim and deliver pending outbox batches using SKIP LOCKED per Master Spec §4.
   * Leases rows with fencing on ack/release using monotonic attempts.
   */
  public async processOutboxBatch(
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    return (await this.dispatchOutboxBatch(batchSize)).delivered;
  }

  private async dispatchOutboxBatch(
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<{ delivered: number; claimed: number }> {
    await this.parkExhaustedOutbox();
    let rows: Array<{
      id: string;
      topic: string;
      aggregate_id: string;
      aggregate_revision: number | null;
      dedupe_key: string;
      safe_payload: unknown;
      attempts: number;
    }>;
    try {
      const result = await this.pool.query<{
        id: string;
        topic: string;
        aggregate_id: string;
        aggregate_revision: number | null;
        dedupe_key: string;
        safe_payload: unknown;
        attempts: number;
      }>(
        `WITH claimable AS (
           SELECT id
             FROM next_round.outbox
            WHERE delivered_at IS NULL
              AND available_at <= clock_timestamp()
              AND dead_lettered_at IS NULL
              AND attempts < ${OUTBOX_MAX_ATTEMPTS}
              AND (leased_until IS NULL OR leased_until < clock_timestamp())
            ORDER BY available_at ASC, created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE next_round.outbox o
            SET leased_until = clock_timestamp() + ($2 || ' milliseconds')::interval,
                attempts = o.attempts + 1
           FROM claimable
          WHERE o.id = claimable.id
         RETURNING o.id,
                   o.topic,
                   o.aggregate_id,
                   o.aggregate_revision::float8 AS aggregate_revision,
                   o.dedupe_key,
                   o.safe_payload,
                   o.attempts`,
        [batchSize, OUTBOX_LEASE_DURATION_MS],
      );
      rows = result.rows;
    } catch (err) {
      console.error(
        `[worker:outbox] Error claiming outbox batch: ${safeErrorCode(err)}`,
      );
      throw err;
    }

    let deliveredCount = 0;
    for (const row of rows) {
      const delivered = await this.deliverOutboxRow(row);
      if (delivered) {
        deliveredCount += 1;
      }
    }
    return { delivered: deliveredCount, claimed: rows.length };
  }

  /**
   * Drains both overdue deadlines and pending outbox rows in batches until drained.
   */
  public async drainOverdueAndOutbox(
    maxBatches = 10,
  ): Promise<{ deadlines: number; outbox: number }> {
    let totalDeadlines = 0;
    let totalOutbox = 0;

    for (let i = 0; i < maxBatches; i += 1) {
      const applied = await this.reconcileDeadlines();
      totalDeadlines += applied;
      if (applied === 0) break;
    }

    for (let i = 0; i < maxBatches; i += 1) {
      const result = await this.dispatchOutboxBatch();
      totalOutbox += result.delivered;
      if (result.claimed === 0) break;
    }
    await this.pool.query(
      `DELETE FROM next_round.rate_buckets WHERE ctid IN (
         SELECT ctid FROM next_round.rate_buckets
          WHERE expires_at <= statement_timestamp() ORDER BY expires_at
          LIMIT 500 FOR UPDATE SKIP LOCKED
       )`,
    );
    await this.pool.query(
      `DELETE FROM next_round.invitations WHERE id IN (
         SELECT id FROM next_round.invitations
          WHERE kind = 'guest' AND status <> 'accepted' AND expires_at <= statement_timestamp()
          ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
       )`,
    );

    return { deadlines: totalDeadlines, outbox: totalOutbox };
  }

  private async deliverOutboxRow(row: {
    id: string;
    topic: string;
    aggregate_id: string;
    aggregate_revision: number | null;
    dedupe_key: string;
    safe_payload: unknown;
    attempts: number;
  }): Promise<boolean> {
    try {
      if (row.topic === "deadline.schedule") {
        if (!isDeadlineSchedulePayload(row.safe_payload)) {
          throw deliveryError("INVALID_PAYLOAD");
        }
        if (!this.boss) {
          throw deliveryError("PGBOSS_UNAVAILABLE");
        }
        const payload = row.safe_payload;
        await this.boss.send(
          "match-deadline",
          {
            matchId: payload.matchId,
            key: payload.key,
            generation: payload.generation,
          },
          {
            id: payload.eventId,
            startAfter: new Date(payload.dueAt),
            singletonKey: `deadline:${payload.eventId}`,
          },
        );
      } else if (row.topic === "live.invalidate") {
        if (!isLiveInvalidatePayload(row.safe_payload)) {
          throw deliveryError("INVALID_PAYLOAD");
        }
        await this.pool.query("SELECT pg_notify('next_round_live', $1)", [
          JSON.stringify(row.safe_payload),
        ]);
      } else {
        throw deliveryError("UNKNOWN_TOPIC");
      }

      // Fencing on ack: monotonically incremented attempts uniquely identifies this claim generation
      const ackResult = await this.pool.query(
        `UPDATE next_round.outbox
            SET delivered_at = clock_timestamp(),
                leased_until = NULL
          WHERE id = $1
            AND delivered_at IS NULL
            AND dead_lettered_at IS NULL
            AND attempts = $2`,
        [row.id, row.attempts],
      );

      if (ackResult.rowCount === 0) {
        console.warn(
          `[worker:outbox] Lease fencing triggered on ack for outbox row id=${row.id}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      // Only the winning fenced transition emits a terminal diagnostic.
      try {
        const released = await this.pool.query(
          `UPDATE next_round.outbox
              SET leased_until = NULL,
                  last_error_code = $3,
                  dead_lettered_at = CASE WHEN attempts >= $4 THEN clock_timestamp() ELSE NULL END,
                  available_at = clock_timestamp() + (LEAST(POWER(2, LEAST(attempts, 6)) * 1000, 60000) || ' milliseconds')::interval
            WHERE id = $1
              AND delivered_at IS NULL
              AND dead_lettered_at IS NULL
              AND attempts = $2
            RETURNING dead_lettered_at`,
          [row.id, row.attempts, safeErrorCode(err), OUTBOX_MAX_ATTEMPTS],
        );
        if (released.rows[0]?.dead_lettered_at) {
          console.error(
            `[worker:outbox] Dead-lettered outbox row id=${row.id}: ${safeErrorCode(err)}`,
          );
        }
      } catch (releaseErr) {
        console.error(
          `[worker:outbox] Fatal error releasing lease for outbox row id=${row.id}: ${safeErrorCode(releaseErr)}`,
        );
        throw releaseErr;
      }
      return false;
    }
  }
}

/**
 * Factory function to create a new WorkerRunner instance.
 */
export function createWorker(options: WorkerOptions = {}): WorkerRunner {
  return new WorkerRunner(options);
}
