// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR_CODES, type GameManifest } from "@next-round/contracts";
import { createDatabasePool, type DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { manifest as testCounterManifest } from "@next-round/game-test-counter/manifest";
import { server as testCounterServer } from "@next-round/game-test-counter/server";
import {
  checkModuleRetentionReadiness,
  GameRegistry,
  installGameVersion,
  generateCsrfToken,
  generateOpaqueSessionToken,
  SESSION_DEV_COOKIE_NAME,
  verifyModuleRetentionReadiness,
} from "@next-round/platform";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

interface AdminGameSummary {
  id: string;
  enabled: boolean;
  defaultVersion: string;
  versions: Array<{
    version: string;
    hasServer: boolean;
    hasClientAssets: boolean;
    referenceCounts: {
      lobby: number;
      active: number;
      finished: number;
      total: number;
    };
  }>;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";

interface SessionFixture {
  principalId: string;
  cookie: string;
  csrf: string;
}

function authHeaders(session: SessionFixture, mutation = false): Record<string, string> {
  const result: Record<string, string> = { cookie: session.cookie };
  if (mutation) {
    result.origin = origin;
    result["content-type"] = "application/json";
    result["x-csrf-token"] = session.csrf;
  }
  return result;
}

describe.skipIf(!testDatabaseUrl)("F1-10 module lifecycle, pinned versions, disable and retention", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRootV01: string;
  let staticRootV02: string;
  let adminSession: SessionFixture;
  let memberA: SessionFixture;
  let memberB: SessionFixture;
  let registry: GameRegistry;

  async function seedSession(
    displayName: string,
    username: string,
    role: "admin" | "member" = "member",
  ): Promise<SessionFixture> {
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
       VALUES ($1, $2, 'unused-in-integration-fixture', $3)`,
      [principalId, username, role],
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

  beforeEach(async () => {
    databaseName = `next_round_modules_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    await migrateDatabase({ connectionString: url.toString() });
    databasePool = createDatabasePool({ connectionString: url.toString(), max: 8 });

    staticRootV01 = await mkdtemp(path.join(tmpdir(), "next-round-mod-v01-"));
    await writeFile(path.join(staticRootV01, "client.js"), "export const clientV01 = true;\n");

    staticRootV02 = await mkdtemp(path.join(tmpdir(), "next-round-mod-v02-"));
    await writeFile(path.join(staticRootV02, "client.js"), "export const clientV02 = true;\n");

    registry = new GameRegistry();
    // Register v0.1.0 initially
    registry.register(testCounterManifest, testCounterServer, {
      clientRoot: staticRootV01,
      isDefault: true,
    });

    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot: staticRootV01,
      databasePool,
      setupToken: randomBytes(32).toString("hex"),
      origin,
      gameRegistry: registry,
    });

    adminSession = await seedSession("Admin", "admin_user", "admin");
    memberA = await seedSession("Player A", "player_a", "member");
    memberB = await seedSession("Player B", "player_b", "member");

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
         VALUES (1, 'Module lifecycle policy', $1::jsonb, $2)`,
        [JSON.stringify(policy), adminSession.principalId],
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
         VALUES ('test-counter', '0.1.0', $1::jsonb, 'fixture-server-v01', 'fixture-client-v01',
                 'next-round-game/0.1', 1, 1)`,
        [JSON.stringify(testCounterManifest)],
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
      await app?.close();
    } finally {
      try {
        const disconnected: Array<Promise<void>> = [];
        databasePool?.on("remove", client => {
          disconnected.push(new Promise<void>(resolve => client.once("end", resolve)));
        });
        await databasePool?.end();
        await Promise.all(disconnected);
      } finally {
        try {
          await adminPool?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally {
          await adminPool?.end();
          await rm(staticRootV01, { recursive: true, force: true });
          await rm(staticRootV02, { recursive: true, force: true });
        }
      }
    }
  });

  it("executes v0.1 pinned reducer, installs v0.2 with distinguishable reducer, updates default, disables module, and preserves existing matches", async () => {
    // 1. Create Match 1 under v0.1.0
    const createRes1 = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: authHeaders(memberA, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "test-counter",
        mode: "group",
        settings: { target: 10, turnSeconds: null },
        visibility: "instance",
      },
    });
    expect(createRes1.statusCode).toBe(201);
    const matchId1 = createRes1.json().data.matchId;

    // Join member B and start Match 1
    const joinRes1 = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId1}/join`,
      headers: authHeaders(memberB, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });
    expect(joinRes1.statusCode).toBe(200);

    const startRes1 = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId1}/start`,
      headers: authHeaders(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: 1 },
    });
    expect(startRes1.statusCode).toBe(200);

    // Member A acts on Match 1 with 'add': v0.1.0 reducer increments count by 1 (0 -> 1)
    const actionRes1 = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId1}/actions`,
      headers: authHeaders(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 2,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(actionRes1.statusCode).toBe(200);

    const snapshotRes1 = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId1}`,
      headers: authHeaders(memberA, false),
    });
    expect(snapshotRes1.statusCode).toBe(200);
    expect(snapshotRes1.json().data.moduleVersion).toBe("0.1.0");
    expect(snapshotRes1.json().data.game.count).toBe(1);

    // 2. Install v0.2.0 with distinguishable reducer:
    // v0.2.0 reducer increments count by 10 per 'add' action
    const manifestV02: GameManifest = { ...testCounterManifest, version: "0.2.0" };
    const serverV02 = {
      ...testCounterServer,
      transition(
        ctx: Parameters<typeof testCounterServer.transition>[0],
        state: Parameters<typeof testCounterServer.transition>[1],
        event: Parameters<typeof testCounterServer.transition>[2],
      ) {
        if (event.kind === "action" && event.type === "add" && state) {
          const actorId = ctx.actor?.memberId;
          const newCount = state.count + 10;
          const currentScore = actorId ? (state.scores[actorId] ?? 0) : 0;
          const newScores = actorId
            ? { ...state.scores, [actorId]: currentScore + 10 }
            : state.scores;
          return {
            ok: true as const,
            value: {
              state: { ...state, count: newCount, scores: newScores },
              phase: "active" as const,
              hostMemberId: ctx.hostMemberId,
              deadlines: [],
              needsActionFrom: [state.turnOrder.find((id) => id !== actorId) ?? actorId ?? ""],
              facts: [],
              final: null,
            },
          };
        }
        return testCounterServer.transition(ctx, state, event);
      },
    };

    // Register v0.2.0 in the registry
    registry.register(manifestV02, serverV02, {
      clientRoot: staticRootV02,
      isDefault: false,
    });

    // Insert v0.2.0 metadata row into database
    await databasePool.query(
      `INSERT INTO next_round.module_versions
         (module_id, version, manifest, server_hash, client_hash, sdk_contract,
          state_version, result_version)
       VALUES ('test-counter', '0.2.0', $1::jsonb, 'fixture-server-v02', 'fixture-client-v02',
               'next-round-game/0.1', 1, 1)`,
      [JSON.stringify(manifestV02)],
    );

    // 3. Update default version to v0.2.0 via PATCH /api/v1/admin/games/:id
    const patchDefaultRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(adminSession, true),
      payload: { defaultVersion: "0.2.0" },
    });
    expect(patchDefaultRes.statusCode).toBe(200);
    expect(patchDefaultRes.json().data.defaultVersion).toBe("0.2.0");

    // 4. Create Match 2 under new default v0.2.0
    const createRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: authHeaders(memberA, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "test-counter",
        mode: "group",
        settings: { target: 20, turnSeconds: null },
        visibility: "instance",
      },
    });
    expect(createRes2.statusCode).toBe(201);
    const matchId2 = createRes2.json().data.matchId;

    await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId2}/join`,
      headers: authHeaders(memberB, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId2}/start`,
      headers: authHeaders(memberA, true),
      payload: { commandId: randomUUID(), expectedRevision: 1 },
    });

    // Member A acts on Match 2 with 'add': v0.2.0 reducer increments count by 10 (0 -> 10)
    const actionRes2 = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId2}/actions`,
      headers: authHeaders(memberA, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 2,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(actionRes2.statusCode).toBe(200);

    const snapshotRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId2}`,
      headers: authHeaders(memberA, false),
    });
    expect(snapshotRes2.statusCode).toBe(200);
    expect(snapshotRes2.json().data.moduleVersion).toBe("0.2.0");
    expect(snapshotRes2.json().data.game.count).toBe(10); // Distinguishable v0.2 reducer output!

    // 5. Disable module via PATCH /api/v1/admin/games/test-counter
    const disableRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(adminSession, true),
      payload: { enabled: false },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().data.enabled).toBe(false);

    // 6. Verify new match creation is rejected with 503 MODULE_UNAVAILABLE
    const createRes3 = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: authHeaders(memberA, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "test-counter",
        mode: "group",
        settings: { target: 10, turnSeconds: null },
        visibility: "instance",
      },
    });
    expect(createRes3.statusCode).toBe(503);
    expect(createRes3.json().error.code).toBe(ERROR_CODES.MODULE_UNAVAILABLE);

    // Public catalog GET /api/v1/games excludes disabled module
    const catalogRes = await app.inject({
      method: "GET",
      url: "/api/v1/games",
      headers: authHeaders(memberA, false),
    });
    expect(catalogRes.statusCode).toBe(200);
    expect(catalogRes.json().data.some((m: { id: string }) => m.id === "test-counter")).toBe(false);

    // 7. Old Match 1 (pinned to v0.1.0) STILL runs exact v0.1.0 reducer!
    // Member B acts on Match 1: count advances 1 -> 2 (increment of 1, NOT 10)
    const oldMatchActionRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId1}/actions`,
      headers: authHeaders(memberB, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 3,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(oldMatchActionRes.statusCode).toBe(200);

    const oldMatchSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId1}`,
      headers: authHeaders(memberB, false),
    });
    expect(oldMatchSnapshot.statusCode).toBe(200);
    expect(oldMatchSnapshot.json().data.moduleVersion).toBe("0.1.0");
    expect(oldMatchSnapshot.json().data.game.count).toBe(2);

    // 8. Existing Match 2 (pinned to v0.2.0) STILL runs exact v0.2.0 reducer!
    const v2MatchActionRes = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId2}/actions`,
      headers: authHeaders(memberB, true),
      payload: {
        commandId: randomUUID(),
        expectedRevision: 3,
        type: "add",
        payload: { amount: 1 },
      },
    });
    expect(v2MatchActionRes.statusCode).toBe(200);

    const v2MatchSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId2}`,
      headers: authHeaders(memberB, false),
    });
    expect(v2MatchSnapshot.statusCode).toBe(200);
    expect(v2MatchSnapshot.json().data.moduleVersion).toBe("0.2.0");
    expect(v2MatchSnapshot.json().data.game.count).toBe(20); // 10 + 10 = 20
  });

  it("checks module retention readiness and refuses missing referenced server code or browser assets", async () => {
    // Seed an active match and a finished match in the database referencing test-counter@0.1.0
    const finishedMatchId = randomUUID();
    const activeMatchId = randomUUID();
    await databasePool.query(
      `INSERT INTO next_round.matches
         (id, module_id, module_version, state_version, mode, phase, creator_id,
          settings, visibility, policy_version, policy_snapshot, revision, state,
          needs_action_from, started_at, finished_at)
       VALUES
         ($1, 'test-counter', '0.1.0', 1, 'group', 'finished', $3,
          '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 5, '{"count":10,"target":10}'::jsonb,
          '{}'::uuid[], now() - interval '1 hour', now()),
         ($2, 'test-counter', '0.1.0', 1, 'group', 'active', $3,
          '{"target":10}'::jsonb, 'instance', 1, '{}'::jsonb, 2, '{"count":2,"target":10}'::jsonb,
          '{}'::uuid[], now(), NULL)`,
      [finishedMatchId, activeMatchId, memberA.principalId],
    );

    // 1. Fully installed version passes readiness
    const readyResult = await checkModuleRetentionReadiness(databasePool, registry);
    expect(readyResult.ready).toBe(true);
    expect(readyResult.errors).toEqual([]);

    const healthRes = await app.inject({
      method: "GET",
      url: "/health/ready",
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().checks.registry).toBe("ok");

    // 2. Missing server code for referenced version fails check with actionable safe references
    const registryWithoutServer = new GameRegistry();
    registryWithoutServer.register(testCounterManifest, undefined, {
      clientRoot: staticRootV01,
      isDefault: true,
    });

    const missingServerResult = await checkModuleRetentionReadiness(databasePool, registryWithoutServer);
    expect(missingServerResult.ready).toBe(false);
    expect(missingServerResult.referencedVersions[0]).toMatchObject({
      moduleId: "test-counter",
      version: "0.1.0",
      hasServer: false,
      matchCounts: { active: 1, finished: 1, total: 2 },
    });
    await expect(
      verifyModuleRetentionReadiness(databasePool, registryWithoutServer),
    ).rejects.toThrow();

    // 3. Missing browser asset for referenced version fails check
    const emptyAssetDir = await mkdtemp(path.join(tmpdir(), "next-round-empty-assets-"));
    try {
      const registryWithMissingAsset = new GameRegistry();
      // Write client.js to satisfy registration validation, then delete it to simulate removal
      const dummyClientPath = path.join(emptyAssetDir, "client.js");
      await writeFile(dummyClientPath, "export const c = 1;\n");
      registryWithMissingAsset.register(testCounterManifest, testCounterServer, {
        clientRoot: emptyAssetDir,
        isDefault: true,
      });
      await rm(dummyClientPath, { force: true });

      const missingAssetResult = await checkModuleRetentionReadiness(databasePool, registryWithMissingAsset);
      expect(missingAssetResult.ready).toBe(false);
      expect(missingAssetResult.referencedVersions[0].hasClientAssets).toBe(false);
      await expect(
        verifyModuleRetentionReadiness(databasePool, registryWithMissingAsset),
      ).rejects.toThrow();
    } finally {
      await rm(emptyAssetDir, { recursive: true, force: true });
    }

    // 4. Unreferenced metadata row in module_versions alone does NOT fail readiness
    await databasePool.query(
      `INSERT INTO next_round.module_versions
         (module_id, version, manifest, server_hash, client_hash, sdk_contract,
          state_version, result_version)
       VALUES ('test-counter', '0.9.9', '{}'::jsonb, 'pruned-server', 'pruned-client',
               'next-round-game/0.1', 1, 1)`,
    );

    // Version 0.9.9 is not in the registry, but has 0 matches and is not default version
    const unreferencedCheck = await checkModuleRetentionReadiness(databasePool, registry);
    expect(unreferencedCheck.ready).toBe(true);
    expect(unreferencedCheck.errors).toEqual([]);
  });

  it("handles GET /admin/games and PATCH /admin/games/:id authorization and validation", async () => {
    // 1. Non-admin is forbidden
    const forbiddenGet = await app.inject({
      method: "GET",
      url: "/api/v1/admin/games",
      headers: authHeaders(memberA, false),
    });
    expect(forbiddenGet.statusCode).toBe(403);
    expect(forbiddenGet.json().error.code).toBe(ERROR_CODES.FORBIDDEN);

    const forbiddenPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(memberA, true),
      payload: { enabled: false },
    });
    expect(forbiddenPatch.statusCode).toBe(403);

    // 2. Admin can list installed games with version summaries and reference counts
    const adminGet = await app.inject({
      method: "GET",
      url: "/api/v1/admin/games",
      headers: authHeaders(adminSession, false),
    });
    expect(adminGet.statusCode).toBe(200);
    const games = adminGet.json().data as AdminGameSummary[];
    expect(Array.isArray(games)).toBe(true);
    const counterGame = games.find((g) => g.id === "test-counter");
    expect(counterGame).toBeDefined();
    expect(counterGame?.enabled).toBe(true);
    expect(counterGame?.defaultVersion).toBe("0.1.0");
    expect(counterGame?.versions.length).toBeGreaterThanOrEqual(1);
    expect(counterGame?.versions[0].hasServer).toBe(true);
    expect(counterGame?.versions[0].hasClientAssets).toBe(true);

    // 3. Patching with non-installed defaultVersion rejects with 400 INVALID_REQUEST
    const invalidVersionPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(adminSession, true),
      payload: { defaultVersion: "9.9.9" },
    });
    expect(invalidVersionPatch.statusCode).toBe(400);
    expect(invalidVersionPatch.json().error.code).toBe(ERROR_CODES.INVALID_REQUEST);

    // 4. Patching non-existent module rejects with 404 NOT_FOUND
    const notFoundPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/non-existent-game",
      headers: authHeaders(adminSession, true),
      payload: { enabled: false },
    });
    expect(notFoundPatch.statusCode).toBe(404);
    expect(notFoundPatch.json().error.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("enforces live transactional authorization: revoked, demoted, or disabled admin cannot patch or list games", async () => {
    const demotedAdmin = await seedSession("DemotedAdmin", "demoted_admin", "admin");
    const disabledAdmin = await seedSession("DisabledAdmin", "disabled_admin", "admin");
    const revokedAdmin = await seedSession("RevokedAdmin", "revoked_admin", "admin");

    // 1. Demoting admin role to member immediately denies GET /admin/games
    await databasePool.query(
      "UPDATE next_round.accounts SET role = 'member' WHERE principal_id = $1",
      [demotedAdmin.principalId],
    );
    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/games",
      headers: authHeaders(demotedAdmin, false),
    });
    expect(getRes.statusCode).toBe(403);
    expect(getRes.json().error.code).toBe(ERROR_CODES.FORBIDDEN);

    // Demoted admin cannot PATCH /admin/games/:id
    const patchRes1 = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(demotedAdmin, true),
      payload: { enabled: false },
    });
    expect(patchRes1.statusCode).toBe(403);
    expect(patchRes1.json().error.code).toBe(ERROR_CODES.FORBIDDEN);

    // 2. Disabling admin account denies PATCH /admin/games/:id with ACCOUNT_DISABLED
    await databasePool.query(
      "UPDATE next_round.principals SET disabled_at = now() WHERE id = $1",
      [disabledAdmin.principalId],
    );
    const patchRes2 = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(disabledAdmin, true),
      payload: { enabled: false },
    });
    expect(patchRes2.statusCode).toBe(403);
    expect(patchRes2.json().error.code).toBe(ERROR_CODES.ACCOUNT_DISABLED);

    // 3. Revoking session denies PATCH /admin/games/:id with SESSION_EXPIRED
    await databasePool.query(
      "UPDATE next_round.sessions SET revoked_at = now() WHERE principal_id = $1",
      [revokedAdmin.principalId],
    );
    const patchRes3 = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/games/test-counter",
      headers: authHeaders(revokedAdmin, true),
      payload: { enabled: false },
    });
    expect(patchRes3.statusCode).toBe(401);
    expect(patchRes3.json().error.code).toBe(ERROR_CODES.SESSION_EXPIRED);
  });

  it("maintains catalog and default game consistency across two separate nodes with different in-memory registries", async () => {
    const manifestV02: GameManifest = { ...testCounterManifest, version: "0.2.0" };
    const serverV02 = {
      ...testCounterServer,
      transition: testCounterServer.transition,
    };

    // Node A registry
    registry.register(manifestV02, serverV02, {
      clientRoot: staticRootV02,
      isDefault: false,
    });

    // Node B registry: registers v0.1.0 as default, and v0.2.0 as non-default
    const registryB = new GameRegistry();
    registryB.register(testCounterManifest, testCounterServer, {
      clientRoot: staticRootV01,
      isDefault: true,
    });
    registryB.register(manifestV02, serverV02, {
      clientRoot: staticRootV02,
      isDefault: false,
    });

    await databasePool.query(
      `INSERT INTO next_round.module_versions
         (module_id, version, manifest, server_hash, client_hash, sdk_contract,
          state_version, result_version)
       VALUES ('test-counter', '0.2.0', $1::jsonb, 'fixture-server-v02', 'fixture-client-v02',
               'next-round-game/0.1', 1, 1)`,
      [JSON.stringify(manifestV02)],
    );

    const nodeBApp = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot: staticRootV01,
      databasePool,
      setupToken: randomBytes(32).toString("hex"),
      origin,
      gameRegistry: registryB,
    });

    try {
      // 1. Initially, both nodes serve v0.1.0 (the DB default)
      const catalogBefore = await nodeBApp.inject({
        method: "GET",
        url: "/api/v1/games",
        headers: authHeaders(memberA, false),
      });
      expect(catalogBefore.statusCode).toBe(200);
      const gameBefore = catalogBefore.json().data.find((g: { id: string }) => g.id === "test-counter");
      expect(gameBefore.version).toBe("0.1.0");

      // 2. Admin patches default version to 0.2.0 on Node A
      const patchRes = await app.inject({
        method: "PATCH",
        url: "/api/v1/admin/games/test-counter",
        headers: authHeaders(adminSession, true),
        payload: { defaultVersion: "0.2.0" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().data.defaultVersion).toBe("0.2.0");

      // 3. Node B serves v0.2.0 in GET /games despite its in-memory registry having v0.1.0 default
      const catalogAfter = await nodeBApp.inject({
        method: "GET",
        url: "/api/v1/games",
        headers: authHeaders(memberA, false),
      });
      expect(catalogAfter.statusCode).toBe(200);
      const gameAfter = catalogAfter.json().data.find((g: { id: string }) => g.id === "test-counter");
      expect(gameAfter.version).toBe("0.2.0");

      // 4. Node B serves v0.2.0 in GET /games/:id default endpoint
      const defaultGameRes = await nodeBApp.inject({
        method: "GET",
        url: "/api/v1/games/test-counter",
        headers: authHeaders(memberA, false),
      });
      expect(defaultGameRes.statusCode).toBe(200);
      expect(defaultGameRes.json().data.version).toBe("0.2.0");
    } finally {
      await nodeBApp.close();
    }
  });

  it("fails closed when catalog or retention tables are unavailable", async () => {
    await app.ready();
    await databasePool.query("ALTER TABLE next_round.modules RENAME TO unavailable_modules");
    try {
      const catalog = await app.inject({
        method: "GET",
        url: "/api/v1/games",
        headers: authHeaders(memberA),
      });
      expect(catalog.statusCode).toBe(500);
      expect(catalog.json().error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      await expect(checkModuleRetentionReadiness(databasePool, registry)).rejects.toMatchObject({
        code: "42P01",
      });
    } finally {
      await databasePool.query("ALTER TABLE next_round.unavailable_modules RENAME TO modules");
    }
  });

  it("validates server code and actual asset files on disk in patchAdminGame and getAdminGames", async () => {
    const tempAssetDir = await mkdtemp(path.join(tmpdir(), "next-round-v03-assets-"));
    try {
      const tempClientJs = path.join(tempAssetDir, "client.js");
      await writeFile(tempClientJs, "export const v03 = true;\n");

      const manifestV03: GameManifest = { ...testCounterManifest, version: "0.3.0" };
      registry.register(manifestV03, testCounterServer, {
        clientRoot: tempAssetDir,
        isDefault: false,
      });

      await databasePool.query(
        `INSERT INTO next_round.module_versions
           (module_id, version, manifest, server_hash, client_hash, sdk_contract,
            state_version, result_version)
         VALUES ('test-counter', '0.3.0', $1::jsonb, 'fixture-server-v03', 'fixture-client-v03',
                 'next-round-game/0.1', 1, 1)`,
        [JSON.stringify(manifestV03)],
      );

      // 1. Initial admin check reports hasClientAssets: true
      const adminGet1 = await app.inject({
        method: "GET",
        url: "/api/v1/admin/games",
        headers: authHeaders(adminSession, false),
      });
      expect(adminGet1.statusCode).toBe(200);
      const v03Summary1 = adminGet1.json().data
        .find((g: { id: string }) => g.id === "test-counter")
        ?.versions.find((v: { version: string }) => v.version === "0.3.0");
      expect(v03Summary1.hasClientAssets).toBe(true);

      // 2. Delete asset file: admin summary must immediately reflect hasClientAssets: false
      await rm(tempClientJs, { force: true });
      const adminGet2 = await app.inject({
        method: "GET",
        url: "/api/v1/admin/games",
        headers: authHeaders(adminSession, false),
      });
      expect(adminGet2.statusCode).toBe(200);
      const v03Summary2 = adminGet2.json().data
        .find((g: { id: string }) => g.id === "test-counter")
        ?.versions.find((v: { version: string }) => v.version === "0.3.0");
      expect(v03Summary2.hasClientAssets).toBe(false);

      // 3. Trying to patch defaultVersion to v0.3.0 with missing assets rejects with 400
      const patchMissingAssetRes = await app.inject({
        method: "PATCH",
        url: "/api/v1/admin/games/test-counter",
        headers: authHeaders(adminSession, true),
        payload: { defaultVersion: "0.3.0" },
      });
      expect(patchMissingAssetRes.statusCode).toBe(400);
      expect(patchMissingAssetRes.json().error.code).toBe(ERROR_CODES.INVALID_REQUEST);

      // 4. Trying to patch defaultVersion to a version without server implementation rejects with 400
      const manifestV04: GameManifest = { ...testCounterManifest, version: "0.4.0" };
      await writeFile(tempClientJs, "export const v04 = true;\n");
      registry.register(manifestV04, undefined, {
        clientRoot: tempAssetDir,
        isDefault: false,
      });
      await databasePool.query(
        `INSERT INTO next_round.module_versions
           (module_id, version, manifest, server_hash, client_hash, sdk_contract,
            state_version, result_version)
         VALUES ('test-counter', '0.4.0', $1::jsonb, 'fixture-server-v04', 'fixture-client-v04',
                 'next-round-game/0.1', 1, 1)`,
        [JSON.stringify(manifestV04)],
      );

      const patchMissingServerRes = await app.inject({
        method: "PATCH",
        url: "/api/v1/admin/games/test-counter",
        headers: authHeaders(adminSession, true),
        payload: { defaultVersion: "0.4.0" },
      });
      expect(patchMissingServerRes.statusCode).toBe(400);
      expect(patchMissingServerRes.json().error.code).toBe(ERROR_CODES.INVALID_REQUEST);
    } finally {
      await rm(tempAssetDir, { recursive: true, force: true });
    }
  });
  it("installs fresh game metadata atomically and preserves disabled/default/version choices on restart", async () => {
    const fresh = { ...testCounterManifest, id: "fresh-install" };
    await installGameVersion(databasePool, fresh, { serverHash: "server-one", clientHash: "client-one" });
    await databasePool.query("UPDATE next_round.modules SET enabled=false WHERE id='fresh-install'");
    const newer = { ...fresh, version: "0.2.0" };
    await Promise.all([
      installGameVersion(databasePool, newer, { serverHash: "server-two", clientHash: "client-two" }),
      installGameVersion(databasePool, newer, { serverHash: "server-two", clientHash: "client-two" }),
    ]);
    await installGameVersion(databasePool, fresh, { serverHash: "changed", clientHash: "changed" });
    const modules = await databasePool.query("SELECT enabled, default_version FROM next_round.modules WHERE id='fresh-install'");
    expect(modules.rows).toEqual([{ enabled: false, default_version: "0.1.0" }]);
    const versions = await databasePool.query("SELECT version, server_hash, client_hash FROM next_round.module_versions WHERE module_id='fresh-install' ORDER BY version");
    expect(versions.rows).toEqual([
      { version: "0.1.0", server_hash: "server-one", client_hash: "client-one" },
      { version: "0.2.0", server_hash: "server-two", client_hash: "client-two" },
    ]);
  });

});
