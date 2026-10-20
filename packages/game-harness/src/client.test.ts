// SPDX-License-Identifier: Apache-2.0
import type { IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_SUBPROTOCOL,
  type ClientLiveFrame,
  type CommandReceipt,
  type Json,
  type ServerLiveFrame,
} from "@next-round/contracts";
import type { MatchSnapshot } from "@next-round/game-client";
import { HarnessCommandError, HarnessHttpError, HttpSimulatedClient } from "./client.js";
import { HarnessEnvironment, HarnessFaultInjector, setupMultiplayerCounterScenario, type SimulatedSession } from "./index.js";

const NOW = "2026-10-18T12:00:00.000Z";
const MATCH = "00000000-0000-4000-8000-000000000001";
const OTHER_MATCH = "00000000-0000-4000-8000-000000000002";
const CREATED_MATCH = "00000000-0000-4000-8000-000000000003";
const COMMAND = "10000000-0000-4000-8000-000000000001";

function deferred<T>() {
  // ES2022 does not expose Promise.withResolvers.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && Object.values(value).every(isJson);
}

function objectBody(value: unknown): Record<string, Json> {
  if (value === undefined) return {};
  if (!isJson(value) || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Protocol oracle expected a JSON object");
  }
  return value;
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Transport fixture observation timed out");
    await delay(5);
  }
}

function session(name: string): SimulatedSession {
  return {
    principalId: `principal-${name}`,
    kind: "registered",
    displayName: name,
    username: name,
    guestMatchId: null,
    cookie: `__Host-next-round-session=private-cookie-${name}`,
    csrfToken: `private-csrf-${name}`,
  };
}

function snapshot(id: string, principalId: string, revision: number): MatchSnapshot {
  return {
    id,
    moduleId: "protocol-oracle",
    moduleVersion: "0.1.0",
    revision,
    phase: "active",
    mode: "cooperative",
    settings: {},
    hostMemberId: "member-host",
    members: [{
      id: `member-${principalId}`,
      principalId,
      kind: "registered",
      displayName: principalId,
      status: "active",
      joinOrdinal: 0,
      disabled: false,
      accessEpoch: 1,
    }],
    deadlines: [],
    serverNow: NOW,
    capabilities: {
      canStart: false, canLeave: true, canInvite: true,
      canFinish: true, canChat: true, canAct: true,
    },
    game: { privateFor: principalId, hand: [`private-card-${principalId}`] },
  };
}

interface RecordedRequest {
  method: string;
  route: string;
  principalId: string;
  body: Record<string, Json>;
  cookie: string | undefined;
  origin: string | undefined;
  csrf: string | string[] | undefined;
}

interface FixtureRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  params: { id?: string };
  body: unknown;
}

interface FixtureReply {
  code(status: number): FixtureReply;
  header(name: string, value: string): FixtureReply;
  send(value: unknown): void;
}

type FixtureHandler = (request: FixtureRequest, reply: FixtureReply) => unknown;

// Resolve API-owned runtime dependencies without importing its TS project sources.
interface FixtureApp {
  register(plugin: unknown): Promise<void>;
  addHook(name: "onRequest", handler: FixtureHandler): void;
  get(route: string, handler: FixtureHandler): void;
  get(route: string, options: { websocket: true }, handler: (socket: WebSocket, request: FixtureRequest) => void): void;
  post(route: string, handler: FixtureHandler): void;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
// Known installed API modules, not untrusted wire values.
const fastify = apiRequire("fastify") as (options: { logger: false }) => FixtureApp;
const websocket: unknown = apiRequire("@fastify/websocket");

interface ScriptedReply {
  delayMs?: number;
  status?: number;
  data?: Json;
  code?: string;
}

const cleanup: Array<() => Promise<void>> = [];
const clients: HttpSimulatedClient[] = [];

afterEach(async () => {
  for (const instance of clients.splice(0)) instance.disconnectWs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * Test-only wire oracle: fixed caller-specific projections and scripted replies.
 * This has no persistence, reducers, transaction semantics or platform acceptance claims.
 */
async function fixture(
  upgrade: "accept" | "reject" | "hang" = "accept",
  authReply: "complete" | "missing_cookie" | "missing_csrf" = "complete",
  publicOrigin?: string,
) {
  const alice = session("alice");
  const bob = session("bob");
  const guest: SimulatedSession = { ...session("guest"), kind: "guest", username: null, guestMatchId: CREATED_MATCH };
  const identities = [alice, bob, guest];
  const app = fastify({ logger: false });
  const sockets = new Map<WebSocket, string>();
  const requests: RecordedRequest[] = [];
  const logins: unknown[] = [];
  const subscriptions: Array<{ principalId: string; frame: ClientLiveFrame }> = [];
  const revisions = new Map([[MATCH, 4], [OTHER_MATCH, 6], [CREATED_MATCH, 0]]);
  const denied = new Set<string>();
  const scripts = new Map<string, ScriptedReply[]>();
  const releases = new Set<() => void>();
  const holds = new Map<string, { arrived: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }>();
  let origin = "";
  let subscriptionHold: { arrived: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  interface ActionHold {
    needed: number;
    count: number;
    arrived: { promise: Promise<void>; resolve: (value: void) => void };
    release: { promise: Promise<void>; resolve: (value: void) => void };
  }
  let actionHold: ActionHold | undefined;
  const key = (principalId: string, matchId: string) => `${principalId}:${matchId}`;

  cleanup.push(async () => {
    for (const release of releases) release();
    for (const socket of sockets.keys()) socket.terminate();
    await app.close();
  });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    const expectedOrigin = publicOrigin ?? origin;
    if (["/api/v1/auth/login", "/api/v1/guest-invitations/redeem"].includes(request.url) && request.headers.origin === expectedOrigin) return;
    const identity = identities.find((candidate) => candidate.cookie === request.headers.cookie);
    if (!identity || request.headers.origin !== expectedOrigin) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: `secret ${alice.cookie} ${alice.csrfToken}` } });
    }
    if (request.method !== "GET" && request.headers["x-csrf-token"] !== identity.csrfToken) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: identity.csrfToken } });
    }
    if (request.url === "/api/v1/live") {
      if (request.headers["sec-websocket-protocol"] !== LIVE_SUBPROTOCOL || upgrade === "reject") {
        return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: identity.cookie } });
      }
      if (upgrade === "hang") {
        const wait = deferred<void>();
        releases.add(() => wait.resolve());
        await wait.promise;
      }
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    logins.push(request.body);
    const identity = {
      ...(objectBody(request.body).username === "bob" ? bob : alice),
      cookie: `__Host-next-round-session=private-login-cookie-${logins.length}`,
    };
    identities.push(identity);
    if (authReply !== "missing_cookie") {
      reply.header("set-cookie", `${identity.cookie}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return { data: {
      principal: {
        id: identity.principalId, kind: identity.kind,
        displayName: identity.displayName, username: identity.username,
      },
      ...(authReply === "missing_csrf" ? {} : { csrfToken: identity.csrfToken }),
      expiresAt: "2026-11-18T12:00:00.000Z",
    }, serverNow: NOW };
  });

  app.post("/api/v1/guest-invitations/redeem", async (request, reply) => {
    const body = objectBody(request.body);
    if (body.token !== "private-invitation") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    reply.header("set-cookie", `${guest.cookie}; Path=/; HttpOnly; SameSite=Lax`);
    return { data: {
      principal: { id: guest.principalId, kind: guest.kind, displayName: guest.displayName, username: null },
      csrfToken: guest.csrfToken, matchId: guest.guestMatchId,
      expiresAt: "2026-11-18T12:00:00.000Z",
    }, serverNow: NOW };
  });

  app.get("/api/v1/live", { websocket: true }, (socket, request) => {
    const identity = identities.find((candidate) => candidate.cookie === request.headers.cookie)!;
    sockets.set(socket, identity.principalId);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: "hello", connectionId: "fixture-connection", serverNow: NOW, heartbeatSeconds: 25 }));
    socket.on("message", async (raw) => {
      const incoming: unknown = JSON.parse(raw.toString());
      if (!incoming || typeof incoming !== "object" ||
        !("type" in incoming) || incoming.type !== "subscribe" ||
        !("requestId" in incoming) || typeof incoming.requestId !== "string" ||
        !("scope" in incoming) || !incoming.scope || typeof incoming.scope !== "object" ||
        !("kind" in incoming.scope) || incoming.scope.kind !== "match" ||
        !("id" in incoming.scope) || typeof incoming.scope.id !== "string") return;
      const frame: ClientLiveFrame = {
        type: "subscribe", requestId: incoming.requestId,
        scope: { kind: "match", id: incoming.scope.id },
      };
      subscriptions.push({ principalId: identity.principalId, frame });
      const acknowledgedRevision = revisions.get(incoming.scope.id) ?? 0;
      if (subscriptionHold) {
        subscriptionHold.arrived.resolve();
        await subscriptionHold.release.promise;
      }
      socket.send(JSON.stringify({
        type: "subscribed", requestId: frame.requestId,
        scope: frame.scope, revision: acknowledgedRevision,
      }));
    });
  });

  const record = (method: string, route: string, cookie: string | undefined,
    requestOrigin: string | undefined, csrf: string | string[] | undefined, body: unknown) => {
    const identity = identities.find((candidate) => candidate.cookie === cookie)!;
    requests.push({ method, route, principalId: identity.principalId, cookie, origin: requestOrigin, csrf, body: objectBody(body) });
    return identity;
  };

  app.get("/api/v1/matches/:id", async (request, reply) => {
    const identity = record("GET", `/matches/${request.params.id}`, request.headers.cookie,
      request.headers.origin, request.headers["x-csrf-token"], undefined);
    const id = request.params.id!;
    const scripted = scripts.get(`GET /matches/${id}`)?.shift();
    if (scripted?.code) return reply.code(scripted.status ?? 403).send({ error: {
      code: scripted.code, message: `${alice.cookie} ${alice.csrfToken}`,
    } });
    if (!revisions.has(id) || denied.has(key(identity.principalId, id))) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: `${identity.cookie} ${identity.csrfToken}` } });
    }
    const data = snapshot(id, identity.principalId, revisions.get(id)!);
    const hold = holds.get(key(identity.principalId, id));
    if (hold) {
      holds.delete(key(identity.principalId, id));
      hold.arrived.resolve();
      await hold.release.promise;
    }
    return { data, serverNow: NOW };
  });

  for (const route of ["/matches", "/matches/:id/join", "/matches/:id/start", "/matches/:id/actions", "/matches/:id/leave", "/matches/:id/guest-invitations"]) {
    app.post(`/api/v1${route}`, async (request, reply) => {
      const concrete = route.replace(":id", request.params.id ?? "");
      record("POST", concrete, request.headers.cookie, request.headers.origin,
        request.headers["x-csrf-token"], request.body);
      if (actionHold && concrete.endsWith("/actions")) {
        actionHold.count += 1;
        if (actionHold.count >= actionHold.needed) actionHold.arrived.resolve();
        await actionHold.release.promise;
      }
      const body = objectBody(request.body);
      const scripted = scripts.get(concrete)?.shift();
      if (scripted?.delayMs) await delay(scripted.delayMs);
      if (scripted?.code) {
        return reply.code(scripted.status ?? 409).send({ error: {
          code: scripted.code, message: `${alice.cookie} ${alice.csrfToken}`,
          details: { currentRevision: 999, privateState: bob.cookie },
        } });
      }
      if (scripted?.data !== undefined) return reply.code(scripted.status ?? 200).send({ data: scripted.data, serverNow: NOW });
      if (route.endsWith("/guest-invitations")) return { data: { url: `${origin}/guest#token=private-invitation` }, serverNow: NOW };
      if (route === "/matches") {
        return reply.code(201).send({ data: { matchId: CREATED_MATCH, revision: 0, commandId: body.commandId }, serverNow: NOW });
      }
      return { data: {
        commandId: body.commandId, matchId: request.params.id,
        committedRevision: Number(body.expectedRevision) + 1,
        replayed: false, outcome: "accepted",
      }, serverNow: NOW };
    });
  }

  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    alice, bob, origin, requests, logins, subscriptions, revisions, denied, scripts, key,
    send(principalId: string, frame: ServerLiveFrame) {
      for (const [socket, owner] of sockets) if (owner === principalId) socket.send(JSON.stringify(frame));
    },
    holdSubscription() {
      subscriptionHold = { arrived: deferred<void>(), release: deferred<void>() };
      releases.add(() => subscriptionHold?.release.resolve());
      return subscriptionHold;
    },
    expire(principalId: string) {
      for (const [socket, owner] of sockets) if (owner === principalId) socket.close(4401, "session expired");
    },
    holdNextGet(principalId: string, matchId: string) {
      const hold = { arrived: deferred<void>(), release: deferred<void>() };
      holds.set(key(principalId, matchId), hold);
      releases.add(() => hold.release.resolve());
      return hold;
    },
    holdActions(needed: number) {
      const hold: ActionHold = {
        needed,
        count: 0,
        arrived: deferred<void>(),
        release: deferred<void>(),
      };
      actionHold = hold;
      releases.add(() => hold.release.resolve());
      return hold;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function client(f: Fixture, identity = f.alice, faults?: HarnessFaultInjector, timeoutMs = 500) {
  const instance = new HttpSimulatedClient(identity, { baseUrl: f.origin, faults, timeoutMs });
  clients.push(instance);
  return instance;
}

const receipt = (matchId: string, replayed: boolean): CommandReceipt => ({
  matchId, commandId: COMMAND, committedRevision: 9, replayed, outcome: "accepted",
});

function scriptReceipt(value: CommandReceipt): Json {
  return { ...value };
}

function gets(f: Fixture, matchId = MATCH) {
  return f.requests.filter((request) => request.method === "GET" && request.route === `/matches/${matchId}`);
}

describe("HttpSimulatedClient real HTTP and WebSocket boundary", () => {
  it("uses an explicitly configured browser origin for direct proxy HTTP and WS connections", async () => {
    const publicOrigin = "http://127.0.0.1:3000";
    const f = await fixture("accept", "complete", publicOrigin);
    const env = new HarnessEnvironment({ baseUrl: f.origin, origin: publicOrigin });
    try {
      const first = await env.createRegisteredClient({ username: "alice", displayName: "Alice", password: "private-password" });
      await first.getSnapshot(MATCH);
      first.onSnapshot(MATCH, () => {});
      await first.connectWs();
      expect(first.connectionState.wsConnected).toBe(true);
      expect(f.requests.every((request) => request.origin === publicOrigin)).toBe(true);
      expect(env.clock).toBeUndefined();
    } finally {
      env.reset();
    }
  });

  it("authenticates real login responses and retains two devices for the same authoritative principal", async () => {
    const f = await fixture();
    const env = new HarnessEnvironment({ baseUrl: f.origin });
    const input = { username: "alice", displayName: "ignored-client-label", password: "private-password" };
    const first = await env.createRegisteredClient(input);
    const second = await env.createRegisteredClient(input);
    expect(first.session.principalId).toBe(f.alice.principalId);
    expect(second.session.principalId).toBe(f.alice.principalId);
    expect(first.session.displayName).toBe(f.alice.displayName);
    expect(first.session.cookie).not.toBe(second.session.cookie);
    expect(env.getAllClients()).toHaveLength(2);
    expect(env.getClients(first.session.principalId)).toEqual([first, second]);
    expect(() => env.getClient(first.session.principalId)).toThrow("Multiple harness devices");
    expect(env.getClient(first.session.principalId, second.session.cookie)).toBe(second);
    expect(env.getClient("absent")).toBeUndefined();
    expect(first).not.toBe(second);
    expect(await first.getSnapshot(MATCH)).toEqual(snapshot(MATCH, f.alice.principalId, 4));
    expect(await second.getSnapshot(MATCH)).toEqual(snapshot(MATCH, f.alice.principalId, 4));
  });

  it("subscribes a redeemed scenario guest without a second join or snapshot listener", async () => {
    const f = await fixture();
    const env = new HarnessEnvironment({
      baseUrl: f.origin,
      provisionRegistered: async ({ username }) => ({ username, password: "private-password" }),
    });
    try {
      const { guest, matchId } = await setupMultiplayerCounterScenario(env);
      await guest.connectWs();
      expect(guest.receivedSnapshots).toEqual([snapshot(matchId, guest.session.principalId, 0)]);
      expect(f.subscriptions.filter(({ principalId }) => principalId === guest.session.principalId))
        .toEqual([{ principalId: guest.session.principalId, frame: {
          type: "subscribe", requestId: expect.any(String), scope: { kind: "match", id: matchId },
        } }]);
      expect(f.requests.filter(({ route }) => route.endsWith("/join")).map(({ principalId }) => principalId))
        .toEqual([f.bob.principalId]);

      f.revisions.set(matchId, 2);
      f.send(guest.session.principalId, { type: "invalidate", scope: { kind: "match", id: matchId }, revision: 2 });
      await until(() => guest.receivedSnapshots.at(-1)?.revision === 2);
      expect(guest.receivedSnapshots.at(-1)).toEqual(snapshot(matchId, guest.session.principalId, 2));
      f.revisions.set(matchId, 3);
      await guest.reconnectWs();
      expect(guest.receivedSnapshots.at(-1)).toEqual(snapshot(matchId, guest.session.principalId, 3));

      f.send(guest.session.principalId, { type: "access_revoked", scope: { kind: "match", id: matchId } });
      await until(() => guest.receivedSnapshots.length === 0);
      const subscriptions = f.subscriptions.length;
      await guest.reconnectWs();
      expect(f.subscriptions).toHaveLength(subscriptions);
      expect(guest.receivedSnapshots).toHaveLength(0);
    } finally {
      env.reset();
    }
  });

  it.each(["missing_cookie", "missing_csrf"] as const)("refuses to create a client from a login response with %s", async (mode) => {
    const f = await fixture("accept", mode);
    const env = new HarnessEnvironment({ baseUrl: f.origin });
    await expect(env.createRegisteredClient({
      username: "alice", displayName: "Alice", password: "private-password",
    })).rejects.toThrow();
    expect(f.logins).toHaveLength(1);
    expect(env.getAllClients()).toHaveLength(0);
  });

  it("isolates private views by device and clears only the departing device", async () => {
    const f = await fixture();
    const alice = client(f);
    const bob = client(f, f.bob);
    const [aliceView, bobView] = await Promise.all([alice.getSnapshot(MATCH), bob.getSnapshot(MATCH)]);
    expect(aliceView).toEqual(snapshot(MATCH, f.alice.principalId, 4));
    expect(bobView).toEqual(snapshot(MATCH, f.bob.principalId, 4));
    expect(alice.receivedSnapshots.map((view) => view.game)).toEqual([aliceView.game]);
    expect(bob.receivedSnapshots.map((view) => view.game)).toEqual([bobView.game]);

    await bob.leaveMatch(MATCH, 4);
    expect(bob.receivedSnapshots).toHaveLength(0);
    await expect(bob.getSnapshot(MATCH)).rejects.toThrow();
    expect(alice.receivedSnapshots.map((view) => view.game)).toEqual([aliceView.game]);
  });


  it("loses a successful response only for the scoped match and permits explicit identical replay", async () => {
    const f = await fixture();
    const faults = new HarnessFaultInjector();
    faults.injectPostCommitFailure(MATCH);
    const alice = client(f, f.alice, faults);
    const action = { type: "choose", payload: { card: 2 }, commandId: COMMAND, expectedRevision: 8 };
    f.scripts.set(`/matches/${OTHER_MATCH}/actions`, [{ data: scriptReceipt(receipt(OTHER_MATCH, false)) }]);
    f.scripts.set(`/matches/${MATCH}/actions`, [
      { data: scriptReceipt(receipt(MATCH, false)) }, { data: scriptReceipt(receipt(MATCH, true)) },
    ]);
    expect(await alice.act(OTHER_MATCH, action)).toEqual(receipt(OTHER_MATCH, false));
    await expect(alice.act(MATCH, action)).rejects.toThrow();
    expect(f.requests.filter((request) => request.route === `/matches/${MATCH}/actions`)).toHaveLength(1);
    expect(await alice.replayCommand(MATCH, action)).toEqual(receipt(MATCH, true));
  });

  it("clears all private views when a command discovers an expired session", async () => {
    const f = await fixture();
    const alice = client(f);
    await alice.getSnapshot(MATCH);
    await alice.getSnapshot(OTHER_MATCH);
    f.scripts.set(`/matches/${MATCH}/actions`, [{ status: 401, code: "SESSION_EXPIRED" }]);
    await expect(alice.act(MATCH, {
      type: "choose", payload: {}, commandId: COMMAND, expectedRevision: 4,
    })).rejects.toMatchObject({ status: 401, code: "SESSION_EXPIRED" });
    expect(alice.receivedSnapshots).toHaveLength(0);
    await expect(alice.getSnapshot(OTHER_MATCH)).rejects.toThrow();
  });

  it("preserves STALE_REVISION status/code without automatic retry or leaking server details", async () => {
    const f = await fixture();
    const alice = client(f);
    const action = { type: "choose", payload: {}, commandId: COMMAND, expectedRevision: 1 };
    f.scripts.set(`/matches/${MATCH}/actions`, [{ status: 409, code: "STALE_REVISION" }]);
    const error: unknown = await alice.act(MATCH, action).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HarnessHttpError);
    expect(error).toMatchObject({ status: 409, code: "STALE_REVISION" });
    const surfaced = `${String(error)} ${JSON.stringify(error)}`;
    expect(surfaced).not.toContain(f.alice.cookie);
    expect(surfaced).not.toContain(f.alice.csrfToken);
    expect(surfaced).not.toContain(f.bob.cookie);
    expect(surfaced).not.toContain("privateState");
    expect(f.requests.filter((request) => request.route.endsWith("/actions"))).toHaveLength(1);
    expect(gets(f)).toHaveLength(0);
  });

  it("does not automatically resend a rejected intent after two sessions act at one revision", async () => {
    const f = await fixture();
    const env = new HarnessEnvironment({ baseUrl: f.origin });
    try {
      const input = { username: "alice", displayName: "Alice", password: "private-password" };
      const first = await env.createRegisteredClient(input);
      const second = await env.createRegisteredClient(input);
      expect(first.session.principalId).toBe(second.session.principalId);
      expect(first.session.cookie).not.toBe(second.session.cookie);
      const expectedRevision = 4;
      const firstCommand = "10000000-0000-4000-8000-000000000011";
      const secondCommand = "10000000-0000-4000-8000-000000000012";
      const firstAction = {
        type: "note", payload: { text: "device-one-intent" }, commandId: firstCommand, expectedRevision,
      };
      const secondAction = {
        type: "note", payload: { text: "device-two-intent" }, commandId: secondCommand, expectedRevision,
      };
      f.scripts.set(`/matches/${MATCH}/actions`, [
        {},
        { status: 409, code: "STALE_REVISION" },
      ]);
      const hold = f.holdActions(2);
      const pending = Promise.allSettled([
        first.act(MATCH, firstAction),
        second.act(MATCH, secondAction),
      ]);
      await hold.arrived.promise;
      const inflight = f.requests.filter((request) => request.route === `/matches/${MATCH}/actions`);
      expect(inflight).toHaveLength(2);
      expect(inflight.map((request) => request.body.expectedRevision)).toEqual([
        expectedRevision, expectedRevision,
      ]);
      expect(inflight.map((request) => request.cookie).sort()).toEqual([
        first.session.cookie, second.session.cookie,
      ].sort());
      hold.release.resolve();
      const settled = await pending;
      const loserIndex = settled.findIndex((result) => result.status === "rejected");
      const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
      expect(loserIndex).toBeGreaterThanOrEqual(0);
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(loserIndex).not.toBe(winnerIndex);
      const failure = settled[loserIndex]?.status === "rejected" ? settled[loserIndex].reason : undefined;
      expect(failure).toBeInstanceOf(HarnessHttpError);
      expect(failure).toMatchObject({ status: 409, code: "STALE_REVISION" });
      const surfaced = `${String(failure)} ${JSON.stringify(failure)}`;
      expect(surfaced).not.toContain("device-one-intent");
      expect(surfaced).not.toContain("device-two-intent");
      expect(surfaced).not.toContain(first.session.cookie);
      expect(surfaced).not.toContain(second.session.cookie);
      expect(surfaced).not.toContain(f.bob.cookie);
      const loser = loserIndex === 0 ? first : second;
      const loserCommand = loserIndex === 0 ? firstCommand : secondCommand;
      const actions = () => f.requests.filter((request) => request.route === `/matches/${MATCH}/actions`);
      vi.useFakeTimers();
      try {
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }
      expect(actions()).toHaveLength(2);
      expect(actions().filter((request) => request.body.commandId === loserCommand)).toHaveLength(1);
      expect(gets(f)).toHaveLength(0);
      f.revisions.set(MATCH, expectedRevision + 1);
      expect((await loser.getSnapshot(MATCH)).revision).toBe(expectedRevision + 1);
      expect(actions()).toHaveLength(2);
      expect(gets(f)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      env.reset();
    }
  });

  it("rejects missing authentication and nonexistent routes rather than manufacturing snapshots", async () => {
    const f = await fixture();
    const unauthenticated = client(f, { ...f.alice, cookie: "" });
    await expect(unauthenticated.getSnapshot(MATCH)).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    await expect(client(f).getSnapshot("missing-match")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(unauthenticated.receivedSnapshots).toHaveLength(0);
  });

  it("purges a previously cached private match when HTTP denies access without a WebSocket event", async () => {
    const f = await fixture();
    const alice = client(f);
    await alice.getSnapshot(MATCH);
    await alice.getSnapshot(OTHER_MATCH);
    f.denied.add(f.key(f.alice.principalId, MATCH));
    await expect(alice.getSnapshot(MATCH)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(alice.receivedSnapshots.map((view) => view.id)).toEqual([OTHER_MATCH]);
    await expect(alice.getSnapshot(MATCH)).rejects.toThrow();
    expect(alice.receivedSnapshots.some((view) => view.id === MATCH)).toBe(false);
  });

  it("refreshes after subscribed, ignores same/older invalidations and refetches on reconnect", async () => {
    const f = await fixture();
    const alice = client(f);
    const bob = client(f, f.bob);
    const aliceViews: MatchSnapshot[] = [];
    const bobViews: MatchSnapshot[] = [];
    const unsubscribeAlice = alice.onSnapshot(MATCH, (view) => aliceViews.push(view));
    const unsubscribeBob = bob.onSnapshot(MATCH, (view) => bobViews.push(view));
    await Promise.all([alice.connectWs(), bob.connectWs()]);
    await until(() => aliceViews.length === 1 && bobViews.length === 1);
    expect(f.subscriptions.filter(({ frame }) => frame.type === "subscribe")).toHaveLength(2);
    expect(aliceViews[0]).toEqual(snapshot(MATCH, f.alice.principalId, 4));
    expect(bobViews[0]).toEqual(snapshot(MATCH, f.bob.principalId, 4));
    const before = gets(f).length;
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH }, revision: 4 });
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH }, revision: 3 });
    await delay(40);
    expect(gets(f)).toHaveLength(before);
    f.revisions.set(MATCH, 8);
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH }, revision: 8 });
    await until(() => aliceViews.at(-1)?.revision === 8);
    expect(bobViews).toHaveLength(1);
    expect(gets(f)).toHaveLength(before + 1);
    f.revisions.set(MATCH, 10);
    await alice.reconnectWs();
    await until(() => aliceViews.at(-1)?.revision === 10);
    expect(alice.connectionState.wsConnected).toBe(true);
    expect(f.subscriptions.filter(({ principalId, frame }) => principalId === f.alice.principalId && frame.type === "subscribe")).toHaveLength(2);
    unsubscribeAlice();
    unsubscribeBob();
  });

  it.each(["access_revoked", "session_expired"] as const)("clears private views on %s and rejects a late in-flight snapshot", async (event) => {
    const f = await fixture();
    const alice = client(f);
    const delivered: MatchSnapshot[] = [];
    alice.onSnapshot(MATCH, (view) => delivered.push(view));
    await alice.connectWs();
    await until(() => delivered.length === 1);
    const hold = f.holdNextGet(f.alice.principalId, MATCH);
    const late = alice.getSnapshot(MATCH).then(
      (view) => ({ view, error: undefined }),
      (error: unknown) => ({ view: undefined, error }),
    );
    await hold.arrived.promise;
    f.denied.add(f.key(f.alice.principalId, MATCH));
    if (event === "access_revoked") {
      f.send(f.alice.principalId, { type: "access_revoked", scope: { kind: "match", id: MATCH } });
    } else {
      f.expire(f.alice.principalId);
    }
    await until(() => alice.receivedSnapshots.length === 0);
    expect(alice.connectionState.activeMatchId).toBeNull();
    if (event === "session_expired") expect(alice.connectionState.wsConnected).toBe(false);
    hold.release.resolve();
    const result = await late;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.view).toBeUndefined();
    expect(alice.receivedSnapshots).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    await expect(alice.getSnapshot(MATCH)).rejects.toThrow();
    expect(alice.receivedSnapshots).toHaveLength(0);
  });

  it.each(["reject", "hang"] as const)("rejects a %s WebSocket upgrade within the configured deadline without credentials in errors", async (mode) => {
    const f = await fixture(mode);
    const alice = client(f, f.alice, undefined, 75);
    const started = Date.now();
    const error: unknown = await alice.connectWs().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(alice.connectionState.wsConnected).toBe(false);
    const surfaced = `${String(error)} ${JSON.stringify(error)}`;
    expect(surfaced).not.toContain(f.alice.cookie);
    expect(surfaced).not.toContain(f.alice.csrfToken);
  });

  it("backs off while HTTP lags a subscribed revision and delivers each revision once", async () => {
    const f = await fixture();
    const alice = client(f, f.alice, undefined, 1000);
    const views: number[] = [];
    alice.onSnapshot(MATCH, view => views.push(view.revision));
    await alice.connectWs();
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH }, revision: 8 });
    await until(() => gets(f).length >= 2);
    await delay(110);
    expect(gets(f).length).toBeLessThanOrEqual(5);
    expect(views).toEqual([4]);
    f.revisions.set(MATCH, 8);
    await until(() => views.includes(8));
    expect(views).toEqual([4, 8]);
    expect(alice.receivedSnapshots.map(view => view.revision)).toEqual([4, 8]);
    expect(alice.connectionState.wsConnected).toBe(true);
    expect(alice.receivedErrors).toHaveLength(0);
  });

  it("bounds a permanently lagging subscription without duplicate deliveries or tight polling", async () => {
    const f = await fixture();
    const gate = f.holdSubscription();
    const alice = client(f, f.alice, undefined, 120);
    const views: number[] = [];
    alice.onSnapshot(MATCH, view => views.push(view.revision));
    // The acknowledgement captures revision 8, but the HTTP projection stays at 4.
    f.revisions.set(MATCH, 8);
    const connected = alice.connectWs();
    const outcome = connected.catch((error: unknown) => error);
    await gate.arrived.promise;
    f.revisions.set(MATCH, 4);
    gate.release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(views).toEqual([4]);
    expect(gets(f).length).toBeLessThanOrEqual(5);
    expect(alice.connectionState.wsConnected).toBe(false);
  });

  it("honors revisionless wakeups before acknowledgement and during an in-flight read", async () => {
    const f = await fixture();
    const gate = f.holdSubscription();
    const alice = client(f);
    const views: number[] = [];
    alice.onSnapshot(MATCH, view => views.push(view.revision));
    const connected = alice.connectWs();
    await gate.arrived.promise;
    f.revisions.set(MATCH, 6);
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH } });
    await delay(20);
    expect(gets(f)).toHaveLength(0);
    gate.release.resolve();
    await connected;
    expect(views).toEqual([6]);

    const hold = f.holdNextGet(f.alice.principalId, MATCH);
    const reading = alice.getSnapshot(MATCH);
    await hold.arrived.promise;
    f.revisions.set(MATCH, 9);
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH } });
    await delay(20);
    hold.release.resolve();
    expect((await reading).revision).toBe(9);
    expect(views).toEqual([6, 9]);
    const before = gets(f).length;
    f.revisions.set(MATCH, 10);
    f.send(f.alice.principalId, { type: "invalidate", scope: { kind: "match", id: MATCH } });
    await until(() => views.includes(10));
    expect(gets(f)).toHaveLength(before + 1);
  });

  it.each([
    ["command", 401, "SESSION_EXPIRED"], ["command", 403, "ACCOUNT_DISABLED"],
    ["read", 403, "ACCOUNT_DISABLED"], ["read", 401, "SESSION_EXPIRED"],
  ] as const)("revokes every cached scope and future sends after %s gets %s/%s", async (operation, status, code) => {
    const f = await fixture();
    const alice = client(f);
    alice.onSnapshot(MATCH, () => {});
    await alice.connectWs();
    await alice.getSnapshot(OTHER_MATCH);
    const hold = f.holdNextGet(f.alice.principalId, OTHER_MATCH);
    const late = alice.getSnapshot(OTHER_MATCH).catch((error: unknown) => error);
    await hold.arrived.promise;
    const route = operation === "read" ? `GET /matches/${MATCH}` : `/matches/${MATCH}/actions`;
    f.scripts.set(route, [{ status, code }]);
    await expect(operation === "read" ? alice.getSnapshot(MATCH) : alice.act(MATCH, {
      type: "choose", payload: {}, expectedRevision: 4,
    })).rejects.toMatchObject({ status, code });
    expect(alice.receivedSnapshots).toHaveLength(0);
    expect(alice.connectionState.wsConnected).toBe(false);
    hold.release.resolve();
    expect(await late).toBeInstanceOf(Error);
    const count = f.requests.length;
    await expect(alice.createMatch("test-counter", "solo")).rejects.toThrow();
    await expect(alice.joinMatch(MATCH, 4)).rejects.toThrow();
    await expect(alice.startMatch(MATCH, 4)).rejects.toThrow();
    await expect(alice.leaveMatch(MATCH, 4)).rejects.toThrow();
    await expect(alice.createGuestInvitation(MATCH)).rejects.toThrow();
    await expect(alice.getSnapshot(OTHER_MATCH)).rejects.toThrow();
    await expect(alice.connectWs()).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
    expect(alice.receivedSnapshots).toHaveLength(0);
  });

  it.each([[403, "FORBIDDEN"], [404, "NOT_FOUND"]] as const)("revokes only the affected match on a command %s/%s", async (status, code) => {
    const f = await fixture();
    const alice = client(f);
    await alice.getSnapshot(MATCH);
    await alice.getSnapshot(OTHER_MATCH);
    f.scripts.set(`/matches/${MATCH}/actions`, [{ status, code }]);
    await expect(alice.act(MATCH, { type: "choose", payload: {}, expectedRevision: 4 })).rejects.toMatchObject({ status, code });
    expect(alice.receivedSnapshots.map(view => view.id)).toEqual([OTHER_MATCH]);
    await expect(alice.getSnapshot(MATCH)).rejects.toThrow();
    expect((await alice.getSnapshot(OTHER_MATCH)).id).toBe(OTHER_MATCH);
  });

  it.each(["create", "join", "start", "leave", "invite", "act"] as const)("preserves the minted command ID after %s response loss for explicit identical replay", async (operation) => {
    const f = await fixture();
    const faults = new HarnessFaultInjector();
    const alice = client(f, f.alice, faults);
    const matchId = operation === "create" ? CREATED_MATCH : MATCH;
    faults.injectPostCommitFailure(matchId);
    const invoke = (commandId?: string) => {
      switch (operation) {
        case "create": return alice.createMatch("test-counter", "solo", {}, "invite", commandId);
        case "join": return alice.joinMatch(MATCH, 4, "private-link", commandId);
        case "start": return alice.startMatch(MATCH, 4, commandId);
        case "leave": return alice.leaveMatch(MATCH, 4, commandId);
        case "invite": return alice.createGuestInvitation(MATCH, commandId);
        case "act": return alice.act(MATCH, { type: "note", payload: { text: "private-note" }, expectedRevision: 4, commandId });
      }
    };
    const failure: unknown = await invoke().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessCommandError);
    if (!(failure instanceof HarnessCommandError)) throw new Error("Expected retry correlation");
    expect(failure).toMatchObject({ matchId, reason: "response_loss" });
    const first = f.requests.find(request => request.method === "POST")!;
    expect(failure.commandId).toBe(first.body.commandId);
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toMatch(/private-(cookie|csrf|note|link|invitation)/);
    await invoke(failure.commandId);
    const sent = f.requests.filter(request => request.method === "POST");
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
  });

  it("preserves command correlation on actual HTTP timeout without retaining private payloads", async () => {
    const f = await fixture();
    const alice = client(f, f.alice, undefined, 50);
    f.scripts.set(`/matches/${MATCH}/actions`, [{ delayMs: 150 }]);
    const failure: unknown = await alice.act(MATCH, {
      type: "note", payload: { text: "private-note" }, expectedRevision: 4,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessCommandError);
    if (!(failure instanceof HarnessCommandError)) throw new Error("Expected retry correlation");
    expect(failure).toMatchObject({ matchId: MATCH, reason: "transport_failure" });
    expect(failure.commandId).toBe(f.requests[0]?.body.commandId);
    expect(JSON.stringify(failure)).not.toContain("private-note");
    await alice.act(MATCH, { type: "note", payload: { text: "private-note" }, expectedRevision: 4, commandId: failure.commandId });
    expect(f.requests[1]?.body).toEqual(f.requests[0]?.body);
  });

});
