// SPDX-License-Identifier: Apache-2.0
import pg from "pg";
import { PgBoss } from "pg-boss";

const { Pool } = pg;

export interface WorkerOptions {
  connectionString?: string;
  schema?: string;
  reconcileIntervalMs?: number;
  pool?: pg.Pool;
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


/**
 * WorkerRunner encapsulates background job processing using pg-boss and PostgreSQL.
 * Handles match deadline wakeups, periodic deadline reconciliation, and outbox delivery.
 */
export class WorkerRunner {
  private boss: PgBoss | null = null;
  private pool: pg.Pool;
  private ownsPool: boolean;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt: number | null = null;
  private lastReconcileAt: string | null = null;
  private reconcileCount = 0;
  private readonly config: Required<Omit<WorkerOptions, "pool">> & {
    pool?: pg.Pool;
  };

  constructor(options: WorkerOptions = {}) {
    const connectionString =
      options.connectionString ||
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5432/next_round";

    this.config = {
      connectionString,
      schema: options.schema || process.env.PGBOSS_SCHEMA || "pgboss",
      reconcileIntervalMs:
        options.reconcileIntervalMs ||
        Number(process.env.LIVE_RECONCILE_INTERVAL_MS || 10000),
      pool: options.pool,
    };

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        connectionString: this.config.connectionString,
        max: Number(process.env.WORKER_POOL_MAX || 5),
      });
      this.ownsPool = true;
    }
  }

  /**
   * Initialize pg-boss, register queue workers, and start periodic reconciliation.
   */
  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    // 1. Initialize pg-boss with dedicated schema per Master Spec §4
    this.boss = new PgBoss({
      connectionString: this.config.connectionString,
      schema: this.config.schema,
    });

    this.boss.on("error", (err: Error) => {
      console.error("[worker:pg-boss] Error:", err.message);
    });

    await this.boss.start();
    console.log(
      `[worker:pg-boss] Started successfully with schema "${this.config.schema}"`
    );

    // 2. Register queue handlers
    await this.registerHandlers();

    // 3. Run initial deadline reconciliation on startup per Master Spec §4
    await this.reconcileDeadlines();

    // 4. Start periodic reconciliation loop (default every 10 seconds)
    this.reconcileTimer = setInterval(async () => {
      try {
        await this.reconcileDeadlines();
        await this.processOutboxBatch();
      } catch (err) {
        console.error("[worker] Error in periodic reconciliation:", err);
      }
    }, this.config.reconcileIntervalMs);

    this.running = true;
    this.startedAt = Date.now();
    console.log(
      `[worker] Running. Periodic reconciliation scheduled every ${this.config.reconcileIntervalMs}ms`
    );
  }

  /**
   * Graceful shutdown of pg-boss, background timers, and database pool.
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.boss) {
      try {
        await this.boss.stop({ graceful: true, timeout: 5000 });
      } catch (err) {
        console.error("[worker:pg-boss] Error during stop:", err);
      }
      this.boss = null;
    }

    if (this.ownsPool) {
      await this.pool.end();
    }

    this.running = false;
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

    // pg-boss 12 requires a queue to exist before work() can subscribe to it.
    // createQueue is idempotent, so restarts and multiple workers are safe.
    await this.boss.createQueue("match-deadline");
    await this.boss.createQueue("outbox-delivery");

    // Match deadline wakeup handler
    await this.boss.work("match-deadline", async (jobOrJobs: unknown) => {
      const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
      for (const job of jobs) {
        if (isJobWithData<DeadlineJobData>(job)) {
          await this.handleDeadline(job.data);
        }
      }
    });

    // Outbox delivery handler
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
   * "Deadlines are durable rows, not process timers. Reducers emit unique key/generation
   * and absolute dueAt using ctx.now. Outbox jobs schedule pg-boss wakeups with
   * {matchId,key,generation}; generation/status checks make late/duplicate jobs harmless.
   * Worker applies deadlines using deterministic eventId, resource/match locks and
   * the same transition/result rules."
   */
  public async handleDeadline(data: DeadlineJobData): Promise<void> {
    console.log(
      `[worker:deadline] Processing deadline matchId=${data.matchId} key=${data.key} gen=${data.generation}`
    );
    // Placeholder handler: validates generation/status against match_deadlines table
    // and applies state transitions via deterministic event execution.
  }

  /**
   * Outbox handler per Master Spec §4:
   * "Workers claim undelivered outbox rows with SKIP LOCKED and a lease. Effects are
   * retryable and have application dedupe keys; mark delivered after durable effect
   * acknowledgement. A crash after effect but before acknowledgement may repeat
   * delivery; recipients/consumers must tolerate duplicates."
   */
  public async handleOutbox(data: OutboxJobData): Promise<void> {
    console.log(`[worker:outbox] Processing outbox delivery outboxId=${data.outboxId}`);
    // Placeholder handler: executes downstream side-effects (e.g. notifications/LISTEN-NOTIFY)
    // and marks outbox row delivered within lease.
  }

  /**
   * Reconcile overdue pending deadlines per Master Spec §4:
   * "On worker startup and every 10 seconds, reconcile overdue pending deadline rows
   * in bounded batches; queue loss/delayed scheduling cannot lose a deadline."
   */
  public async reconcileDeadlines(): Promise<number> {
    this.lastReconcileAt = new Date().toISOString();
    this.reconcileCount++;

    try {
      // Placeholder batch query: selects overdue pending deadline rows with SKIP LOCKED
      // and processes timeouts where due_at <= NOW() and status = 'pending'.
      return 0;
    } catch (err) {
      console.error("[worker:reconcile] Error checking overdue deadlines:", err);
      return 0;
    }
  }

  /**
   * Claim and deliver pending outbox batches using SKIP LOCKED per Master Spec §4.
   */
  public async processOutboxBatch(): Promise<number> {
    try {
      // Placeholder batch claiming undelivered outbox rows with lease
      return 0;
    } catch (err) {
      console.error("[worker:outbox] Error claiming outbox batch:", err);
      return 0;
    }
  }
}

/**
 * Factory function to create a new WorkerRunner instance.
 */
export function createWorker(options: WorkerOptions = {}): WorkerRunner {
  return new WorkerRunner(options);
}
