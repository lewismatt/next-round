// SPDX-License-Identifier: Apache-2.0
import type { IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_SUBPROTOCOL,
  type ClientLiveFrame,
  type CommandReceipt,
  type Json,
  type ServerLiveFrame,
} from "@next-round/contracts";
import type { MatchSnapshot } from "@next-round/game-client";
import { HarnessHttpError, HttpSimulatedClient } from "./client.js";
import { HarnessEnvironment, HarnessFaultInjector, type SimulatedSession } from "./index.js";

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
) {
  const alice = session("alice");
  const bob = session("bob");
  const identities = [alice, bob];
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
  const key = (principalId: string, matchId: string) => `${principalId}:${matchId}`;

  cleanup.push(async () => {
    for (const release of releases) release();
    for (const socket of sockets.keys()) socket.terminate();
    await app.close();
  });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    if (request.url === "/api/v1/auth/login" && request.headers.origin === origin) return;
    const identity = identities.find((candidate) => candidate.cookie === request.headers.cookie);
    if (!identity || request.headers.origin !== origin) {
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
      ...alice,
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

  app.get("/api/v1/live", { websocket: true }, (socket, request) => {
    const identity = identities.find((candidate) => candidate.cookie === request.headers.cookie)!;
    sockets.set(socket, identity.principalId);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: "hello", connectionId: "fixture-connection", serverNow: NOW, heartbeatSeconds: 25 }));
    socket.on("message", (raw) => {
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
      socket.send(JSON.stringify({
        type: "subscribed", requestId: frame.requestId,
        scope: frame.scope, revision: revisions.get(incoming.scope.id) ?? 0,
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

  for (const route of ["/matches", "/matches/:id/join", "/matches/:id/start", "/matches/:id/actions", "/matches/:id/leave"]) {
    app.post(`/api/v1${route}`, async (request, reply) => {
      const concrete = route.replace(":id", request.params.id ?? "");
      record("POST", concrete, request.headers.cookie, request.headers.origin,
        request.headers["x-csrf-token"], request.body);
      const body = objectBody(request.body);
      const scripted = scripts.get(concrete)?.shift();
      if (scripted?.code) {
        return reply.code(scripted.status ?? 409).send({ error: {
          code: scripted.code, message: `${alice.cookie} ${alice.csrfToken}`,
          details: { currentRevision: 999, privateState: bob.cookie },
        } });
      }
      if (scripted?.data !== undefined) return reply.code(scripted.status ?? 200).send({ data: scripted.data, serverNow: NOW });
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
    expire(principalId: string) {
      for (const [socket, owner] of sockets) if (owner === principalId) socket.close(4401, "session expired");
    },
    holdNextGet(principalId: string, matchId: string) {
      const hold = { arrived: deferred<void>(), release: deferred<void>() };
      holds.set(key(principalId, matchId), hold);
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
    expect(first).not.toBe(second);
    expect(await first.getSnapshot(MATCH)).toEqual(snapshot(MATCH, f.alice.principalId, 4));
    expect(await second.getSnapshot(MATCH)).toEqual(snapshot(MATCH, f.alice.principalId, 4));
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
});
