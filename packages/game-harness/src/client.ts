// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";
import {
  ERROR_CODES,
  LIVE_SUBPROTOCOL,
  type CommandReceipt,
  type CreateMatchResponse,
  type Json,
  type MatchCommandEnvelope,
  type ServerLiveFrame,
} from "@next-round/contracts";
import type { MatchSnapshot } from "@next-round/game-client";
import type { HarnessFaultInjector, SimulatedClient, SimulatedSession } from "./index.js";

export interface HttpClientOptions {
  baseUrl: string;
  faults?: HarnessFaultInjector;
  timeoutMs?: number;
  onError?: (error: Error) => void;
}

export class HarnessHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Harness HTTP request failed (${status}, ${code}).`);
    this.name = "HarnessHttpError";
  }
}

function safeCode(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value)
    ? value
    : "HTTP_ERROR";
}

export function validateBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid harness base URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("Harness base URL must be a secure origin (HTTP is loopback-only).");
  }
  return url;
}

function timeoutMs(options: HttpClientOptions): number {
  const value = options.timeoutMs ?? 5000;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid harness timeout.");
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Auth/session provisioning shares the same origin, timeout and safe-error policy. */
export async function requestData<T>(
  options: HttpClientOptions,
  session: SimulatedSession | undefined,
  route: string,
  body?: unknown
): Promise<{ data: T; response: Response }> {
  const origin = validateBaseUrl(options.baseUrl).origin;
  if (!route.startsWith("/") || route.startsWith("//") || /[?#\\]/.test(route)) {
    throw new Error("Invalid harness API route.");
  }
  const timeout = timeoutMs(options);
  const delay = options.faults?.consume("network_delay", { channel: route });
  if (delay?.delayMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay.delayMs));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers: Record<string, string> = { Origin: origin, Accept: "application/json" };
    if (session) headers.Cookie = session.cookie;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      if (session) headers["X-CSRF-Token"] = session.csrfToken;
    }
    const response = await fetch(`${origin}/api/v1${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: controller.signal,
    });
    const envelope: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = record(envelope) && record(envelope.error) ? envelope.error : undefined;
      throw new HarnessHttpError(response.status, safeCode(error?.code));
    }
    if (!record(envelope) || !Object.hasOwn(envelope, "data")) {
      throw new Error("Invalid harness API response.");
    }
    return { data: envelope.data as T, response };
  } catch (error) {
    if (error instanceof HarnessHttpError) throw error;
    throw new Error("Harness HTTP request failed.");
  } finally {
    clearTimeout(timer);
  }
}

type SnapshotListener = (snapshot: MatchSnapshot) => void;
type Scope = {
  matchId: string;
  listeners: Set<SnapshotListener>;
  snapshot?: MatchSnapshot;
  subscribed: boolean;
  subscription?: Promise<void>;
  refresh?: Promise<MatchSnapshot>;
  wantedRevision: number;
};
type SubscriptionWait = {
  scope: Scope;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
};

/** A Node client of the real API; it never supplies a local game implementation. */
export class HttpSimulatedClient implements SimulatedClient {
  readonly connectionState = { wsConnected: false, activeMatchId: null as string | null };
  private readonly snapshots: MatchSnapshot[] = [];
  private readonly receipts: CommandReceipt[] = [];
  private readonly errors: Error[] = [];
  private readonly scopes = new Map<string, Scope>();
  private readonly revoked = new Set<string>();
  private readonly pending = new Map<string, SubscriptionWait>();
  private socket?: WebSocket;
  private stopSocket?: (error: Error) => void;
  private connecting?: Promise<void>;
  private sessionRevoked = false;
  private readonly options: HttpClientOptions;

  constructor(readonly session: SimulatedSession, options: HttpClientOptions) {
    this.options = { ...options, baseUrl: validateBaseUrl(options.baseUrl).origin };
    timeoutMs(options);
  }

  get receivedSnapshots(): readonly MatchSnapshot[] { return this.snapshots; }
  get receivedReceipts(): readonly CommandReceipt[] { return this.receipts; }
  get receivedErrors(): readonly Error[] { return this.errors; }

  private report(error: unknown): void {
    const safe = error instanceof HarnessHttpError ? error : new Error("Harness live operation failed.");
    this.errors.push(safe);
    // Consumer diagnostics must not create an unhandled rejection themselves.
    try {
      void Promise.resolve(this.options.onError?.(safe)).catch(() => {});
    } catch {
      // The transport error remains observable through receivedErrors.
    }
  }

  private scope(matchId: string): Scope {
    if (this.sessionRevoked || this.revoked.has(matchId)) {
      throw new Error("Harness match access is unavailable.");
    }
    let scope = this.scopes.get(matchId);
    if (!scope) {
      scope = { matchId, listeners: new Set(), subscribed: false, wantedRevision: -1 };
      this.scopes.set(matchId, scope);
    }
    return scope;
  }

  private current(scope: Scope): boolean {
    return !this.sessionRevoked && this.scopes.get(scope.matchId) === scope;
  }

  private interested(scope: Scope): boolean {
    return scope.listeners.size > 0 || this.connectionState.activeMatchId === scope.matchId;
  }

  connectWs(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.connectionState.wsConnected) return Promise.resolve();
    if (this.sessionRevoked) return Promise.reject(new Error("Harness session access is unavailable."));
    const url = new URL("/api/v1/live", this.options.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, LIVE_SUBPROTOCOL, {
        headers: { Origin: this.options.baseUrl, Cookie: this.session.cookie },
        maxPayload: 16 * 1024,
        handshakeTimeout: timeoutMs(this.options),
      });
    } catch {
      return Promise.reject(new Error("Harness WebSocket connection failed."));
    }
    this.socket = socket;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => stop(new Error("Harness WebSocket connection timed out.")), timeoutMs(this.options));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const stop = (error: Error) => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.stopSocket = undefined;
          this.connectionState.wsConnected = false;
          for (const scope of this.scopes.values()) {
            scope.subscribed = false;
            scope.subscription = undefined;
          }
          this.rejectSubscriptions(error);
        }
        finish(error);
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      };
      const onOpen = () => {
        if (this.socket !== socket) return;
        clearTimeout(timer);
        this.connectionState.wsConnected = true;
        const scopes = [...this.scopes.values()].filter((scope) => this.interested(scope));
        void Promise.all(scopes.map((scope) => this.subscribe(scope))).then(
          () => {
            if (this.socket === socket) finish();
            else finish(new Error("Harness WebSocket disconnected."));
          },
          (error: unknown) => stop(error instanceof HarnessHttpError ? error : new Error("Harness WebSocket subscription failed."))
        );
      };
      const onMessage = (data: RawData) => {
        if (this.socket === socket) this.receive(data);
      };
      const onError = () => {
        if (settled && this.socket === socket) this.report(new Error("Harness WebSocket failed."));
        stop(new Error("Harness WebSocket connection failed."));
      };
      const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
        response.destroy();
        stop(new Error("Harness WebSocket upgrade failed."));
      };
      const onClose = (code: number) => {
        if (this.socket === socket && code === 4401) this.revokeSession();
        const wasConnected = this.socket === socket && this.connectionState.wsConnected;
        stop(new Error("Harness WebSocket disconnected."));
        socket.off("open", onOpen);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpectedResponse);
        socket.off("close", onClose);
        if (wasConnected && settled) this.report(new Error("Harness WebSocket disconnected."));
      };
      this.stopSocket = stop;
      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.on("unexpected-response", onUnexpectedResponse);
      socket.on("close", onClose);
    });
    this.connecting = promise;
    void promise.then(
      () => { if (this.connecting === promise) this.connecting = undefined; },
      () => { if (this.connecting === promise) this.connecting = undefined; }
    );
    return promise;
  }

  disconnectWs(): void {
    this.stopSocket?.(new Error("Harness WebSocket disconnected."));
    this.connecting = undefined;
  }

  async reconnectWs(): Promise<void> {
    this.disconnectWs();
    await this.connectWs();
  }

  private rejectSubscriptions(error: Error, scope?: Scope): void {
    for (const [id, wait] of this.pending) {
      if (scope && wait.scope !== scope) continue;
      this.pending.delete(id);
      clearTimeout(wait.timer);
      wait.reject(error);
    }
  }

  private subscribe(scope: Scope): Promise<void> {
    if (scope.subscription) return scope.subscription;
    if (scope.subscribed) return Promise.resolve();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.current(scope)) {
      return Promise.reject(new Error("Harness WebSocket is unavailable."));
    }
    const requestId = randomUUID();
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Harness WebSocket subscription timed out."));
      }, timeoutMs(this.options));
      this.pending.set(requestId, { scope, timer, resolve, reject });
      try {
        socket.send(JSON.stringify({
          type: "subscribe", requestId, scope: { kind: "match", id: scope.matchId },
          ...(scope.snapshot ? { knownRevision: scope.snapshot.revision } : {}),
        }), (error) => {
          if (!error) return;
          const wait = this.pending.get(requestId);
          if (wait) {
            this.pending.delete(requestId);
            clearTimeout(wait.timer);
            wait.reject(new Error("Harness WebSocket subscription failed."));
          }
        });
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("Harness WebSocket subscription failed."));
      }
    });
    const subscription = acknowledged.then(async () => {
      if (this.socket !== socket || !this.current(scope)) throw new Error("Harness match access is unavailable.");
      // An HTTP read begun before acknowledgement is not the required post-ack read.
      if (scope.refresh) {
        try { await scope.refresh; } catch { /* Retry the authorized read below. */ }
        if (this.socket !== socket || !this.current(scope)) throw new Error("Harness match access is unavailable.");
      }
      scope.subscribed = true;
      await this.refresh(scope);
    });
    scope.subscription = subscription;
    void subscription.then(
      () => { if (scope.subscription === subscription) scope.subscription = undefined; },
      () => {
        if (scope.subscription === subscription) {
          scope.subscription = undefined;
          scope.subscribed = false;
        }
      }
    );
    return subscription;
  }

  private receive(data: RawData): void {
    let frame: ServerLiveFrame;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!record(parsed) || typeof parsed.type !== "string") throw new Error();
      frame = parsed as ServerLiveFrame;
    } catch {
      this.report(new Error("Invalid harness WebSocket frame."));
      return;
    }
    if (frame.type === "error") {
      const wait = this.pending.get(frame.requestId);
      if (wait) {
        this.pending.delete(frame.requestId);
        clearTimeout(wait.timer);
        wait.reject(new Error("Harness WebSocket subscription rejected."));
      } else this.report(new Error("Harness WebSocket request failed."));
      return;
    }
    if (frame.type !== "subscribed" && frame.type !== "invalidate" && frame.type !== "access_revoked") return;
    if (!record(frame.scope) || frame.scope.kind !== "match" || typeof frame.scope.id !== "string") return;
    const scope = this.scopes.get(frame.scope.id);
    if (frame.type === "access_revoked") {
      this.revokeMatch(frame.scope.id);
      return;
    }
    if (!scope || !this.interested(scope)) return;
    if (frame.type === "subscribed") {
      const wait = this.pending.get(frame.requestId);
      if (!wait || wait.scope !== scope || !Number.isSafeInteger(frame.revision) || frame.revision < 0) return;
      scope.wantedRevision = Math.max(scope.wantedRevision, frame.revision);
      this.pending.delete(frame.requestId);
      clearTimeout(wait.timer);
      wait.resolve();
      return;
    }
    if (!Number.isSafeInteger(frame.revision) || frame.revision === undefined || frame.revision < 0) return;
    if (frame.revision <= (scope.snapshot?.revision ?? -1)) return;
    scope.wantedRevision = Math.max(scope.wantedRevision, frame.revision);
    // Before acknowledgement, remember the invalidation, but do not fetch yet.
    if (scope.subscribed) void this.refresh(scope).catch((error: unknown) => this.report(error));
  }

  private refresh(scope: Scope): Promise<MatchSnapshot> {
    if (scope.refresh) return scope.refresh;
    const refresh = (async () => {
      const deadline = Date.now() + timeoutMs(this.options);
      let result: MatchSnapshot;
      do {
        if (Date.now() >= deadline) throw new Error("Harness snapshot refresh timed out.");
        let data: MatchSnapshot;
        try {
          ({ data } = await requestData<MatchSnapshot>(
            this.options, this.session, `/matches/${encodeURIComponent(scope.matchId)}`
          ));
        } catch (error) {
          if (error instanceof HarnessHttpError) {
            if (error.status === 401) {
              this.revokeSession();
              this.disconnectWs();
            } else if (error.status === 403 || error.status === 404) {
              this.revokeMatch(scope.matchId);
            }
          }
          throw error;
        }
        if (!this.current(scope)) throw new Error("Harness match access is unavailable.");
        if (!record(data) || data.id !== scope.matchId || !Number.isSafeInteger(data.revision) || data.revision < 0) {
          throw new Error("Invalid harness snapshot response.");
        }
        if (!scope.snapshot || data.revision >= scope.snapshot.revision) {
          scope.snapshot = data;
          this.snapshots.push(data);
          for (const listener of [...scope.listeners]) {
            if (!this.current(scope)) break;
            try {
              void Promise.resolve(listener(data)).catch(() => this.report(new Error("Harness snapshot listener failed.")));
            } catch { this.report(new Error("Harness snapshot listener failed.")); }
          }
        }
        result = scope.snapshot;
      } while (this.current(scope) && result.revision < scope.wantedRevision);
      return result;
    })();
    scope.refresh = refresh;
    void refresh.then(
      () => { if (scope.refresh === refresh) scope.refresh = undefined; },
      () => { if (scope.refresh === refresh) scope.refresh = undefined; }
    );
    return refresh;
  }

  getSnapshot(matchId: string): Promise<MatchSnapshot> {
    try { return this.refresh(this.scope(matchId)); }
    catch { return Promise.reject(new Error("Harness match access is unavailable.")); }
  }

  onSnapshot(matchId: string, listener: SnapshotListener): () => void {
    const scope = this.scope(matchId);
    scope.listeners.add(listener);
    if (this.connectionState.wsConnected) void this.subscribe(scope).catch((error: unknown) => this.report(error));
    return () => {
      scope.listeners.delete(listener);
      if (this.current(scope) && !this.interested(scope)) this.removeScope(scope);
    };
  }

  private removeScope(scope: Scope): void {
    this.scopes.delete(scope.matchId);
    this.rejectSubscriptions(new Error("Harness match subscription removed."), scope);
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "unsubscribe", requestId: randomUUID(), scope: { kind: "match", id: scope.matchId } }),
          (error) => { if (error) this.report(new Error("Harness WebSocket unsubscribe failed.")); });
      } catch { this.report(new Error("Harness WebSocket unsubscribe failed.")); }
    }
  }

  private revokeMatch(matchId: string): void {
    this.revoked.add(matchId);
    const scope = this.scopes.get(matchId);
    if (scope) {
      this.rejectSubscriptions(new Error("Harness match access is unavailable."), scope);
      scope.listeners.clear();
      scope.snapshot = undefined;
      this.scopes.delete(matchId);
    }
    if (this.connectionState.activeMatchId === matchId) this.connectionState.activeMatchId = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]?.id === matchId) this.snapshots.splice(i, 1);
    }
  }

  private revokeSession(): void {
    this.sessionRevoked = true;
    for (const matchId of this.scopes.keys()) this.revokeMatch(matchId);
    this.connectionState.activeMatchId = null;
    this.snapshots.length = 0;
  }

  private async setActive(matchId: string): Promise<void> {
    const old = this.connectionState.activeMatchId;
    this.revoked.delete(matchId);
    this.connectionState.activeMatchId = matchId;
    if (old && old !== matchId) {
      const previous = this.scopes.get(old);
      if (previous && !this.interested(previous)) this.removeScope(previous);
    }
    const scope = this.scope(matchId);
    if (this.connectionState.wsConnected) {
      // The mutation has committed; a live refresh failure must not mask its success.
      try { await this.subscribe(scope); } catch (error) { this.report(error); }
    }
  }

  private async mutate<T>(route: string, body: unknown, matchId?: string): Promise<T> {
    let data: T;
    try {
      ({ data } = await requestData<T>(this.options, this.session, route, body));
    } catch (error) {
      if (error instanceof HarnessHttpError && error.status === 401) {
        this.revokeSession();
        this.disconnectWs();
      }
      throw error;
    }
    if (this.options.faults?.consume("post_commit_failure", { matchId, channel: route })) {
      throw new Error("Harness simulated response loss after successful HTTP response.");
    }
    return data;
  }

  async createMatch(moduleId: string, mode: string, settings: Json = {}, visibility: "invite" | "instance" = "invite"): Promise<{ matchId: string }> {
    const data = await this.mutate<CreateMatchResponse>("/matches", { commandId: randomUUID(), moduleId, mode, settings, visibility });
    await this.setActive(data.matchId);
    return { matchId: data.matchId };
  }

  async joinMatch(matchId: string, expectedRevision: number, linkToken?: string): Promise<void> {
    const receipt = await this.mutate<CommandReceipt>(`/matches/${encodeURIComponent(matchId)}/join`, {
      commandId: randomUUID(), expectedRevision, ...(linkToken === undefined ? {} : { linkToken }),
    }, matchId);
    this.receipts.push(receipt);
    await this.setActive(matchId);
  }

  async startMatch(matchId: string, expectedRevision: number): Promise<void> {
    const receipt = await this.mutate<CommandReceipt>(`/matches/${encodeURIComponent(matchId)}/start`, { commandId: randomUUID(), expectedRevision }, matchId);
    this.receipts.push(receipt);
  }

  act(matchId: string, action: { type: string; payload: Json; commandId?: string; expectedRevision: number }): Promise<CommandReceipt> {
    return this.replayCommand(matchId, { commandId: action.commandId ?? randomUUID(), expectedRevision: action.expectedRevision, type: action.type, payload: action.payload });
  }

  async replayCommand(matchId: string, action: MatchCommandEnvelope): Promise<CommandReceipt> {
    const receipt = await this.mutate<CommandReceipt>(`/matches/${encodeURIComponent(matchId)}/actions`, action, matchId);
    this.receipts.push(receipt);
    return receipt;
  }

  async createGuestInvitation(matchId: string): Promise<{ token: string }> {
    const data = await this.mutate<{ url: string }>(
      `/matches/${encodeURIComponent(matchId)}/guest-invitations`,
      { commandId: randomUUID() },
      matchId
    );
    try {
      const fragment = new URL(data.url).hash.slice(1);
      const token = fragment.startsWith("token=")
        ? new URLSearchParams(fragment).get("token")
        : decodeURIComponent(fragment);
      if (!token) throw new Error();
      return { token };
    } catch {
      throw new Error("Invalid harness guest invitation response.");
    }
  }

  async leaveMatch(matchId: string, expectedRevision: number): Promise<void> {
    const receipt = await this.mutate<CommandReceipt>(`/matches/${encodeURIComponent(matchId)}/leave`, { commandId: randomUUID(), expectedRevision }, matchId);
    this.receipts.push(receipt);
    this.revokeMatch(matchId);
  }
}
