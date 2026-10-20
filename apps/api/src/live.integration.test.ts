// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR_CODES, LIVE_SUBPROTOCOL, type ServerLiveFrame } from "@next-round/contracts";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  GameRegistry,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { registerTestCounterFixture } from "./test-counter-fixture.js";
import type { LiveService } from "./live/index.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const WebSocket = require("ws");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";

interface TestSession {
  id: string;
  principalId: string;
  cookie: string;
  csrf: string;
}

interface WebSocketClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface TestClient {
  socket: WebSocketClient;
  frames: ServerLiveFrame[];
  waitForFrame: (predicate: (f: ServerLiveFrame) => boolean, timeoutMs?: number) => Promise<ServerLiveFrame>;
  close: () => void;
}

function getFrameRevision(frame: ServerLiveFrame): number | undefined {
  if ("revision" in frame && typeof frame.revision === "number") {
    return frame.revision;
  }
  return undefined;
}
describe.skipIf(!testDatabaseUrl)("F1-09 Live WebSocket & Local Reconciliation", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let databaseUrl: string;
  let staticRoot: string;
  let serverUrl: string;
  let liveService: LiveService;
  const sockets: WebSocketClient[] = [];

  const createSession = async (label: string): Promise<TestSession> => {
    const principalId = randomUUID();
    const sessionId = randomUUID();
    const token = generateOpaqueSessionToken();
    const csrf = generateCsrfToken();

    await databasePool.query(
      "INSERT INTO next_round.principals(id, kind, display_name) VALUES($1, 'registered', $2)",
      [principalId, label],
    );
    await databasePool.query(
      "INSERT INTO next_round.accounts(principal_id, username, password_hash, role) VALUES($1, $2, 'test-hash', 'member')",
      [principalId, label.toLowerCase().replace(/\s+/g, "_")],
    );
    await databasePool.query(
      `INSERT INTO next_round.sessions(id, principal_id, token_hash, csrf_hash, auth_epoch, idle_expires_at, absolute_expires_at)
       VALUES($1, $2, $3, $4, 0, now() + interval '1 day', now() + interval '1 day')`,
      [sessionId, principalId, token.tokenHash, csrf.csrfHash],
    );

    return {
      id: sessionId,
      principalId,
      cookie: `${SESSION_DEV_COOKIE_NAME}=${token.rawToken}`,
      csrf: csrf.rawToken,
    };
  };

  const connectWs = (
    session: TestSession,
    options: {
      url?: string;
      originHeader?: string;
      subprotocol?: string | null;
      cookieHeader?: string;
    } = {},
  ): Promise<TestClient> => {
    const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
    const wsUrl = (options.url ?? `${serverUrl}/api/v1/live`).replace(/^http:/, "ws:");
    const protocols = options.subprotocol === null ? undefined : (options.subprotocol ?? LIVE_SUBPROTOCOL);
    const headers: Record<string, string> = {
      Origin: options.originHeader !== undefined ? options.originHeader : origin,
      Cookie: options.cookieHeader !== undefined ? options.cookieHeader : session.cookie,
    };

    // Cast unchecked WebSocket instance through unknown
    const socket = new WebSocket(wsUrl, protocols, { headers }) as unknown as WebSocketClient;
    sockets.push(socket);

    const frames: ServerLiveFrame[] = [];
    const waiters: Array<{
      predicate: (f: ServerLiveFrame) => boolean;
      resolve: (f: ServerLiveFrame) => void;
    }> = [];

    socket.on("message", (bytes: unknown) => {
      try {
        const text =
          typeof bytes === "string"
            ? bytes
            : Buffer.isBuffer(bytes)
              ? bytes.toString("utf8")
              : String(bytes);
        const frame = JSON.parse(text) as ServerLiveFrame;
        frames.push(frame);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(frame)) {
            waiters[i].resolve(frame);
            waiters.splice(i, 1);
          }
        }
      } catch {
        // Non-JSON frame
      }
    });

    const client: TestClient = {
      socket,
      frames,
      waitForFrame: (predicate, timeoutMs = 5000) => {
        const existing = frames.find(predicate);
        if (existing) return Promise.resolve(existing);
        const { promise: framePromise, resolve: frameResolve, reject: frameReject } =
          Promise.withResolvers<ServerLiveFrame>();
        const timer = setTimeout(() => {
          frameReject(new Error("Timed out waiting for WebSocket frame"));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (f) => {
            clearTimeout(timer);
            frameResolve(f);
          },
        });
        return framePromise;
      },
      close: () => {
        try {
          socket.close();
        } catch {}
      },
    };

    socket.on("open", () => resolve(client));
    socket.on("error", (err: unknown) => reject(err));
    return promise;
  };

  beforeEach(async () => {
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 2 });
    databaseName = `live_test_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);

    const parsed = new URL(testDatabaseUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();

    await migrateDatabase({ connectionString: databaseUrl });
    databasePool = createDatabasePool({ connectionString: databaseUrl, max: 5 });
    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-live-test-"));
    await writeFile(path.join(staticRoot, "client.js"), "export const client = true;\n");

    const registry = new GameRegistry();
    registerTestCounterFixture(registry, staticRoot);

    const adminUser = await createSession("Policy_Admin");

    // Seed policy and module inside transaction with valid changed_by
    const policy = {
      schemaVersion: 1 as const,
      historyVisibility: "participants" as const,
      statsVisibility: "owner" as const,
      rejoinChat: "full" as const,
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
        "INSERT INTO next_round.instance_policy(version, instance_name, policy, changed_by) VALUES(1, 'Live Integration', $1::jsonb, $2)",
        [JSON.stringify(policy), adminUser.principalId],
      );
      await client.query("INSERT INTO next_round.instance_singleton(id, current_policy_version) VALUES(true, 1)");
      await client.query("INSERT INTO next_round.modules(id, default_version) VALUES('test-counter', '0.1.0')");
      await client.query(
        `INSERT INTO next_round.module_versions(module_id, version, manifest, server_hash, client_hash, sdk_contract, state_version, result_version)
         VALUES('test-counter', '0.1.0', '{}'::jsonb, 'srv-hash', 'cli-hash', 'next-round-game/0.1', 1, 1)`,
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot,
      databasePool,
      databaseDirectUrl: databaseUrl,
      origin,
      gameRegistry: registry,
      reconcileIntervalMs: 500, // fast sweep for tests
    });

    serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    liveService = app.liveService;
  });

  afterEach(async () => {
    for (const s of sockets) {
      try {
        s.terminate();
      } catch {}
    }
    sockets.length = 0;

    if (app) await app.close();
    const disconnected: Array<Promise<void>> = [];
    databasePool?.on("remove", client => {
      disconnected.push(new Promise<void>(resolve => client.once("end", resolve)));
    });
    if (databasePool) await databasePool.end();
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE "${databaseName}"`);
      await adminPool.end();
    }
    await rm(staticRoot, { recursive: true, force: true });
  });

  it("rejects connection with wrong Origin before upgrade", async () => {
    const user = await createSession("User_Bad_Origin");
    await expect(connectWs(user, { originHeader: "http://attacker.com" })).rejects.toThrow();
  });

  it("rejects connection with missing subprotocol", async () => {
    const user = await createSession("User_No_Subproto");
    await expect(connectWs(user, { subprotocol: null })).rejects.toThrow();
  });

  it("rejects connection with missing or invalid cookie", async () => {
    const user = await createSession("User_No_Cookie");
    await expect(connectWs(user, { cookieHeader: "" })).rejects.toThrow();
  });

  it("upgrades authorized connection and delivers hello frame with heartbeatSeconds", async () => {
    const user = await createSession("User_Valid");
    const client = await connectWs(user);

    const hello = await client.waitForFrame((f) => f.type === "hello");
    expect(hello.type).toBe("hello");
    if (hello.type === "hello") {
      expect(hello.connectionId).toBeDefined();
      expect(hello.heartbeatSeconds).toBe(25);
    }
  });

  it("responds to ping with pong frame", async () => {
    const user = await createSession("User_Ping");
    const client = await connectWs(user);
    await client.waitForFrame((f) => f.type === "hello");

    const reqId = randomUUID();
    client.socket.send(JSON.stringify({ type: "ping", requestId: reqId }));

    const pong = await client.waitForFrame((f) => f.type === "pong" && f.requestId === reqId);
    expect(pong.type).toBe("pong");
    if (pong.type === "pong") {
      expect(pong.serverNow).toBeDefined();
    }
  });

  it("allows active member to subscribe and rejects outsider with NOT_FOUND", async () => {
    const member = await createSession("Member_Player");
    const outsider = await createSession("Outsider_Player");
    const matchId = randomUUID();

    // Create match and seat member as active
    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 0, '{"count":0}'::jsonb)`,
      [matchId, member.principalId],
    );
    await databasePool.query(
      `INSERT INTO next_round.match_members(id, match_id, principal_id, status, join_ordinal)
       VALUES($1, $2, $3, 'active', 0)`,
      [randomUUID(), matchId, member.principalId],
    );

    const memberClient = await connectWs(member);
    const outsiderClient = await connectWs(outsider);

    const reqId1 = randomUUID();
    memberClient.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: reqId1,
        scope: { kind: "match", id: matchId },
      }),
    );

    const subscribed = await memberClient.waitForFrame(
      (f) => f.type === "subscribed" && f.requestId === reqId1,
    );
    expect(subscribed.type).toBe("subscribed");
    if (subscribed.type === "subscribed") {
      expect(subscribed.revision).toBe(0);
    }

    const reqId2 = randomUUID();
    outsiderClient.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: reqId2,
        scope: { kind: "match", id: matchId },
      }),
    );

    const error = await outsiderClient.waitForFrame(
      (f) => f.type === "error" && f.requestId === reqId2,
    );
    expect(error.type).toBe("error");
    if (error.type === "error") {
      expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });

  it("fanouts invalidation to subscribed clients when worker notification arrives", async () => {
    const member = await createSession("Member_Live_Invalidate");
    const matchId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 1, '{"count":1}'::jsonb)`,
      [matchId, member.principalId],
    );
    await databasePool.query(
      `INSERT INTO next_round.match_members(id, match_id, principal_id, status, join_ordinal)
       VALUES($1, $2, $3, 'active', 0)`,
      [randomUUID(), matchId, member.principalId],
    );

    const client = await connectWs(member);
    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: randomUUID(),
        scope: { kind: "match", id: matchId },
      }),
    );
    await client.waitForFrame((f) => f.type === "subscribed");

    // Advance revision and send pg_notify
    await databasePool.query(
      "UPDATE next_round.matches SET revision = 2 WHERE id = $1",
      [matchId],
    );
    await databasePool.query(
      "SELECT pg_notify('next_round_live', $1)",
      [JSON.stringify({ scope: { kind: "match", id: matchId }, revision: 2 })],
    );

    const invalidate = await client.waitForFrame(
      (f) => f.type === "invalidate" && f.scope?.kind === "match" && getFrameRevision(f) === 2,
    );
    expect(invalidate.type).toBe("invalidate");
  });

  it("reconciles missed wakeup via periodic sweep without pg_notify", async () => {
    const member = await createSession("Member_Missed_Wakeup");
    const matchId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 1, '{"count":1}'::jsonb)`,
      [matchId, member.principalId],
    );
    await databasePool.query(
      `INSERT INTO next_round.match_members(id, match_id, principal_id, status, join_ordinal)
       VALUES($1, $2, $3, 'active', 0)`,
      [randomUUID(), matchId, member.principalId],
    );

    const client = await connectWs(member);
    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: randomUUID(),
        scope: { kind: "match", id: matchId },
      }),
    );
    await client.waitForFrame((f) => f.type === "subscribed");

    // Update DB without pg_notify (missed wakeup simulation)
    await databasePool.query(
      "UPDATE next_round.matches SET revision = 5 WHERE id = $1",
      [matchId],
    );

    // Periodic sweep runs every 500ms
    const invalidate = await client.waitForFrame(
      (f) => f.type === "invalidate" && f.scope?.kind === "match" && getFrameRevision(f) === 5,
      5000,
    );
    expect(invalidate.type).toBe("invalidate");
  });

  it("revokes access and sends access_revoked when member departs", async () => {
    const member = await createSession("Member_Departure");
    const matchId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 1, '{"count":1}'::jsonb)`,
      [matchId, member.principalId],
    );
    await databasePool.query(
      `INSERT INTO next_round.match_members(id, match_id, principal_id, status, join_ordinal)
       VALUES($1, $2, $3, 'active', 0)`,
      [randomUUID(), matchId, member.principalId],
    );

    const client = await connectWs(member);
    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: randomUUID(),
        scope: { kind: "match", id: matchId },
      }),
    );
    await client.waitForFrame((f) => f.type === "subscribed");

    // Member leaves match
    await databasePool.query(
      "UPDATE next_round.match_members SET status = 'left' WHERE match_id = $1 AND principal_id = $2",
      [matchId, member.principalId],
    );

    // Trigger sweep
    await liveService.runSweep();

    const revoked = await client.waitForFrame(
      (f) => f.type === "access_revoked" && f.scope?.kind === "match",
      5000,
    );
    expect(revoked.type).toBe("access_revoked");
  });

  it("closes socket with 4401 when session is revoked or account disabled", async () => {
    const member = await createSession("Member_Revoked_Session");
    const client = await connectWs(member);
    await client.waitForFrame((f) => f.type === "hello");

    // Revoke session in database
    await databasePool.query(
      "UPDATE next_round.sessions SET revoked_at = now() WHERE id = $1",
      [member.id],
    );

    const { promise: closedPromise, resolve: closedResolve } =
      Promise.withResolvers<{ code: number; reason: string }>();
    client.socket.on("close", (code: unknown, reason: unknown) => {
      closedResolve({
        code: typeof code === "number" ? code : 0,
        reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason),
      });
    });

    await liveService.runSweep();

    const result = await closedPromise;
    expect(result.code).toBe(4401);
  });

  it("delivers access_revoked and suppresses invalidate when notification fires after leave", async () => {
    const member = await createSession("Member_Notify_After_Leave");
    const matchId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 1, '{"count":1}'::jsonb)`,
      [matchId, member.principalId],
    );
    await databasePool.query(
      `INSERT INTO next_round.match_members(id, match_id, principal_id, status, join_ordinal)
       VALUES($1, $2, $3, 'active', 0)`,
      [randomUUID(), matchId, member.principalId],
    );

    const client = await connectWs(member);
    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: randomUUID(),
        scope: { kind: "match", id: matchId },
      }),
    );
    await client.waitForFrame((f) => f.type === "subscribed");

    // Member departs match
    await databasePool.query(
      "UPDATE next_round.match_members SET status = 'left' WHERE match_id = $1 AND principal_id = $2",
      [matchId, member.principalId],
    );

    // Concurrent match revision update and pg_notify
    await databasePool.query(
      "UPDATE next_round.matches SET revision = 2 WHERE id = $1",
      [matchId],
    );
    await databasePool.query(
      "SELECT pg_notify('next_round_live', $1)",
      [JSON.stringify({ scope: { kind: "match", id: matchId }, revision: 2 })],
    );

    // Frame must be access_revoked, never an invalidate frame containing revision 2
    const revoked = await client.waitForFrame(
      (f) => f.type === "access_revoked" && f.scope?.kind === "match",
      5000,
    );
    expect(revoked.type).toBe("access_revoked");
    const invalidates = client.frames.filter((f) => f.type === "invalidate");
    expect(invalidates).toHaveLength(0);
  });

  it("never sends subscribed or invalidate to pending outsider subscribe during concurrent notify", async () => {
    const outsider = await createSession("Outsider_Race_Player");
    const matchId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 10, '{"count":10}'::jsonb)`,
      [matchId, outsider.principalId],
    );

    const outsiderClient = await connectWs(outsider);
    const reqId = randomUUID();

    // Outsider requests subscription
    outsiderClient.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: reqId,
        scope: { kind: "match", id: matchId },
      }),
    );

    // Simultaneously trigger worker notification for the match
    await databasePool.query(
      "SELECT pg_notify('next_round_live', $1)",
      [JSON.stringify({ scope: { kind: "match", id: matchId }, revision: 11 })],
    );

    const err = await outsiderClient.waitForFrame(
      (f) => f.type === "error" && f.requestId === reqId,
      5000,
    );
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.code).toBe(ERROR_CODES.NOT_FOUND);
    }

    // Must never receive subscribed or invalidate
    const invalidates = outsiderClient.frames.filter(
      (f) => f.type === "invalidate" || f.type === "subscribed",
    );
    expect(invalidates).toHaveLength(0);
  });

  it("closes connection with 4401 when principal auth_epoch increments", async () => {
    const member = await createSession("Member_Auth_Epoch_Mismatch");
    const client = await connectWs(member);
    await client.waitForFrame((f) => f.type === "hello");

    // Invalidate sessions via auth_epoch increment in DB
    await databasePool.query(
      "UPDATE next_round.principals SET auth_epoch = auth_epoch + 1 WHERE id = $1",
      [member.principalId],
    );

    const { promise: closedPromise, resolve: closedResolve } =
      Promise.withResolvers<{ code: number; reason: string }>();
    client.socket.on("close", (code: unknown, reason: unknown) => {
      closedResolve({
        code: typeof code === "number" ? code : 0,
        reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason),
      });
    });

    await liveService.runSweep();

    const result = await closedPromise;
    expect(result.code).toBe(4401);
  });

  it("rejects subscribe-after-revocation with NOT_FOUND error", async () => {
    const member = await createSession("Member_Subscribe_After_Revoke");
    const matchId = randomUUID();

    await databasePool.query(
      `INSERT INTO next_round.matches(id, module_id, module_version, state_version, mode, phase, creator_id, settings, visibility, policy_version, policy_snapshot, revision, state)
       VALUES($1, 'test-counter', '0.1.0', 1, 'solo', 'lobby', $2, '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 1, '{"count":1}'::jsonb)`,
      [matchId, member.principalId],
    );
    // Member was previously removed
    await databasePool.query(
      `INSERT INTO next_round.match_members(id, match_id, principal_id, status, join_ordinal)
       VALUES($1, $2, $3, 'removed', 0)`,
      [randomUUID(), matchId, member.principalId],
    );

    const client = await connectWs(member);
    const reqId = randomUUID();
    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        requestId: reqId,
        scope: { kind: "match", id: matchId },
      }),
    );

    const err = await client.waitForFrame(
      (f) => f.type === "error" && f.requestId === reqId,
      5000,
    );
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });
});
