// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { WebSocket } from "@fastify/websocket";
import type { DatabasePool } from "@next-round/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveService } from "./live/live-service.js";

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly frames: Array<Record<string, unknown>> = [];
  readonly closures: Array<{ code: number; reason: string }> = [];
  send(frame: string) {
    this.frames.push(JSON.parse(frame) as Record<string, unknown>);
  }
  ping() {}
  close(code: number, reason: string) {
    this.closures.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }
  get websocket() {
    return this as unknown as WebSocket;
  }
  frame(text = '{"type":"ping","requestId":"budget"}') {
    this.emit("message", Buffer.from(text));
  }
}

const services: LiveService[] = [];
function service(maxConnections = 3, maxConnectionsPerPrincipal = 2) {
  const live = new LiveService({
    databasePool: {} as DatabasePool,
    enableListener: false,
    maxConnections,
    maxConnectionsPerPrincipal,
  });
  services.push(live);
  return live;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((live) => live.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("live admission and input resource boundaries", () => {
  it("enforces principal and global caps, releasing each slot exactly once", () => {
    vi.useFakeTimers();
    const live = service();
    const a = new Socket();
    const b = new Socket();
    const c = new Socket();
    expect(live.registerConnection(a.websocket, "alice", "a")).not.toBeNull();
    expect(live.registerConnection(b.websocket, "alice", "b")).not.toBeNull();
    const principalRejected = new Socket();
    expect(
      live.registerConnection(principalRejected.websocket, "alice", "c"),
    ).toBeNull();
    expect(principalRejected.frames).toEqual([]);
    expect(principalRejected.closures).toEqual([
      { code: 1008, reason: "Connection limit exceeded" },
    ]);
    expect(vi.getTimerCount()).toBe(2);
    expect(live.registerConnection(c.websocket, "bob", "c")).not.toBeNull();
    const totalRejected = new Socket();
    expect(
      live.registerConnection(totalRejected.websocket, "carol", "d"),
    ).toBeNull();
    expect(totalRejected.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(3);
    a.emit("close");
    a.emit("error", new Error("late socket error"));
    const replacement = new Socket();
    expect(
      live.registerConnection(replacement.websocket, "alice", "replacement"),
    ).not.toBeNull();
    expect(
      live.registerConnection(new Socket().websocket, "carol", "still-full"),
    ).toBeNull();
    replacement.frame();
    expect(replacement.frames.at(-1)?.type).toBe("pong");
  });

  it("charges malformed frames, closes the exhausted socket, and leaves a peer usable", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const live = service();
    const abusive = new Socket();
    const peer = new Socket();
    live.registerConnection(abusive.websocket, "alice", "a");
    live.registerConnection(peer.websocket, "bob", "b");
    for (let n = 0; n < 40; n++) abusive.frame("not JSON");
    expect(abusive.closures).toEqual([]);
    abusive.frame();
    expect(abusive.closures).toEqual([
      { code: 1008, reason: "Message rate exceeded" },
    ]);
    const frameCount = abusive.frames.length;
    abusive.frame();
    expect(abusive.frames.length).toBe(frameCount);
    peer.frame();
    expect(peer.frames.at(-1)?.type).toBe("pong");
  });

  it("refills one token after 50ms without granting an extra frame at that instant", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const live = service();
    const socket = new Socket();
    live.registerConnection(socket.websocket, "alice", "a");
    for (let n = 0; n < 40; n++) socket.frame();
    now += 50;
    socket.frame();
    expect(socket.closures).toEqual([]);
    expect(socket.frames.at(-1)?.type).toBe("pong");
    socket.frame();
    expect(socket.closures).toEqual([
      { code: 1008, reason: "Message rate exceeded" },
    ]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid admission limit %s",
    (value) => {
      expect(() => service(value, 2)).toThrow();
      expect(() => service(3, value)).toThrow();
    },
  );
});
