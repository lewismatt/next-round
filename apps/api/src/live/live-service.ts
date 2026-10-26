// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ClientLiveFrameSchema,
  ERROR_CODES,
  parseRequestBody,
  type ClientLiveFrame,
  type LiveScope,
  type ServerLiveFrame,
} from "@next-round/contracts";
import {
  createDedicatedClient,
  type DatabaseNotification,
  type DatabasePool,
  type DedicatedClient,
} from "@next-round/db";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { parseLiveReconcileIntervalMs } from "../config.js";
import {
  scopeKey,
  type LiveConnection,
  type LiveServiceOptions,
  type LiveSubscription,
  type LiveSweepStats,
} from "./types.js";

const DEFAULT_HEARTBEAT_SECONDS = 25;
const DEFAULT_MAX_SUBSCRIPTIONS = 20;
const DEFAULT_MAX_BUFFERED_AMOUNT = 64 * 1024; // 64 KiB
const MAX_REQUEST_ID_LENGTH = 128;
const MESSAGE_BURST = 40;
const MESSAGES_PER_SECOND = 20;

function positiveConnectionLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeRequestId(requestId: unknown): string {
  if (
    typeof requestId === "string" &&
    requestId.length > 0 &&
    requestId.length <= MAX_REQUEST_ID_LENGTH
  ) {
    return requestId;
  }
  return randomUUID();
}

function normalizeScope(scope: LiveScope): LiveScope | null {
  if (typeof scope !== "object" || scope === null) return null;
  if (scope.kind === "match") {
    if (typeof scope.id !== "string" || !UUID_REGEX.test(scope.id)) return null;
    return { kind: "match", id: scope.id.toLowerCase() };
  }
  if (scope.kind === "chat") {
    if (typeof scope.id !== "string" || !UUID_REGEX.test(scope.id)) return null;
    return { kind: "chat", id: scope.id.toLowerCase() };
  }
  if (scope.kind === "notifications") {
    return { kind: "notifications" };
  }
  if (scope.kind === "home") {
    return { kind: "home" };
  }
  return null;
}

export class LiveService {
  private readonly pool: DatabasePool;
  private readonly directUrl: string;
  private readonly listenerAppName: string;
  private readonly reconcileIntervalMs: number;
  private readonly heartbeatSeconds: number;
  private readonly maxSubscriptions: number;
  private readonly maxBufferedAmount: number;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerPrincipal: number;
  private readonly enableListener: boolean;
  private readonly logger: FastifyBaseLogger;
  private readonly onSweep?: (stats: LiveSweepStats) => void;

  private listenerClient: DedicatedClient | null = null;
  private listenerConnected = false;
  private readonly connections = new Map<string, LiveConnection>();
  private readonly principalConnections = new Map<string, number>();

  private isDegraded = false;
  private isStopped = false;
  private nextSweepRequested = false;
  private pendingForceInvalidateAll = false;
  private activeSweepPromise: Promise<LiveSweepStats> | null = null;

  private sweepTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(options: LiveServiceOptions) {
    this.pool = options.databasePool;
    this.directUrl =
      options.databaseDirectUrl ||
      process.env.DATABASE_DIRECT_URL ||
      process.env.DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5432/next_round";
    this.listenerAppName =
      options.listenerApplicationName || `next-round-live:${process.pid}`;
    this.reconcileIntervalMs =
      options.reconcileIntervalMs !== undefined
        ? parseLiveReconcileIntervalMs(options.reconcileIntervalMs)
        : parseLiveReconcileIntervalMs(
            process.env.LIVE_RECONCILE_INTERVAL_MS,
            10000,
          );
    this.heartbeatSeconds =
      options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.maxSubscriptions =
      options.maxSubscriptionsPerConnection ?? DEFAULT_MAX_SUBSCRIPTIONS;
    this.maxBufferedAmount =
      options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;
    this.maxConnections = positiveConnectionLimit(
      options.maxConnections ?? 100,
      "maxConnections",
    );
    this.maxConnectionsPerPrincipal = positiveConnectionLimit(
      options.maxConnectionsPerPrincipal ?? 5,
      "maxConnectionsPerPrincipal",
    );
    this.enableListener = options.enableListener ?? true;
    this.logger =
      options.logger ??
      ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as unknown as FastifyBaseLogger);
    this.onSweep = options.onSweep;
  }

  public async start(): Promise<void> {
    if (this.isStopped) return;

    this.sweepTimer = setInterval(() => {
      this.runSweep().catch(() => {
        this.isDegraded = true;
        this.logger.warn(
          "Periodic live sweep encountered error; marking degraded",
        );
      });
    }, this.reconcileIntervalMs);

    if (this.enableListener) {
      void this.connectListener();
    }
  }

  public async close(): Promise<void> {
    this.isStopped = true;

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Await any in-flight sweep to finish before tearing down connections
    if (this.activeSweepPromise) {
      try {
        await this.activeSweepPromise;
      } catch {
        // Safe shutdown
      }
    }

    for (const connection of Array.from(this.connections.values())) {
      this.closeConnection(connection, 1001, "Server shutting down");
    }

    if (this.listenerClient) {
      const client = this.listenerClient;
      this.listenerClient = null;
      this.listenerConnected = false;
      try {
        await client.end();
      } catch {
        // Safe shutdown
      }
    }
  }

  public getStatus(): {
    degraded: boolean;
    connections: number;
    listenerConnected: boolean;
  } {
    return {
      degraded: this.isDegraded,
      connections: this.connections.size,
      listenerConnected: this.listenerConnected && !this.isDegraded,
    };
  }

  private async connectListener(): Promise<void> {
    if (this.isStopped || !this.enableListener || this.listenerClient) return;
    let client: DedicatedClient;
    try {
      client = createDedicatedClient(this.directUrl, this.listenerAppName);
    } catch {
      this.isDegraded = true;
      this.scheduleReconnect();
      return;
    }

    const wasDegraded = this.isDegraded;
    this.isDegraded = true;
    this.listenerClient = client;
    client.on("error", () => this.handleListenerDisconnect(client));
    client.on("end", () => this.handleListenerDisconnect(client));
    client.on("notification", (message: DatabaseNotification) => {
      if (
        message.channel === "next_round_live" &&
        this.listenerClient === client
      ) {
        void this.runSweep();
      }
    });

    try {
      await client.connect();
      if (this.isStopped || this.listenerClient !== client) {
        await client.end();
        return;
      }
      await client.query("LISTEN next_round_live");
      if (this.isStopped || this.listenerClient !== client) {
        await client.end();
        return;
      }
      this.reconnectAttempts = 0;
      this.listenerConnected = true;
      this.isDegraded = false;
      this.logger.info(
        { application_name: this.listenerAppName },
        wasDegraded
          ? "Live listener recovered"
          : "Dedicated live listener session established",
      );
      if (wasDegraded) void this.runSweep({ forceInvalidateAll: true });
    } catch {
      this.handleListenerDisconnect(client);
    }
  }

  private handleListenerDisconnect(client: DedicatedClient): void {
    if (this.listenerClient !== client) return;
    this.listenerClient = null;
    this.listenerConnected = false;
    this.isDegraded = true;
    this.logger.warn("Live listener disconnected; delivery is degraded");
    void client.end().catch(() => {});
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isStopped || !this.enableListener || this.reconnectTimer) return;

    const delayMs =
      Math.min(250 * Math.pow(2, this.reconnectAttempts), 5000) +
      Math.floor(Math.random() * 200);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, delayMs);
  }

  public registerConnection(
    socket: WebSocket,
    principalId: string,
    sessionId: string,
  ): LiveConnection | null {
    const principalCount = this.principalConnections.get(principalId) ?? 0;
    if (
      this.connections.size >= this.maxConnections ||
      principalCount >= this.maxConnectionsPerPrincipal
    ) {
      socket.close(1008, "Connection limit exceeded");
      return null;
    }
    const id = randomUUID();
    const connection: LiveConnection = {
      id,
      principalId,
      sessionId,
      socket,
      subscriptions: new Map(),
      missedPongs: 0,
      messageTokens: MESSAGE_BURST,
      messageRefilledAt: performance.now(),
      closed: false,
    };

    this.connections.set(id, connection);
    this.principalConnections.set(principalId, principalCount + 1);

    this.sendFrame(connection, {
      type: "hello",
      connectionId: id,
      serverNow: new Date().toISOString(),
      heartbeatSeconds: this.heartbeatSeconds,
    });

    connection.heartbeatTimer = setInterval(() => {
      if (connection.closed) return;
      if (connection.missedPongs >= 2) {
        this.logger.warn(
          { connectionId: id },
          "Missed pongs heartbeat timeout; terminating connection",
        );
        this.closeConnection(connection, 1000, "Heartbeat timeout");
        return;
      }
      connection.missedPongs++;
      try {
        socket.ping();
      } catch {
        // Socket may have closed
      }
    }, this.heartbeatSeconds * 1000);

    socket.on("pong", () => {
      connection.missedPongs = 0;
    });

    socket.on("message", (data) => {
      void this.handleClientMessage(connection, data);
    });

    socket.on("close", () => {
      this.removeConnection(connection);
    });

    socket.on("error", () => {
      this.logger.warn({ connectionId: id }, "WebSocket connection error");
      this.removeConnection(connection);
    });

    return connection;
  }

  private async handleClientMessage(
    connection: LiveConnection,
    rawBytes: unknown,
  ): Promise<void> {
    if (connection.closed) return;

    const now = performance.now();
    connection.messageTokens = Math.min(
      MESSAGE_BURST,
      connection.messageTokens +
        ((now - connection.messageRefilledAt) / 1000) * MESSAGES_PER_SECOND,
    );
    connection.messageRefilledAt = now;
    if (connection.messageTokens < 1) {
      this.closeConnection(connection, 1008, "Message rate exceeded");
      return;
    }
    connection.messageTokens--;

    let text: string;
    if (typeof rawBytes === "string") {
      text = rawBytes;
    } else if (Buffer.isBuffer(rawBytes)) {
      text = rawBytes.toString("utf8");
    } else if (rawBytes instanceof ArrayBuffer) {
      text = Buffer.from(rawBytes).toString("utf8");
    } else {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendFrame(connection, {
        type: "error",
        requestId: randomUUID(),
        code: ERROR_CODES.INVALID_REQUEST,
      });
      return;
    }

    let frame: ClientLiveFrame;
    try {
      frame = parseRequestBody(ClientLiveFrameSchema, parsed);
    } catch {
      let fallbackReqId: string = randomUUID();
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "requestId" in parsed
      ) {
        fallbackReqId = sanitizeRequestId(parsed.requestId);
      }
      this.sendFrame(connection, {
        type: "error",
        requestId: fallbackReqId,
        code: ERROR_CODES.INVALID_REQUEST,
      });
      return;
    }

    const requestId = sanitizeRequestId(frame.requestId);

    if (frame.type === "ping") {
      this.sendFrame(connection, {
        type: "pong",
        requestId,
        serverNow: new Date().toISOString(),
      });
      return;
    }

    if (frame.type === "unsubscribe") {
      const normalized = normalizeScope(frame.scope);
      if (!normalized) {
        this.sendFrame(connection, {
          type: "error",
          requestId,
          code: ERROR_CODES.INVALID_REQUEST,
        });
        return;
      }
      const key = scopeKey(normalized);
      connection.subscriptions.delete(key);
      return;
    }

    if (frame.type === "subscribe") {
      const normalized = normalizeScope(frame.scope);
      if (!normalized) {
        this.sendFrame(connection, {
          type: "error",
          requestId,
          code: ERROR_CODES.INVALID_REQUEST,
        });
        return;
      }

      const key = scopeKey(normalized);

      if (
        connection.subscriptions.size >= this.maxSubscriptions &&
        !connection.subscriptions.has(key)
      ) {
        this.sendFrame(connection, {
          type: "error",
          requestId,
          code: ERROR_CODES.RATE_LIMITED,
        });
        return;
      }

      // Register before taking authorized revision (Spec §6)

      const sub: LiveSubscription = {
        scope: normalized,
        scopeKey: key,
        lastDeliveredRevision: -1,
        pendingRequestId: requestId,
      };

      connection.subscriptions.set(key, sub);

      // Approval and delivery share the same serialized authorization sweep.
      await this.runSweep();
      return;
    }
  }

  public async runSweep(options?: {
    forceInvalidateAll?: boolean;
  }): Promise<LiveSweepStats> {
    if (this.isStopped) return this.emptyStats();
    this.pendingForceInvalidateAll ||= options?.forceInvalidateAll ?? false;
    this.nextSweepRequested = true;
    if (this.activeSweepPromise) return this.activeSweepPromise;

    const sweep = this.executeSweep();
    this.activeSweepPromise = sweep;
    try {
      return await sweep;
    } finally {
      if (this.activeSweepPromise === sweep) this.activeSweepPromise = null;
    }
  }

  private emptyStats(): LiveSweepStats {
    return {
      durationMs: 0,
      matchCount: 0,
      principalCount: 0,
      connectionCount: this.connections.size,
      subscriptionCount: 0,
      invalidationsEmitted: 0,
      revocationsEmitted: 0,
      disconnectsEmitted: 0,
      queryCost: { durationMs: 0, queries: 0 },
    };
  }

  private async executeSweep(): Promise<LiveSweepStats> {
    let stats = this.emptyStats();
    do {
      const forceInvalidateAll = this.pendingForceInvalidateAll;
      this.pendingForceInvalidateAll = false;
      this.nextSweepRequested = false;
      try {
        stats = await this.performSweep({ forceInvalidateAll });
        if (this.listenerConnected || !this.enableListener)
          this.isDegraded = false;
      } catch {
        this.isDegraded = true;
        this.logger.warn("Live reconciliation failed; delivery is degraded");
      }
    } while (this.nextSweepRequested && !this.isStopped);
    return stats;
  }

  private async performSweep(options: {
    forceInvalidateAll: boolean;
  }): Promise<LiveSweepStats> {
    const sweepStart = performance.now();
    let dbWaitMs = 0;
    let queryCount = 0;
    let invalidationsEmitted = 0;
    let revocationsEmitted = 0;
    let disconnectsEmitted = 0;

    // Fast-path: if no active connections, zero DB queries
    if (this.connections.size === 0) {
      return {
        durationMs: +(performance.now() - sweepStart).toFixed(3),
        matchCount: 0,
        principalCount: 0,
        connectionCount: 0,
        subscriptionCount: 0,
        invalidationsEmitted: 0,
        revocationsEmitted: 0,
        disconnectsEmitted: 0,
        queryCost: { durationMs: 0, queries: 0 },
      };
    }

    // Collect all active connection session and principal IDs
    const sessionIds = new Set<string>();
    const principalIds = new Set<string>();
    const matchIds = new Set<string>();
    let totalSubscriptions = 0;
    const snapshot = Array.from(this.connections.values(), (conn) => ({
      conn,
      subscriptions: Array.from(conn.subscriptions.values()),
    }));

    for (const { conn, subscriptions } of snapshot) {
      if (conn.closed) continue;
      sessionIds.add(conn.sessionId);
      principalIds.add(conn.principalId);

      for (const sub of subscriptions) {
        totalSubscriptions++;
        if (sub.scope.kind === "match" || sub.scope.kind === "chat") {
          matchIds.add(sub.scope.id);
        }
      }
    }

    if (principalIds.size === 0) {
      return {
        durationMs: +(performance.now() - sweepStart).toFixed(3),
        matchCount: 0,
        principalCount: 0,
        connectionCount: this.connections.size,
        subscriptionCount: totalSubscriptions,
        invalidationsEmitted: 0,
        revocationsEmitted: 0,
        disconnectsEmitted: 0,
        queryCost: { durationMs: 0, queries: 0 },
      };
    }

    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      // 1. Transaction boundary: BEGIN
      const tBegin = performance.now();
      await client.query("BEGIN");
      dbWaitMs += performance.now() - tBegin;
      queryCount++;
      inTransaction = true;

      // 2. Lock principals in sorted order FOR SHARE
      // Writers lock principals exclusively (FOR UPDATE) via transaction authority.
      // Shared locks serialize delivery against revocation and prevent the 10s auth gap.
      const sortedPrincipalIds = [...principalIds].sort();
      const tLock = performance.now();
      await client.query(
        `SELECT id FROM next_round.principals WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [sortedPrincipalIds],
      );
      dbWaitMs += performance.now() - tLock;
      queryCount++;

      // 3. Query sessions and principals in one combined query
      const tSess = performance.now();
      const sessResult = await client.query<{
        session_id: string;
        principal_id: string;
        session_auth_epoch: string;
        idle_expires_at: Date;
        absolute_expires_at: Date;
        revoked_at: Date | null;
        kind: "registered" | "guest";
        disabled_at: Date | null;
        principal_auth_epoch: string;
        guest_match_id: string | null;
        inbox_revision: number;
        home_revision: number;
      }>(
        `SELECT s.id AS session_id,
                s.principal_id,
                s.auth_epoch::text AS session_auth_epoch,
                s.idle_expires_at,
                s.absolute_expires_at,
                s.revoked_at,
                p.kind,
                p.disabled_at,
                p.auth_epoch::text AS principal_auth_epoch,
                p.guest_match_id,
                p.inbox_revision::integer AS inbox_revision,
                p.home_revision::integer AS home_revision
           FROM next_round.sessions s
           JOIN next_round.principals p ON p.id = s.principal_id
          WHERE s.id = ANY($1::uuid[])`,
        [[...sessionIds]],
      );
      dbWaitMs += performance.now() - tSess;
      queryCount++;

      const sessionRowMap = new Map<string, (typeof sessResult.rows)[0]>();
      for (const row of sessResult.rows) {
        sessionRowMap.set(row.session_id, row);
      }

      // Guest notification access is limited to the guest's assigned match.
      for (const sess of sessionRowMap.values()) {
        if (sess.kind === "guest" && sess.guest_match_id !== null) {
          matchIds.add(sess.guest_match_id);
        }
      }

      // 4. Query matches and match memberships if any match, chat, or guest notification scopes are present
      const matchMap = new Map<
        string,
        { revision: number; chat_revision: number }
      >();
      const activeMemberSet = new Set<string>(); // key: `${match_id}:${principal_id}`
      const retainedMemberSet = new Set<string>(); // key: `${match_id}:${principal_id}`
      if (matchIds.size > 0) {
        const sortedMatchIds = [...matchIds].sort();

        const tMatch = performance.now();
        const matchResult = await client.query<{
          id: string;
          revision: number;
          chat_revision: number;
        }>(
          `SELECT id, revision::integer AS revision, chat_revision::integer AS chat_revision
             FROM next_round.matches
            WHERE id = ANY($1::uuid[])`,
          [sortedMatchIds],
        );
        dbWaitMs += performance.now() - tMatch;
        queryCount++;

        for (const row of matchResult.rows) {
          matchMap.set(row.id, {
            revision: row.revision,
            chat_revision: row.chat_revision,
          });
        }

        const tMem = performance.now();
        const memResult = await client.query<{
          match_id: string;
          principal_id: string;
          status: string;
        }>(
          `SELECT match_id, principal_id, status
             FROM next_round.match_members
            WHERE match_id = ANY($1::uuid[])
              AND principal_id = ANY($2::uuid[])`,
          [sortedMatchIds, sortedPrincipalIds],
        );
        dbWaitMs += performance.now() - tMem;
        queryCount++;

        for (const row of memResult.rows) {
          const membershipKey = `${row.match_id}:${row.principal_id}`;
          retainedMemberSet.add(membershipKey);
          if (row.status === "active") {
            activeMemberSet.add(membershipKey);
          }
        }
      }

      // 5. Authorization & delivery while locks are held
      const now = Date.now();

      for (const { conn, subscriptions } of snapshot) {
        if (conn.closed) continue;

        const sess = sessionRowMap.get(conn.sessionId);
        if (!sess) {
          this.closeConnection(conn, 4401, "Session expired or revoked");
          disconnectsEmitted++;
          continue;
        }

        const isSessionExpired =
          sess.revoked_at !== null ||
          now >= new Date(sess.idle_expires_at).getTime() ||
          now >= new Date(sess.absolute_expires_at).getTime() ||
          sess.session_auth_epoch !== sess.principal_auth_epoch;

        if (isSessionExpired || sess.disabled_at !== null) {
          const reason =
            sess.disabled_at !== null
              ? "Account disabled or removed"
              : "Session expired or revoked";
          this.closeConnection(conn, 4401, reason);
          disconnectsEmitted++;
          continue;
        }

        for (const sub of subscriptions) {
          if (conn.subscriptions.get(sub.scopeKey) !== sub) continue;
          let isAuthorized = false;
          let currentRevision = 0;

          if (sub.scope.kind === "match") {
            const matchId = sub.scope.id;
            const match = matchMap.get(matchId);
            const guestOk =
              sess.kind !== "guest" || sess.guest_match_id === matchId;
            const isMember = activeMemberSet.has(
              `${matchId}:${conn.principalId}`,
            );

            if (match && guestOk && isMember) {
              isAuthorized = true;
              currentRevision = match.revision;
            }
          } else if (sub.scope.kind === "chat") {
            const matchId = sub.scope.id;
            const match = matchMap.get(matchId);
            const guestOk =
              sess.kind !== "guest" || sess.guest_match_id === matchId;
            const isMember = activeMemberSet.has(
              `${matchId}:${conn.principalId}`,
            );

            if (match && guestOk && isMember) {
              isAuthorized = true;
              currentRevision = match.chat_revision;
            }
          } else if (sub.scope.kind === "notifications") {
            if (sess.kind === "registered") {
              isAuthorized = true;
              currentRevision = sess.inbox_revision;
            } else if (
              sess.guest_match_id !== null &&
              retainedMemberSet.has(
                `${sess.guest_match_id}:${conn.principalId}`,
              )
            ) {
              isAuthorized = true;
              currentRevision = sess.inbox_revision;
            }
          } else if (sub.scope.kind === "home") {
            if (sess.kind === "registered") {
              isAuthorized = true;
              currentRevision = sess.home_revision;
            }
          }

          if (sub.pendingRequestId !== undefined) {
            const reqId = sub.pendingRequestId;
            sub.pendingRequestId = undefined;

            if (isAuthorized) {
              sub.lastDeliveredRevision = currentRevision;
              this.sendFrame(conn, {
                type: "subscribed",
                requestId: reqId,
                scope: sub.scope,
                revision: currentRevision,
              });
            } else {
              conn.subscriptions.delete(sub.scopeKey);
              this.sendFrame(conn, {
                type: "error",
                requestId: reqId,
                code: ERROR_CODES.NOT_FOUND,
              });
            }
          } else {
            if (!isAuthorized) {
              conn.subscriptions.delete(sub.scopeKey);
              this.sendFrame(conn, {
                type: "access_revoked",
                scope: sub.scope,
              });
              revocationsEmitted++;
            } else {
              if (
                options.forceInvalidateAll ||
                currentRevision > sub.lastDeliveredRevision
              ) {
                sub.lastDeliveredRevision = currentRevision;
                this.sendFrame(conn, {
                  type: "invalidate",
                  scope: sub.scope,
                  revision: currentRevision,
                });
                invalidationsEmitted++;
              }
            }
          }
        }
      }

      // 6. Transaction boundary: COMMIT
      const tCommit = performance.now();
      await client.query("COMMIT");
      dbWaitMs += performance.now() - tCommit;
      queryCount++;
      inTransaction = false;

      const totalDurationMs = +(performance.now() - sweepStart).toFixed(3);
      const stats: LiveSweepStats = {
        durationMs: totalDurationMs,
        matchCount: matchIds.size,
        principalCount: principalIds.size,
        connectionCount: this.connections.size,
        subscriptionCount: totalSubscriptions,
        invalidationsEmitted,
        revocationsEmitted,
        disconnectsEmitted,
        queryCost: {
          durationMs: +dbWaitMs.toFixed(3),
          queries: queryCount,
        },
      };

      this.logger.info(stats, "Live reconciliation sweep");
      if (this.onSweep) {
        try {
          this.onSweep(stats);
        } catch {
          // Non-blocking
        }
      }

      return stats;
    } catch (err) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Ignore rollback failure
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private sendFrame(
    connection: LiveConnection,
    frame: ServerLiveFrame,
  ): boolean {
    if (
      connection.closed ||
      connection.socket.readyState !== connection.socket.OPEN
    ) {
      return false;
    }

    if (connection.socket.bufferedAmount > this.maxBufferedAmount) {
      this.logger.warn(
        {
          connectionId: connection.id,
          bufferedAmount: connection.socket.bufferedAmount,
        },
        "Slow consumer exceeded buffer threshold; closing connection",
      );
      this.closeConnection(connection, 1013, "Try again later");
      return false;
    }

    try {
      connection.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      this.logger.warn(
        { connectionId: connection.id },
        "Failed to send frame to WebSocket",
      );
      return false;
    }
  }

  public closeConnection(
    connection: LiveConnection,
    code = 1000,
    reason = "Normal closure",
  ): void {
    if (connection.closed) return;
    connection.closed = true;

    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = undefined;
    }

    try {
      if (
        connection.socket.readyState === connection.socket.OPEN ||
        connection.socket.readyState === connection.socket.CONNECTING
      ) {
        connection.socket.close(code, reason);
      }
    } catch {
      // Ignore socket closing error
    }

    this.removeConnection(connection);
  }

  private removeConnection(connection: LiveConnection): void {
    connection.closed = true;
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = undefined;
    }

    if (this.connections.delete(connection.id)) {
      const remaining =
        (this.principalConnections.get(connection.principalId) ?? 1) - 1;
      if (remaining === 0) this.principalConnections.delete(connection.principalId);
      else this.principalConnections.set(connection.principalId, remaining);
    }

    connection.subscriptions.clear();
  }
}
