// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdminGameImportResponseSchema,
  ApiResponseSchema,
  CreateMatchResponseSchema,
  GameResourceCatalogResponseSchema,
  parseRequestBody,
} from "@next-round/contracts";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { GameRegistry } from "@next-round/platform";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";

const DOCUMENT = {
  format: "next-round.crossword/1",
  title: "Integration Grid",
  author: "Next Round",
  language: "en",
  difficulty: "easy",
  rights: {
    license: "CC0-1.0",
    sourceUrl: null,
    attribution: "Next Round integration fixture",
    permissionNote: null,
  },
  rows: ["ABCDE", "FGHIJ", "KLMNO", "PQ#RS"],
  clues: [
    { direction: "across", row: 0, col: 0, text: "First across" },
    { direction: "across", row: 1, col: 0, text: "Second across" },
    { direction: "across", row: 2, col: 0, text: "Third across" },
    { direction: "across", row: 3, col: 0, text: "Fourth across" },
    { direction: "across", row: 3, col: 3, text: "Fifth across" },
    { direction: "down", row: 0, col: 0, text: "First down" },
    { direction: "down", row: 0, col: 1, text: "Second down" },
    { direction: "down", row: 0, col: 2, text: "Third down" },
    { direction: "down", row: 0, col: 3, text: "Fourth down" },
    { direction: "down", row: 0, col: 4, text: "Fifth down" },
  ],
};

const MatchCreationResponseSchema = ApiResponseSchema(
  CreateMatchResponseSchema,
);

const SOLO_SETTINGS = {
  preset: "solo_casual",
  wrongGuessesPerTurn: null,
  correctWordsPerTurn: null,
  turnSeconds: null,
};

/** Reads the module view of a snapshot response without unchecked casts. */
function readGameView(body: string): {
  title: string | null;
  clues: unknown;
  board: unknown;
} {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    throw new Error("The snapshot response has no data.");
  }
  const data = parsed.data;
  if (!data || typeof data !== "object" || !("game" in data)) {
    throw new Error("The snapshot response has no game view.");
  }
  const game = data.game;
  if (!game || typeof game !== "object") {
    throw new Error("The snapshot response has no game view.");
  }
  const view = game as Record<string, unknown>;
  return {
    title: typeof view.title === "string" ? view.title : null,
    clues: view.clues,
    board: view.board,
  };
}

interface SessionFixture {
  principalId: string;
  cookie: string;
  csrf: string;
}

function headers(session: SessionFixture, mutation = false): Record<string, string> {
  const result: Record<string, string> = { cookie: session.cookie };
  if (mutation) {
    result.origin = origin;
    result["content-type"] = "application/json";
    result["x-csrf-token"] = session.csrf;
  }
  return result;
}

describe.skipIf(!testDatabaseUrl)("crossword resource and exposure flow", () => {
  let adminPool: DatabasePool;
  let databasePool: DatabasePool;
  let app: FastifyInstance;
  let databaseName: string;
  let staticRoot: string;
  let admin: SessionFixture;
  let member: SessionFixture;

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
    databaseName = `next_round_crossword_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: testDatabaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    await migrateDatabase({ connectionString: url.toString() });
    databasePool = createDatabasePool({ connectionString: url.toString(), max: 8 });

    staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-crossword-"));
    await writeFile(
      path.join(staticRoot, "client.js"),
      "export const clientFixture = true;\n",
    );
    // Game modules are runtime registry plugins, and the API package must not
    // depend on one game, so the fixture loads it from its source path.
    const manifestModule = await import(
      new URL("../../../games/crossword/src/manifest.ts", import.meta.url).href
    );
    const serverModule = await import(
      new URL("../../../games/crossword/src/server.ts", import.meta.url).href
    );
    const registry = new GameRegistry();
    registry.register(manifestModule.manifest, serverModule.server, {
      clientRoot: staticRoot,
    });

    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      staticRoot,
      databasePool,
      setupToken: randomBytes(32).toString("hex"),
      origin,
      gameRegistry: registry,
    });

    admin = await seedSession("Admin", "admin_user", "admin");
    member = await seedSession("Member", "member_user");

    const policy = {
      schemaVersion: 1,
      historyVisibility: "participants",
      statsVisibility: "instance",
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
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO next_round.instance_policy
           (version, instance_name, policy, changed_by)
         VALUES (1, 'Crossword fixture', $1::jsonb, $2)`,
        [JSON.stringify(policy), admin.principalId],
      );
      await client.query(
        "INSERT INTO next_round.instance_singleton (id, current_policy_version) VALUES (true, 1)",
      );
      await client.query(
        "INSERT INTO next_round.modules (id, default_version) VALUES ('crossword', '0.1.0')",
      );
      await client.query(
        `INSERT INTO next_round.module_versions
           (module_id, version, manifest, server_hash, client_hash, sdk_contract,
            state_version, result_version)
         VALUES ('crossword', '0.1.0', $1::jsonb, 'fixture-server', 'fixture-client',
                 'next-round-game/0.1', 1, 1)`,
        [JSON.stringify(manifestModule.manifest)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    const disconnected: Array<Promise<void>> = [];
    databasePool?.on("remove", (client) => {
      disconnected.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
    await databasePool?.end();
    await Promise.all(disconnected);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  }, 60_000);

  async function importDocument(
    session: SessionFixture,
    document: unknown,
  ): Promise<{ status: number; body: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/games/crossword/import",
      headers: headers(session, true),
      payload: { commandId: randomUUID(), document },
    });
    return { status: response.statusCode, body: response.body };
  }

  it("imports a puzzle, exposes the catalog and pins the resource on a match", async () => {
    const imported = await importDocument(admin, DOCUMENT);
    expect(imported.status).toBe(201);
    const receipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(imported.body),
    ).data;
    expect(receipt.version).toBe(1);
    expect(receipt.duplicate).toBe(false);
    expect(receipt.identity).toMatch(/^[0-9a-f]{64}$/);

    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/games/crossword/resources",
      headers: headers(member),
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.body).not.toContain("ABCDE");
    expect(catalog.body).not.toContain(receipt.identity);
    const entries = parseRequestBody(
      GameResourceCatalogResponseSchema,
      JSON.parse(catalog.body),
    ).data;
    expect(entries).toHaveLength(1);
    expect(entries[0].resourceId).toBe(receipt.resourceId);
    expect(entries[0].version).toBe(1);
    // The catalog publishes the public metadata, never the private content.
    expect(catalog.body).toContain("Integration Grid");
    expect(catalog.body).toContain("CC0-1.0");
    expect(catalog.body).not.toContain("KLMNO");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(member, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "crossword",
        mode: "solo",
        settings: SOLO_SETTINGS,
        resourceId: receipt.resourceId,
        visibility: "invite",
      },
    });
    expect(created.statusCode).toBe(201);
    const matchId = parseRequestBody(
      MatchCreationResponseSchema,
      JSON.parse(created.body),
    ).data.matchId;

    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(member),
    });
    expect(snapshot.statusCode).toBe(200);
    const lobby = readGameView(snapshot.body);
    expect(lobby.title).toBe("Integration Grid");
    // The lobby publishes no clues and no board.
    expect(lobby.clues).toBeNull();
    expect(lobby.board).toBeNull();
    expect(snapshot.body).not.toContain("ABCDE");

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${matchId}/start`,
      headers: headers(member, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });
    expect(started.statusCode).toBe(200);

    const active = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}`,
      headers: headers(member),
    });
    expect(active.body).toContain("First across");
    expect(active.body).not.toContain("ABCDE");
  });

  it("rejects a match without a resource and a non-admin import", async () => {
    const imported = await importDocument(admin, DOCUMENT);
    const receipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(imported.body),
    ).data;
    const withoutResource = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(member, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "crossword",
        mode: "solo",
        settings: SOLO_SETTINGS,
        visibility: "invite",
      },
    });
    expect(withoutResource.statusCode).toBe(400);

    const forbidden = await importDocument(member, DOCUMENT);
    expect(forbidden.status).toBe(403);
    expect(receipt.resourceId).toBeTruthy();
  });

  it("reports why a document was rejected without storing it", async () => {
    const rejected = await importDocument(admin, {
      ...DOCUMENT,
      rights: { ...DOCUMENT.rights, license: "proprietary" },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body).toContain("rights.license");

    const rows = await databasePool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM next_round.module_resources",
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("keeps one identity for the same grid and versions changed content", async () => {
    const first = await importDocument(admin, DOCUMENT);
    const firstReceipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(first.body),
    ).data;
    const second = await importDocument(admin, DOCUMENT);
    const secondReceipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(second.body),
    ).data;
    expect(secondReceipt.identity).toBe(firstReceipt.identity);
    expect(secondReceipt.resourceId).toBe(firstReceipt.resourceId);
    expect(secondReceipt.duplicate).toBe(true);
    expect(secondReceipt.version).toBe(1);

    const changed = await importDocument(admin, {
      ...DOCUMENT,
      clues: DOCUMENT.clues.map((clue) =>
        clue.direction === "across" && clue.row === 0
          ? { ...clue, text: "Changed across" }
          : clue,
      ),
    });
    const changedReceipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(changed.body),
    ).data;
    expect(changedReceipt.identity).toBe(firstReceipt.identity);
    expect(changedReceipt.duplicate).toBe(false);
    expect(changedReceipt.version).toBe(2);
    expect(changedReceipt.resourceId).not.toBe(firstReceipt.resourceId);
  });

  it("records the exposure of a started match and excludes the next match", async () => {
    const imported = await importDocument(admin, DOCUMENT);
    const receipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(imported.body),
    ).data;
    const settings = {
      preset: "solo_casual",
      wrongGuessesPerTurn: null,
      correctWordsPerTurn: null,
      turnSeconds: null,
    };

    const createMatch = async (): Promise<string> => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/matches",
        headers: headers(member, true),
        payload: {
          commandId: randomUUID(),
          moduleId: "crossword",
          mode: "solo",
          settings: SOLO_SETTINGS,
          resourceId: receipt.resourceId,
          visibility: "invite",
        },
      });
      expect(created.statusCode).toBe(201);
      return parseRequestBody(
        MatchCreationResponseSchema,
        JSON.parse(created.body),
      ).data.matchId;
    };

    const firstMatch = await createMatch();
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${firstMatch}/start`,
      headers: headers(member, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });
    expect(started.statusCode).toBe(200);

    const facts = await databasePool.query<{ fact_key: string; value: unknown }>(
      `SELECT f.fact_key, f.value
         FROM next_round.module_facts f
         JOIN next_round.resource_identities ri ON ri.id = f.identity_id
        WHERE ri.module_id = 'crossword' AND f.principal_id = $1`,
      [member.principalId],
    );
    expect(facts.rows.map((row) => row.fact_key).sort()).toEqual([
      "crossword/seen",
    ]);

    // The importer is recorded as exposed on the imported content.
    const importerFacts = await databasePool.query<{ fact_key: string }>(
      `SELECT f.fact_key
         FROM next_round.module_facts f
         JOIN next_round.resource_identities ri ON ri.id = f.identity_id
        WHERE ri.module_id = 'crossword' AND f.principal_id = $1`,
      [admin.principalId],
    );
    expect(importerFacts.rows.map((row) => row.fact_key)).toEqual([
      "crossword/imported",
    ]);

    // A second overlapping match on the same puzzle observes the first
    // exposure and latches the match-wide career exclusion.
    const secondMatch = await createMatch();
    const secondStart = await app.inject({
      method: "POST",
      url: `/api/v1/matches/${secondMatch}/start`,
      headers: headers(member, true),
      payload: { commandId: randomUUID(), expectedRevision: 0 },
    });
    expect(secondStart.statusCode).toBe(200);

    const state = await databasePool.query<{ state: { exclusionReasons: string[] } }>(
      "SELECT state FROM next_round.matches WHERE id = $1",
      [secondMatch],
    );
    expect(state.rows[0].state.exclusionReasons).toContain("prior_exposure");
  });

  it("refuses a hidden resource for a new match", async () => {
    const imported = await importDocument(admin, DOCUMENT);
    const receipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(imported.body),
    ).data;
    await databasePool.query(
      "UPDATE next_round.module_resources SET hidden_at = clock_timestamp() WHERE id = $1",
      [receipt.resourceId],
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(member, true),
      payload: {
        commandId: randomUUID(),
        moduleId: "crossword",
        mode: "solo",
        settings: SOLO_SETTINGS,
        resourceId: receipt.resourceId,
        visibility: "invite",
      },
    });
    expect(created.statusCode).toBe(404);
  });

  it("replays an identical import command and rejects a changed one", async () => {
    const commandId = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/admin/games/crossword/import",
      headers: headers(admin, true),
      payload: { commandId, document: DOCUMENT },
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/admin/games/crossword/import",
      headers: headers(admin, true),
      payload: { commandId, document: DOCUMENT },
    });
    expect(replay.statusCode).toBe(201);
    const firstReceipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(first.body),
    ).data;
    const replayReceipt = parseRequestBody(
      AdminGameImportResponseSchema,
      JSON.parse(replay.body),
    ).data;
    expect(replayReceipt.resourceId).toBe(firstReceipt.resourceId);

    const conflicting = await app.inject({
      method: "POST",
      url: "/api/v1/admin/games/crossword/import",
      headers: headers(admin, true),
      payload: {
        commandId,
        document: { ...DOCUMENT, title: "Another title" },
      },
    });
    expect(conflicting.statusCode).toBe(409);
  });
});
