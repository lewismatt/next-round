// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdminGameImportResponseSchema,
  ApiResponseSchema,
  CreateMatchResponseSchema,
  parseRequestBody,
} from "@next-round/contracts";
import { createDatabasePool } from "@next-round/db";
import type { DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { GameRegistry, MatchService } from "@next-round/platform";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

/**
 * Master Spec §9 C5 — focused crossword acceptance, adversarial exposure
 * fixtures. Every case runs through the real HTTP API and the real
 * transaction path (the same surface the production lobby/start/join UI
 * uses), against one stable puzzle identity and explicit principal
 * identities. Assertions are deterministic: exposure facts, latched
 * exclusions and final career contributions are read back from the
 * database and the result projection.
 *
 * Pinned cross-match declaration semantics (decided for F3-B): the start
 * and late-join exposure checks consult the `crossword/imported` and
 * `crossword/seen` facts only. A `crossword/declared` fact recorded in
 * another match does NOT exclude a match the declarant later starts or
 * joins; a declaration latches the exclusion of the match it was made in.
 * The "cross-match declaration" case below pins this behavior.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.npm_lifecycle_event === "test:integration") {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const origin = "http://localhost:3000";

const DOCUMENT = {
  format: "next-round.crossword/1",
  title: "Acceptance Grid",
  author: "Next Round",
  language: "en",
  difficulty: "easy",
  rights: {
    license: "CC0-1.0",
    sourceUrl: null,
    attribution: "Next Round acceptance fixture",
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

/** Across answers by word id; submitting all five completes the grid. */
const ACROSS_ANSWERS: Record<string, string> = {
  "1A": "ABCDE",
  "6A": "FGHIJ",
  "7A": "KLMNO",
  "8A": "PQ",
  "9A": "RS",
};

const QUICK_SETTINGS = {
  preset: "quick",
  wrongGuessesPerTurn: 3,
  correctWordsPerTurn: 1,
  turnSeconds: null,
};

const SOLO_SETTINGS = {
  preset: "solo_casual",
  wrongGuessesPerTurn: null,
  correctWordsPerTurn: null,
  turnSeconds: null,
};

const CUSTOM_TIMER_SETTINGS = {
  preset: "custom",
  wrongGuessesPerTurn: null,
  correctWordsPerTurn: null,
  turnSeconds: 10,
};

interface SessionFixture {
  principalId: string;
  cookie: string;
  csrf: string;
}

function headers(
  session: SessionFixture,
  mutation = false,
): Record<string, string> {
  const result: Record<string, string> = { cookie: session.cookie };
  if (mutation) {
    result.origin = origin;
    result["content-type"] = "application/json";
    result["x-csrf-token"] = session.csrf;
  }
  return result;
}

interface CrosswordViewShape {
  phase: string;
  clues: unknown;
  board: unknown;
  numbers: unknown;
  privateFeedback: { lastWrongGuess: string | null } | null;
  exclusionReasons?: string[];
}

interface SnapshotShape {
  revision: number;
  phase: string;
  game: CrosswordViewShape;
}

interface ResultParticipant {
  memberId: string;
  score: number;
  win: boolean;
  careerEligible: boolean;
  exclusionReasons: string[];
}

describe.skipIf(!testDatabaseUrl)(
  "crossword C5 acceptance (adversarial exposure fixtures)",
  () => {
    let adminPool: DatabasePool;
    let databasePool: DatabasePool;
    let app: FastifyInstance;
    let databaseName: string;
    let staticRoot: string;
    let registry: GameRegistry;
    let resourceId: string;
    let admin: SessionFixture;
    let host: SessionFixture;
    let p2: SessionFixture;
    let p3: SessionFixture;
    let p4: SessionFixture;
    let p5: SessionFixture;
    let p6: SessionFixture;

    async function seedSession(
      displayName: string,
      username: string,
      role: "admin" | "member" = "member",
      canInviteGuests = false,
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
           (principal_id, username, password_hash, role, can_invite_guests)
         VALUES ($1, $2, 'unused-in-integration-fixture', $3, $4)`,
        [principalId, username, role, canInviteGuests],
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
      databaseName = `next_round_c5_${randomUUID().replaceAll("-", "")}`;
      adminPool = createDatabasePool({
        connectionString: testDatabaseUrl,
        max: 1,
      });
      await adminPool.query(
        `CREATE DATABASE "${databaseName}" TEMPLATE template0`,
      );
      const url = new URL(testDatabaseUrl!);
      url.pathname = `/${databaseName}`;
      await migrateDatabase({ connectionString: url.toString() });
      databasePool = createDatabasePool({
        connectionString: url.toString(),
        max: 8,
      });

      staticRoot = await mkdtemp(path.join(tmpdir(), "next-round-c5-"));
      await writeFile(
        path.join(staticRoot, "client.js"),
        "export const clientFixture = true;\n",
      );
      const manifestModule = await import(
        new URL("../../../games/crossword/src/manifest.ts", import.meta.url)
          .href
      );
      const serverModule = await import(
        new URL("../../../games/crossword/src/server.ts", import.meta.url).href
      );
      registry = new GameRegistry();
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
      host = await seedSession("Host", "host_user", "member", true);
      p2 = await seedSession("Player Two", "player_two");
      p3 = await seedSession("Player Three", "player_three");
      p4 = await seedSession("Player Four", "player_four");
      p5 = await seedSession("Player Five", "player_five");
      p6 = await seedSession("Player Six", "player_six");

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
           VALUES (1, 'Crossword C5 fixture', $1::jsonb, $2)`,
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

      const imported = await app.inject({
        method: "POST",
        url: "/api/v1/admin/games/crossword/import",
        headers: headers(admin, true),
        payload: { commandId: randomUUID(), document: DOCUMENT },
      });
      expect(imported.statusCode).toBe(201);
      resourceId = parseRequestBody(
        AdminGameImportResponseSchema,
        JSON.parse(imported.body),
      ).data.resourceId;
    }, 120_000);

    afterEach(async () => {
      await app?.close();
      const disconnected: Array<Promise<void>> = [];
      databasePool?.on("remove", (client) => {
        disconnected.push(
          new Promise<void>((resolve) => client.once("end", resolve)),
        );
      });
      await databasePool?.end();
      await Promise.all(disconnected);
      if (adminPool) {
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await adminPool.end();
      }
      if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
    }, 60_000);

    async function revisionOf(matchId: string): Promise<number> {
      const rows = await databasePool.query<{ revision: number }>(
        "SELECT revision::integer AS revision FROM next_round.matches WHERE id = $1",
        [matchId],
      );
      return rows.rows[0].revision;
    }

    async function memberIdOf(
      matchId: string,
      principalId: string,
    ): Promise<string> {
      const rows = await databasePool.query<{ id: string }>(
        `SELECT id FROM next_round.match_members
          WHERE match_id = $1 AND principal_id = $2`,
        [matchId, principalId],
      );
      return rows.rows[0].id;
    }

    async function stateOf(matchId: string): Promise<{
      exclusionReasons: string[];
      timeoutRemovalEligible: string[];
      currentMemberId: string | null;
      scores: Record<string, number>;
      turn: { wrong: number; correct: number } | null;
    }> {
      const rows = await databasePool.query<{ state: never }>(
        "SELECT state FROM next_round.matches WHERE id = $1",
        [matchId],
      );
      return rows.rows[0].state;
    }

    async function factsOf(
      principalId: string,
    ): Promise<Array<{ fact_key: string; value: { matchId?: string } }>> {
      const rows = await databasePool.query<{
        fact_key: string;
        value: { matchId?: string };
      }>(
        `SELECT f.fact_key, f.value
           FROM next_round.module_facts f
           JOIN next_round.resource_identities ri ON ri.id = f.identity_id
          WHERE ri.module_id = 'crossword' AND f.principal_id = $1
          ORDER BY f.fact_key`,
        [principalId],
      );
      return rows.rows;
    }

    async function createMatch(
      session: SessionFixture,
      input: {
        mode: string;
        settings: Record<string, unknown>;
        visibility?: "instance" | "invite";
      },
    ): Promise<string> {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/matches",
        headers: headers(session, true),
        payload: {
          commandId: randomUUID(),
          moduleId: "crossword",
          mode: input.mode,
          settings: input.settings,
          resourceId,
          visibility: input.visibility ?? "instance",
        },
      });
      expect(created.statusCode).toBe(201);
      return parseRequestBody(
        ApiResponseSchema(CreateMatchResponseSchema),
        JSON.parse(created.body),
      ).data.matchId;
    }

    async function join(
      session: SessionFixture,
      matchId: string,
    ): Promise<number> {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/join`,
        headers: headers(session, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: await revisionOf(matchId),
        },
      });
      expect(response.statusCode).toBe(200);
      return response.statusCode;
    }

    async function start(
      session: SessionFixture,
      matchId: string,
    ): Promise<{ status: number; body: string }> {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/start`,
        headers: headers(session, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: await revisionOf(matchId),
        },
      });
      return { status: response.statusCode, body: response.body };
    }

    async function startOk(
      session: SessionFixture,
      matchId: string,
    ): Promise<void> {
      const response = await start(session, matchId);
      expect(response.status).toBe(200);
    }

    async function act(
      session: SessionFixture,
      matchId: string,
      type: string,
      payload: Record<string, unknown> = {},
    ): Promise<{ status: number; body: string }> {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/actions`,
        headers: headers(session, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: await revisionOf(matchId),
          type,
          payload,
        },
      });
      return { status: response.statusCode, body: response.body };
    }

    async function actOk(
      session: SessionFixture,
      matchId: string,
      type: string,
      payload: Record<string, unknown> = {},
    ): Promise<void> {
      const response = await act(session, matchId, type, payload);
      expect(response.status).toBe(200);
    }

    async function snapshot(
      session: SessionFixture,
      matchId: string,
    ): Promise<{ status: number; body: string; data: SnapshotShape }> {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/matches/${matchId}`,
        headers: headers(session),
      });
      return {
        status: response.statusCode,
        body: response.body,
        data: JSON.parse(response.body).data as SnapshotShape,
      };
    }

    async function resultOf(
      session: SessionFixture,
      matchId: string,
    ): Promise<{ outcome: string; participants: ResultParticipant[] }> {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/matches/${matchId}/result`,
        headers: headers(session),
      });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body).data;
    }

    it("publishes no clues, board or numbers before start, to any viewer", async () => {
      const matchId = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, matchId);

      for (const viewer of [host, p2]) {
        const lobby = await snapshot(viewer, matchId);
        expect(lobby.status).toBe(200);
        expect(lobby.data.game.clues).toBeNull();
        expect(lobby.data.game.board).toBeNull();
        expect(lobby.data.game.numbers).toBeNull();
        // Neither a solution row nor a clue text leaks in the lobby.
        expect(lobby.body).not.toContain("ABCDE");
        expect(lobby.body).not.toContain("First across");
        // Title and grid size are public metadata and stay visible.
        expect(lobby.body).toContain("Acceptance Grid");
      }

      // An outsider cannot fetch the lobby snapshot at all.
      const outsider = await snapshot(p3, matchId);
      expect([403, 404]).toContain(outsider.status);
      expect(outsider.body).not.toContain("First across");

      // Lobby preview alone records no played exposure for anyone.
      expect(await factsOf(host.principalId)).toEqual([]);
      expect(await factsOf(p2.principalId)).toEqual([]);
    });

    it("keeps wrong-guess feedback visible only to the guessing player", async () => {
      const matchId = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, matchId);
      await startOk(host, matchId);

      const wrong = await act(host, matchId, "submit_word", {
        wordId: "1A",
        answer: "XXXXX",
      });
      expect(wrong.status).toBe(200);

      const hostView = await snapshot(host, matchId);
      expect(hostView.data.game.privateFeedback?.lastWrongGuess).toBe("XXXXX");

      const peerView = await snapshot(p2, matchId);
      expect(peerView.data.game.privateFeedback?.lastWrongGuess ?? null).toBe(
        null,
      );
      // The peer's snapshot carries neither the guess nor its text anywhere.
      expect(peerView.body).not.toContain("XXXXX");
    });

    it("always exposes the importer, at start and at late join", async () => {
      // The admin imported the puzzle in beforeEach and has never played.
      expect((await factsOf(admin.principalId)).map((f) => f.fact_key)).toEqual(
        ["crossword/imported"],
      );

      const started = await createMatch(admin, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, started);
      await startOk(admin, started);
      expect((await stateOf(started)).exclusionReasons).toContain(
        "importer_exposure",
      );

      // Late join: an eligible match that the importer joins mid-game
      // latches the same match-wide exclusion.
      const active = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p3, active);
      await startOk(host, active);
      expect((await stateOf(active)).exclusionReasons).toEqual([]);
      await join(admin, active);
      expect((await stateOf(active)).exclusionReasons).toContain(
        "importer_exposure",
      );
    });

    it("latches prior exposure in the second of two overlapping matches; a rolled-back start records nothing", async () => {
      const first = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, first);
      const second = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, second);

      await startOk(host, first);
      expect((await stateOf(first)).exclusionReasons).toEqual([]);
      await startOk(host, second);
      expect((await stateOf(second)).exclusionReasons).toContain(
        "prior_exposure",
      );

      // Control: a disjoint, unexposed pair on the same puzzle stays eligible.
      const control = await createMatch(p3, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p4, control);
      await startOk(p3, control);
      expect((await stateOf(control)).exclusionReasons).toEqual([]);

      // A start that fails (too few players) rolls back: no exposure fact
      // for that match, no exclusion, still in the lobby.
      const short = await createMatch(p5, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      const failed = await start(p5, short);
      expect(failed.status).not.toBe(200);
      expect(await factsOf(p5.principalId)).toEqual([]);
      expect((await stateOf(short)).exclusionReasons).toEqual([]);
      const lobby = await snapshot(p5, short);
      expect(lobby.data.phase).toBe("lobby");
    });

    it("serializes simultaneous starts of overlapping matches: exactly one latches prior exposure", async () => {
      const a = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, a);
      const b = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, b);

      const [startA, startB] = await Promise.all([
        start(host, a),
        start(host, b),
      ]);
      expect(startA.status).toBe(200);
      expect(startB.status).toBe(200);

      const stateA = await stateOf(a);
      const stateB = await stateOf(b);
      const latched = [stateA, stateB].filter((state) =>
        state.exclusionReasons.includes("prior_exposure"),
      );
      expect(latched).toHaveLength(1);
      const clean = stateA.exclusionReasons.includes("prior_exposure")
        ? stateB
        : stateA;
      expect(clean.exclusionReasons).toEqual([]);
    });

    it("makes exclusion match-wide and permanent when an exposed player late-joins; an unexposed late join invents nothing", async () => {
      // p2 becomes exposed by starting a solo game on the same puzzle.
      const solo = await createMatch(p2, {
        mode: "solo",
        settings: SOLO_SETTINGS,
      });
      await startOk(p2, solo);
      expect((await factsOf(p2.principalId)).map((f) => f.fact_key)).toEqual([
        "crossword/seen",
      ]);

      const matchId = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p3, matchId);
      await startOk(host, matchId);
      expect((await stateOf(matchId)).exclusionReasons).toEqual([]);

      // The host banks a point before the exposed player arrives.
      await actOk(host, matchId, "submit_word", {
        wordId: "1A",
        answer: "ABCDE",
      });
      const hostMember = await memberIdOf(matchId, host.principalId);
      expect((await stateOf(matchId)).scores[hostMember]).toBe(1);

      await join(p2, matchId);
      const afterJoin = await stateOf(matchId);
      expect(afterJoin.exclusionReasons).toContain("prior_exposure");
      // Per-match points already earned stay intact.
      expect(afterJoin.scores[hostMember]).toBe(1);

      const finished = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/finish`,
        headers: headers(host, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: await revisionOf(matchId),
        },
      });
      expect(finished.statusCode).toBe(200);
      const result = await resultOf(host, matchId);
      // Finalization creates no eligible career contributions for anyone.
      expect(result.participants.length).toBeGreaterThan(0);
      expect(
        result.participants.every((participant) => !participant.careerEligible),
      ).toBe(true);

      // Control: an unexposed late join keeps the match eligible, and the
      // join records only this match's own exposure for the joiner.
      const control = await createMatch(p4, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p5, control);
      await startOk(p4, control);
      await join(p6, control);
      expect((await stateOf(control)).exclusionReasons).toEqual([]);
      const p6Facts = await factsOf(p6.principalId);
      expect(p6Facts).toHaveLength(1);
      expect(p6Facts[0].fact_key).toBe("crossword/seen");
      expect(p6Facts[0].value.matchId).toBe(control);
    });

    it("latches a lobby declaration before start and never erases it on leave/rejoin", async () => {
      const matchId = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, matchId);
      // Lobby preview alone recorded nothing.
      expect(await factsOf(host.principalId)).toEqual([]);

      await actOk(host, matchId, "declare_exposure");
      expect((await stateOf(matchId)).exclusionReasons).toContain(
        "declared_exposure",
      );
      const declared = await factsOf(host.principalId);
      expect(declared.map((f) => f.fact_key)).toEqual(["crossword/declared"]);
      expect(declared[0].value.matchId).toBe(matchId);

      const left = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/leave`,
        headers: headers(host, true),
        payload: {
          commandId: randomUUID(),
          expectedRevision: await revisionOf(matchId),
        },
      });
      expect(left.statusCode).toBe(200);
      await join(host, matchId);
      expect((await stateOf(matchId)).exclusionReasons).toContain(
        "declared_exposure",
      );

      // The host's explicit departure transferred permanent host authority
      // to p2 (C4), so p2 starts; the latched exclusion survives the start.
      await startOk(p2, matchId);
      expect((await stateOf(matchId)).exclusionReasons).toContain(
        "declared_exposure",
      );
    });

    it("pins cross-match declaration semantics: a declaration in another match does not exclude this one", async () => {
      // The host declares prior knowledge in match A's lobby and never
      // starts A. Only a crossword/declared fact exists afterwards.
      const a = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, a);
      await actOk(host, a, "declare_exposure");
      expect((await factsOf(host.principalId)).map((f) => f.fact_key)).toEqual([
        "crossword/declared",
      ]);

      // Starting a different match on the same puzzle does NOT latch any
      // exclusion for the declarant: the start check consults the imported
      // and seen facts only (see the pinned semantics note at the top).
      const b = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p3, b);
      await startOk(host, b);
      expect((await stateOf(b)).exclusionReasons).toEqual([]);

      // Actually playing A afterwards records seen, and only then does a
      // third match latch prior exposure for the host.
      await startOk(host, a);
      const c = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p4, c);
      await startOk(host, c);
      expect((await stateOf(c)).exclusionReasons).toContain("prior_exposure");
    });

    it("clears the timeout-removal flag when the flagged player resumes with an accepted wrong guess (BL-032, end to end)", async () => {
      const matchId = await createMatch(host, {
        mode: "custom",
        settings: CUSTOM_TIMER_SETTINGS,
      });
      await join(p2, matchId);
      await startOk(host, matchId);
      const hostMember = await memberIdOf(matchId, host.principalId);
      const p2Member = await memberIdOf(matchId, p2.principalId);
      expect((await stateOf(matchId)).currentMemberId).toBe(hostMember);

      await databasePool.query(
        `UPDATE next_round.match_deadlines
            SET due_at = now() - interval '1 second'
          WHERE match_id = $1 AND key = 'turn' AND generation = 1`,
        [matchId],
      );
      const matchService = new MatchService(databasePool, registry);
      const applied = await matchService.processDeadline({
        matchId,
        key: "turn",
        generation: 1,
      });
      expect(applied).toBe(1);
      const timedOut = await stateOf(matchId);
      expect(timedOut.timeoutRemovalEligible).toEqual([hostMember]);
      expect(timedOut.currentMemberId).toBe(p2Member);

      // Rotation returns to the flagged host, who resumes playing with an
      // accepted wrong guess. Per C4 the flag must clear.
      await actOk(p2, matchId, "pass");
      expect((await stateOf(matchId)).currentMemberId).toBe(hostMember);
      const wrong = await act(host, matchId, "submit_word", {
        wordId: "1A",
        answer: "XXXXX",
      });
      expect(wrong.status).toBe(200);
      const resumed = await stateOf(matchId);
      expect(resumed.turn?.wrong).toBe(1);
      expect(resumed.timeoutRemovalEligible).toEqual([]);
    });

    it("preserves registered players' career eligibility when a guest plays", async () => {
      const matchId = await createMatch(host, {
        mode: "quick",
        settings: QUICK_SETTINGS,
      });
      await join(p2, matchId);

      const invite = await app.inject({
        method: "POST",
        url: `/api/v1/matches/${matchId}/guest-invitations`,
        headers: headers(host, true),
        payload: { commandId: randomUUID() },
      });
      expect(invite.statusCode).toBe(201);
      const inviteUrl = JSON.parse(invite.body).data.url as string;
      const token = inviteUrl.split("#")[1];
      expect(token).toBeTruthy();

      const redeemed = await app.inject({
        method: "POST",
        url: "/api/v1/guest-invitations/redeem",
        headers: { origin, "content-type": "application/json" },
        payload: {
          token,
          displayName: "Guest One",
          commandId: randomUUID(),
        },
      });
      expect(redeemed.statusCode).toBe(200);
      const guestData = JSON.parse(redeemed.body).data as {
        principal: { id: string };
        csrfToken?: string;
      };
      const guestCookie = redeemed.cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const guest: SessionFixture = {
        principalId: guestData.principal.id,
        cookie: guestCookie,
        csrf: guestData.csrfToken ?? "",
      };

      const guestLobby = await snapshot(guest, matchId);
      expect(guestLobby.status).toBe(200);
      expect(guestLobby.data.game.clues).toBeNull();

      await startOk(host, matchId);
      expect((await stateOf(matchId)).exclusionReasons).toEqual([]);

      // Play the grid out: whoever holds the turn submits the next across
      // word; each correct word ends the turn under quick rules.
      const sessionsByPrincipal = new Map<string, SessionFixture>([
        [host.principalId, host],
        [p2.principalId, p2],
        [guest.principalId, guest],
      ]);
      const memberToPrincipal = new Map<string, string>();
      for (const principalId of sessionsByPrincipal.keys()) {
        memberToPrincipal.set(
          await memberIdOf(matchId, principalId),
          principalId,
        );
      }
      for (const [wordId, answer] of Object.entries(ACROSS_ANSWERS)) {
        const current = (await stateOf(matchId)).currentMemberId;
        expect(current).not.toBeNull();
        const principalId = memberToPrincipal.get(current!);
        const actor = sessionsByPrincipal.get(principalId!);
        expect(actor).toBeDefined();
        await actOk(actor!, matchId, "submit_word", { wordId, answer });
      }

      const result = await resultOf(host, matchId);
      expect(result.outcome).toBe("solved");
      const guestMember = await memberIdOf(matchId, guest.principalId);
      const byMember = new Map(
        result.participants.map((participant) => [
          participant.memberId,
          participant,
        ]),
      );
      // The guest is attributed but never career-eligible...
      expect(byMember.get(guestMember)?.careerEligible).toBe(false);
      expect(byMember.get(guestMember)?.exclusionReasons).toContain(
        "guest_player",
      );
      // ...and the guest's presence alone does not suppress the registered
      // players' eligibility.
      for (const registered of [host, p2]) {
        const member = await memberIdOf(matchId, registered.principalId);
        expect(byMember.get(member)?.careerEligible).toBe(true);
      }
    });
  },
);
