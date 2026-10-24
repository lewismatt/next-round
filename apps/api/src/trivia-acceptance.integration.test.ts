// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Deadline, Member } from "@next-round/contracts";
import { createDatabasePool, type DatabasePool } from "@next-round/db";
import { migrateDatabase } from "@next-round/db/migrate";
import { manifest } from "@next-round/game-trivia/manifest";
import { server } from "@next-round/game-trivia/server";
import {
  GameRegistry,
  MatchService,
  installGameVersion,
} from "@next-round/platform";
import {
  generateCsrfToken,
  generateOpaqueSessionToken,
  SESSION_DEV_COOKIE_NAME,
} from "@next-round/platform/auth";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.npm_lifecycle_event === "test:integration")
  throw new Error("TEST_DATABASE_URL is required");
const origin = "http://localhost:3000";
const document = {
  format: "next-round.trivia/1",
  title: "Transaction fixture",
  attribution: "Original fixture",
  license: "CC0-1.0",
  questions: [
    {
      id: "one",
      prompt: "First public prompt",
      choices: ["Wrong", "Right"],
      correctChoice: 1,
      explanation: "First hidden explanation",
    },
    {
      id: "two",
      prompt: "Second private prompt",
      choices: ["Right", "Wrong"],
      correctChoice: 0,
      explanation: "Second hidden explanation",
    },
  ],
};
type Session = { principalId: string; cookie: string; csrf: string };
type Snapshot = {
  revision: number;
  phase: string;
  members: Member[];
  deadlines: Deadline[];
  game: {
    roundIndex: number;
    myChoice: number | null;
    canSubmit: boolean;
    scores: Record<string, number>;
    suspended: boolean;
    reveals: Array<{
      answers: Record<string, number>;
      correctChoice: number;
      explanation: string;
    }>;
  };
};

function headers(session: Session) {
  return {
    cookie: session.cookie,
    origin,
    "content-type": "application/json",
    "x-csrf-token": session.csrf,
  };
}

describe.skipIf(!databaseUrl)("trivia real-PostgreSQL acceptance", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: FastifyInstance;
  let name: string;
  let staticRoot: string;
  let registry: GameRegistry;
  let resourceId: string;
  let admin: Session;
  let host: Session;
  let peer: Session;
  let late: Session;

  async function seed(label: string, role = "member"): Promise<Session> {
    const principalId = randomUUID();
    const session = generateOpaqueSessionToken();
    const csrf = generateCsrfToken();
    await pool.query(
      "INSERT INTO next_round.principals(id,kind,display_name) VALUES($1,'registered',$2)",
      [principalId, label],
    );
    await pool.query(
      "INSERT INTO next_round.accounts(principal_id,username,password_hash,role) VALUES($1,$2,'unused',$3)",
      [principalId, `trivia_${label.toLowerCase()}`, role],
    );
    await pool.query(
      "INSERT INTO next_round.sessions(id,principal_id,token_hash,csrf_hash,auth_epoch,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,0,now()+interval '1 day',now()+interval '1 day')",
      [randomUUID(), principalId, session.tokenHash, csrf.csrfHash],
    );
    return {
      principalId,
      cookie: `${SESSION_DEV_COOKIE_NAME}=${session.rawToken}`,
      csrf: csrf.rawToken,
    };
  }
  beforeEach(async () => {
    name = `trivia_${randomUUID().replaceAll("-", "")}`;
    adminPool = createDatabasePool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    await migrateDatabase({ connectionString: url.href });
    pool = createDatabasePool({ connectionString: url.href, max: 8 });
    staticRoot = await mkdtemp(path.join(tmpdir(), "trivia-api-"));
    await writeFile(
      path.join(staticRoot, "client.js"),
      "export const client = {};\n",
    );
    registry = new GameRegistry();
    registry.register(manifest, server, {
      clientRoot: staticRoot,
      isDefault: true,
    });
    app = await buildServer({
      logger: false,
      cookieSecret: randomBytes(32).toString("hex"),
      setupToken: randomBytes(32).toString("hex"),
      origin,
      databasePool: pool,
      staticRoot,
      gameRegistry: registry,
    });
    admin = await seed("Admin", "admin");
    host = await seed("Host");
    peer = await seed("Peer");
    late = await seed("Late");
    const policy = {
      schemaVersion: 1,
      historyVisibility: "participants",
      statsVisibility: "instance",
      rejoinChat: "full",
      retention: {
        chatDaysAfterFinish: null,
        privateStateDaysAfterFinish: null,
        resultDaysAfterFinish: null,
        notificationDays: null,
      },
    };
    await pool.query(
      "INSERT INTO next_round.instance_policy(version,instance_name,policy,changed_by) VALUES(1,'Trivia',$1::jsonb,$2)",
      [JSON.stringify(policy), admin.principalId],
    );
    await pool.query(
      "INSERT INTO next_round.instance_singleton(id,current_policy_version) VALUES(true,1)",
    );
    await installGameVersion(pool, manifest, {
      serverHash: "fixture",
      clientHash: "fixture",
    });
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/admin/games/trivia/import",
      headers: headers(admin),
      payload: { commandId: randomUUID(), document },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    resourceId = imported.json().data.resourceId;
  }, 120000);
  afterEach(async () => {
    await app?.close();
    const closed: Promise<void>[] = [];
    pool?.on("remove", (client) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      client.once("end", resolve);
      closed.push(promise);
    });
    await pool?.end();
    await Promise.all(closed);
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await adminPool.end();
    }
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  }, 60000);

  async function snapshot(id: string, session = host): Promise<Snapshot> {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/matches/${id}`,
      headers: headers(session),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data;
  }
  async function command(
    id: string,
    route: string,
    session: Session,
    expectedRevision: number,
    extra = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/matches/${id}/${route}`,
      headers: headers(session),
      payload: { commandId: randomUUID(), expectedRevision, ...extra },
    });
  }
  async function create(rounds = 2) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/matches",
      headers: headers(host),
      payload: {
        commandId: randomUUID(),
        moduleId: "trivia",
        mode: "group",
        settings: { rounds, secondsPerRound: 300 },
        resourceId,
        visibility: "instance",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().data.matchId as string;
    const join = await command(id, "join", peer, (await snapshot(id)).revision);
    expect(join.statusCode, join.body).toBe(200);
    const start = await command(
      id,
      "start",
      host,
      (await snapshot(id)).revision,
    );
    expect(start.statusCode, start.body).toBe(200);
    return id;
  }
  async function expire(id: string) {
    const pending = await pool.query<{ key: string; generation: number }>(
      "UPDATE next_round.match_deadlines SET due_at=clock_timestamp()-interval '1 second' WHERE match_id=$1 AND status='pending' RETURNING key,generation",
      [id],
    );
    expect(pending.rowCount).toBe(1);
    return pending.rows[0];
  }
  async function closeRound(id: string) {
    const d = await expire(id);
    expect(
      await new MatchService(pool, registry).processDeadline({
        matchId: id,
        ...d,
      }),
    ).toBe(1);
  }
  async function disable(session: Session, disabled: boolean) {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${session.principalId}`,
      headers: headers(admin),
      payload: { disabled },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  it("serializes two simultaneous answers, requires explicit retry, and replays receipts without replacement", async () => {
    const id = await create();
    const before = await snapshot(id);
    const hostId = before.members.find(
      (m) => m.principalId === host.principalId,
    )!.id;
    const peerId = before.members.find(
      (m) => m.principalId === peer.principalId,
    )!.id;
    const hostCommand = randomUUID();
    const peerCommand = randomUUID();
    const submit = (
      session: Session,
      commandId: string,
      expectedRevision: number,
      choice = 1,
    ) =>
      command(id, "actions", session, expectedRevision, {
        commandId,
        type: "submit",
        payload: { roundIndex: 0, choice },
      });
    const responses = await Promise.all([
      submit(host, hostCommand, before.revision),
      submit(peer, peerCommand, before.revision),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = responses[0].statusCode === 200 ? host : peer;
    const loser = winner === host ? peer : host;
    const winningId = winner === host ? hostCommand : peerCommand;
    expect(responses.find((r) => r.statusCode === 409)!.json().error.code).toBe(
      "STALE_REVISION",
    );
    const latest = await snapshot(id);
    expect(latest.revision).toBe(before.revision + 1);
    expect(latest.deadlines).toEqual(before.deadlines);
    expect((await submit(winner, winningId, before.revision)).statusCode).toBe(
      200,
    );
    expect((await snapshot(id)).revision).toBe(latest.revision);
    const retry = await submit(loser, randomUUID(), latest.revision, 0);
    expect(retry.statusCode, retry.body).toBe(200);
    const hostView = await snapshot(id);
    const peerView = await snapshot(id, peer);
    expect(hostView.game.myChoice).toBe(winner === host ? 1 : 0);
    expect(peerView.game.myChoice).toBe(winner === peer ? 1 : 0);
    expect(JSON.stringify(hostView.game)).not.toMatch(
      /correctChoice|answers|hidden explanation|Second private prompt/,
    );
    expect(hostView.deadlines).toEqual(before.deadlines);
    expect(
      (await submit(winner, randomUUID(), hostView.revision, 0)).statusCode,
    ).toBe(422);
    await closeRound(id);
    const revealed = await snapshot(id);
    expect(revealed.game.reveals[0]).toMatchObject({
      correctChoice: 1,
      explanation: "First hidden explanation",
      answers: {
        [hostId]: winner === host ? 1 : 0,
        [peerId]: winner === peer ? 1 : 0,
      },
    });
    expect(revealed.game.scores).toEqual({
      [hostId]: winner === host ? 1 : 0,
      [peerId]: winner === peer ? 1 : 0,
    });
  });

  it("reconciles a due deadline before a submission and fences delayed old-round intent", async () => {
    const id = await create();
    const before = await snapshot(id);
    await expire(id);
    const lateResponse = await command(id, "actions", host, before.revision, {
      type: "submit",
      payload: { roundIndex: 0, choice: 1 },
    });
    expect(lateResponse.statusCode, lateResponse.body).toBe(409);
    expect(lateResponse.json().error.code).toBe("STALE_REVISION");
    const after = await snapshot(id);
    expect(after.game.roundIndex).toBe(1);
    expect(after.game.reveals[0].answers).toEqual({});
    expect(after.revision).toBe(before.revision + 1);
    const delayed = await command(id, "actions", host, after.revision, {
      type: "submit",
      payload: { roundIndex: 0, choice: 1 },
    });
    expect(delayed.statusCode).toBe(422);
    expect((await snapshot(id)).game.myChoice).toBeNull();
    const consumed = await pool.query(
      "SELECT status FROM next_round.match_deadlines WHERE match_id=$1 AND generation=1",
      [id],
    );
    expect(consumed.rows[0].status).toBe("consumed");
  });

  it("preserves membership progress through late join, leave/rejoin and all-disabled suspension", async () => {
    const id = await create();
    const first = await snapshot(id);
    expect(
      (
        await command(id, "actions", host, first.revision, {
          type: "submit",
          payload: { roundIndex: 0, choice: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await command(id, "join", late, (await snapshot(id)).revision))
        .statusCode,
    ).toBe(200);
    expect((await snapshot(id, late)).game.canSubmit).toBe(false);
    expect(
      (await command(id, "leave", peer, (await snapshot(id)).revision))
        .statusCode,
    ).toBe(200);
    expect(
      (await command(id, "join", peer, (await snapshot(id)).revision))
        .statusCode,
    ).toBe(200);
    expect((await snapshot(id, peer)).game.canSubmit).toBe(false);
    await disable(host, true);
    await disable(peer, true);
    await disable(late, true);
    const paused = await pool.query<{
      state: {
        suspended: boolean;
        answers: Record<string, number>;
        suspendedRemainingMs: number;
      };
      revision: number;
    }>("SELECT state,revision FROM next_round.matches WHERE id=$1", [id]);
    expect(paused.rows[0].state.suspended).toBe(true);
    expect(Object.values(paused.rows[0].state.answers)).toEqual([1]);
    expect(paused.rows[0].state.suspendedRemainingMs).toBeGreaterThan(0);
    expect(
      (
        await pool.query(
          "SELECT * FROM next_round.match_deadlines WHERE match_id=$1 AND status='pending'",
          [id],
        )
      ).rows,
    ).toEqual([]);
    await disable(late, false);
    const resumed = await pool.query<{
      state: { suspended: boolean; answers: Record<string, number> };
    }>("SELECT state FROM next_round.matches WHERE id=$1", [id]);
    expect(resumed.rows[0].state).toMatchObject({
      suspended: false,
      answers: paused.rows[0].state.answers,
    });
    await closeRound(id);
    const current = await pool.query<{
      state: { roundMemberIds: string[]; scores: Record<string, number> };
    }>("SELECT state FROM next_round.matches WHERE id=$1", [id]);
    const member = await pool.query<{ id: string }>(
      "SELECT id FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
      [id, late.principalId],
    );
    expect(current.rows[0].state.roundMemberIds).toEqual([member.rows[0].id]);
    expect(
      Object.values(current.rows[0].state.scores).reduce((a, b) => a + b, 0),
    ).toBe(1);
  });

  it("keeps final results and career points usable after real private-state pruning", async () => {
    const id = await create(1);
    const s = await snapshot(id);
    const hostId = s.members.find(
      (m) => m.principalId === host.principalId,
    )!.id;
    const peerId = s.members.find(
      (m) => m.principalId === peer.principalId,
    )!.id;
    expect(
      (
        await command(id, "actions", host, s.revision, {
          type: "submit",
          payload: { roundIndex: 0, choice: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await command(id, "actions", peer, (await snapshot(id)).revision, {
          type: "submit",
          payload: { roundIndex: 0, choice: 0 },
        })
      ).statusCode,
    ).toBe(200);
    await closeRound(id);
    const getResult = () =>
      app.inject({
        method: "GET",
        url: `/api/v1/matches/${id}/result`,
        headers: headers(host),
      });
    const before = await getResult();
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().data).toMatchObject({
      outcome: "completed",
      data: { winners: [hostId], roundsPlayed: 1 },
    });
    const career = await pool.query(
      "SELECT principal_id,points::integer,played::integer,wins::integer FROM next_round.career_contributions WHERE match_id=$1 ORDER BY points DESC",
      [id],
    );
    expect(career.rows).toEqual([
      { principal_id: host.principalId, points: 1, played: 1, wins: 1 },
      { principal_id: peer.principalId, points: 0, played: 1, wins: 0 },
    ]);
    await pool.query(
      "UPDATE next_round.matches SET state=NULL,resource_snapshot=NULL,state_pruned_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    const after = await getResult();
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().data).toEqual(before.json().data);
    expect(JSON.stringify(after.json().data)).not.toMatch(
      /hidden explanation|correctChoice|answers|prompt/,
    );
    const results = await pool.query(
      "SELECT member_id,score FROM next_round.participant_results WHERE match_id=$1 ORDER BY score DESC",
      [id],
    );
    expect(results.rows).toEqual([
      { member_id: hostId, score: 1 },
      { member_id: peerId, score: 0 },
    ]);
  });
});
