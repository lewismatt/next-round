// SPDX-License-Identifier: Apache-2.0
import { LIVE_SUBPROTOCOL } from "@next-round/contracts";
import type { LiveScope, ServerLiveFrame } from "@next-round/contracts";

export interface LiveBinding {
  scope: LiveScope;
  knownRevision?: () => number | undefined;
  onRefresh: (reason: "subscribed" | "invalidate", revision?: number) => void;
  onRevoked?: () => void;
}

function scopeKey(scope: LiveScope): string {
  return scope.kind === "home" || scope.kind === "notifications"
    ? scope.kind
    : `${scope.kind}:${scope.id}`;
}

export class LiveClient {
  private readonly bindings = new Map<string, LiveBinding>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 500;
  private stopped = false;
  private readonly onSessionExpired: () => void;

  constructor(bindings: LiveBinding[], onSessionExpired: () => void) {
    this.onSessionExpired = onSessionExpired;
    for (const binding of bindings)
      this.bindings.set(scopeKey(binding.scope), binding);
    this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "Route changed");
    this.bindings.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${scheme}//${location.host}/api/v1/live`,
      LIVE_SUBPROTOCOL,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      this.reconnectDelay = 500;
      for (const binding of this.bindings.values())
        this.subscribe(socket, binding);
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let frame: ServerLiveFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerLiveFrame;
      } catch {
        return;
      }
      if (frame.type === "subscribed") {
        const binding = this.bindings.get(scopeKey(frame.scope));
        binding?.onRefresh("subscribed", frame.revision);
        return;
      }
      if (frame.type === "invalidate") {
        const binding = this.bindings.get(scopeKey(frame.scope));
        binding?.onRefresh("invalidate", frame.revision);
        return;
      }
      if (frame.type === "access_revoked") {
        this.bindings.get(scopeKey(frame.scope))?.onRevoked?.();
        return;
      }
      if (frame.type === "error" && frame.code === "AUTH_REQUIRED") {
        this.onSessionExpired();
      }
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === 4401) this.onSessionExpired();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    });
  }

  private subscribe(socket: WebSocket, binding: LiveBinding): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const requestId = crypto.randomUUID();
    const knownRevision = binding.knownRevision?.();
    socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId,
        scope: binding.scope,
        ...(knownRevision === undefined ? {} : { knownRevision }),
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay =
      Math.min(30_000, this.reconnectDelay) * (0.8 + Math.random() * 0.4);
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
