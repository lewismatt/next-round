// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  HarnessCommandError,
  HarnessHttpError,
} from "../packages/game-harness/dist/index.js";

export async function runGameAcceptance(fixture, cli) {
  const { pool } = fixture;
  const cases = [];
  const run = async (name, predicates, action) => {
    const started = performance.now();
    await action();
    cases.push({
      name,
      predicates,
      status: "pass",
      elapsedMs: +(performance.now() - started).toFixed(3),
    });
  };
  const execute = (input) => cli.execute(input);
  const snapshot = (name, matchId) =>
    execute({ op: "snapshot", name, matchId });
  const add = async (name, matchId, extra = {}) =>
    execute({
      op: "act",
      name,
      matchId,
      type: "add",
      payload: { amount: 1 },
      expectedRevision: (await snapshot(name, matchId)).revision,
      ...extra,
    });
  const currentName = (view) => {
    const principal = view.members.find(
      (member) => member.id === view.game.currentActorMemberId,
    )?.principalId;
    const entry = [...cli.clients].find(
      ([, client]) => client.session.principalId === principal,
    );
    assert.ok(
      entry,
      "Current actor must have an explicitly named real CLI client",
    );
    return entry[0];
  };
  const deadline = async (matchId) =>
    (
      await pool.query(
        "SELECT key,generation,due_at,event_id,created_at FROM next_round.match_deadlines WHERE match_id=$1 AND status='pending'",
        [matchId],
      )
    ).rows;
  const obligation = async (matchId, eventId) => ({
    schedules: (
      await pool.query(
        "SELECT id,dedupe_key FROM next_round.outbox WHERE aggregate_id=$1 AND topic='deadline.schedule' AND safe_payload->>'eventId'=$2 ORDER BY id",
        [matchId, eventId],
      )
    ).rows,
    notifications: (
      await pool.query(
        "SELECT id,principal_id,dedupe_key,created_at FROM next_round.notifications WHERE match_id=$1 AND kind='action_required' AND safe_payload->>'eventId'=$2 ORDER BY id",
        [matchId, eventId],
      )
    ).rows,
  });

  await run(
    "F2 CLI: real registered clients and solo mode",
    [
      "CLI creates and authenticates three independently named sessions",
      "solo starts with one member",
      "unknown setting/action fields rejected by real schema boundary",
      "solo visibility forced private",
    ],
    async () => {
      for (const name of ["s4_host", "s4_peer", "s4_outsider"])
        await execute({ op: "registered", name });
      const host = cli.clients.get("s4_host");
      await assert.rejects(
        () =>
          execute({
            op: "create",
            name: "s4_host",
            mode: "solo",
            settings: { target: 1, turnSeconds: null, unknown: true },
          }),
        (error) => error instanceof HarnessHttpError && error.status === 400,
      );
      const solo = await execute({
        op: "create",
        name: "s4_host",
        mode: "solo",
        settings: { target: 1, turnSeconds: null },
        visibility: "instance",
      });
      cli.soloMatchId = solo.matchId;
      const lobby = await snapshot("s4_host", solo.matchId);
      assert.equal(lobby.members.length, 1);
      assert.equal(lobby.capabilities.canStart, true);
      await execute({
        op: "start",
        name: "s4_host",
        matchId: solo.matchId,
        expectedRevision: lobby.revision,
      });
      const active = await snapshot("s4_host", solo.matchId);
      assert.equal(active.phase, "active");
      assert.deepEqual(active.deadlines, []);
      assert.equal(
        (
          await pool.query(
            "SELECT visibility FROM next_round.matches WHERE id=$1",
            [solo.matchId],
          )
        ).rows[0].visibility,
        "private",
      );
      await assert.rejects(
        () =>
          execute({
            op: "act",
            name: "s4_host",
            matchId: solo.matchId,
            type: "add",
            payload: { amount: 1, unknown: true },
            expectedRevision: active.revision,
          }),
        (error) => error instanceof HarnessHttpError && error.status === 400,
      );
      assert.equal(
        (await snapshot("s4_host", solo.matchId)).revision,
        active.revision,
      );
      assert.equal(host.session.kind, "registered");
    },
  );

  await run(
    "F1-04/F2 CLI: post-commit score response loss and exact replay",
    [
      "fault discards a real successful score response, not the server transition",
      "identical explicit replay has one revision/point/receipt/result",
      "same key with different body is 409",
      "solo participant result is excluded from multiplayer career totals",
    ],
    async () => {
      const matchId = cli.soloMatchId;
      const before = await snapshot("s4_host", matchId);
      await execute({ op: "post-commit-fault", matchId });
      const commandId = randomUUID();
      await assert.rejects(
        () =>
          execute({
            op: "act",
            name: "s4_host",
            matchId,
            type: "add",
            payload: { amount: 1 },
            expectedRevision: before.revision,
            commandId,
            intent: "solo-score",
          }),
        (error) =>
          error instanceof HarnessCommandError &&
          error.commandId === commandId &&
          error.reason === "response_loss",
      );
      const after = await snapshot("s4_host", matchId);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.phase, "finished");
      const replay = await execute({ op: "replay", intent: "solo-score" });
      assert.equal(replay.replayed, true);
      assert.equal(replay.committedRevision, after.revision);
      await assert.rejects(
        () =>
          execute({
            op: "act",
            name: "s4_host",
            matchId,
            type: "note",
            payload: { text: "changed" },
            expectedRevision: before.revision,
            commandId,
          }),
        (error) =>
          error instanceof HarnessHttpError &&
          error.status === 409 &&
          error.code === "IDEMPOTENCY_CONFLICT",
      );
      const result = await execute({ op: "result", name: "s4_host", matchId });
      assert.equal(result.outcome, "completed");
      assert.equal(result.data.count, 1);
      assert.equal(result.participants[0].score, 1);
      assert.equal(result.participants[0].careerEligible, false);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.command_receipts WHERE match_id=$1 AND command_id=$2",
            [matchId, commandId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.match_results WHERE match_id=$1",
            [matchId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.career_contributions WHERE match_id=$1",
            [matchId],
          )
        ).rows[0].n,
        0,
      );
    },
  );

  let groupId;
  let retained;
  let retainedObligation;
  await run(
    "F2 CLI: group privacy, guest admission and retained obligation",
    [
      "group uses real registered and guest clients",
      "each private note/marker is viewer-specific",
      "notes at later database time retain deadline/scheduling/notification identity",
      "late join and rejoin do not extend that obligation",
    ],
    async () => {
      ({ matchId: groupId } = await execute({
        op: "create",
        name: "s4_host",
        settings: { target: 4, turnSeconds: 60 },
      }));
      const joined = await execute({
        op: "join",
        name: "s4_peer",
        matchId: groupId,
        expectedRevision: 0,
      });
      await execute({
        op: "start",
        name: "s4_host",
        matchId: groupId,
        expectedRevision: joined.committedRevision,
      });
      await execute({
        op: "guest",
        name: "guest",
        issuer: "s4_host",
        matchId: groupId,
        displayName: "Counter guest",
      });
      retained = (await deadline(groupId))[0];
      assert.ok(retained);
      retainedObligation = await obligation(groupId, retained.event_id);
      assert.equal(retainedObligation.schedules.length, 1);
      assert.equal(retainedObligation.notifications.length, 1);
      const hostBefore = await snapshot("s4_host", groupId);
      const peerBefore = await snapshot("s4_peer", groupId);
      assert.ok(
        Date.parse(hostBefore.serverNow) >
          new Date(retained.created_at).getTime(),
        "Later server read must not invent later dueAt",
      );
      const actorBefore = hostBefore.game.currentActorMemberId;
      const scoreBefore = hostBefore.game.scores;
      await execute({
        op: "act",
        name: "s4_host",
        matchId: groupId,
        type: "note",
        payload: { text: "private host note" },
        expectedRevision: hostBefore.revision,
      });
      const peerCurrent = await snapshot("s4_peer", groupId);
      await execute({
        op: "act",
        name: "s4_peer",
        matchId: groupId,
        type: "note",
        payload: { text: "private peer note" },
        expectedRevision: peerCurrent.revision,
      });
      const hostAfter = await snapshot("s4_host", groupId);
      const peerAfter = await snapshot("s4_peer", groupId);
      assert.equal(
        typeof hostAfter.game.myMarker,
        "string",
        "Creator must receive its own private fixture marker",
      );
      assert.equal(
        typeof peerAfter.game.myMarker,
        "string",
        "Joined member must receive its own private fixture marker",
      );
      assert.equal(hostAfter.game.myNote, "private host note");
      assert.equal(peerAfter.game.myNote, "private peer note");
      assert.notEqual(hostAfter.game.myMarker, peerAfter.game.myMarker);
      assert.equal(hostAfter.game.currentActorMemberId, actorBefore);
      assert.deepEqual(hostAfter.game.scores, scoreBefore);
      assert.equal(hostAfter.game.count, 0);
      assert.ok(!JSON.stringify(hostAfter).includes("private peer note"));
      assert.ok(!JSON.stringify(hostAfter).includes(peerBefore.game.myMarker));
      assert.ok(!JSON.stringify(peerAfter).includes("private host note"));
      const outside = await fixture.request(`/matches/${groupId}`, {
        client: cli.clients.get("s4_outsider"),
      });
      assert.equal(outside.status, 404);
      assert.equal(
        (
          await fixture.request(`/matches/${groupId}/state`, {
            client: cli.clients.get("s4_host"),
          })
        ).status,
        404,
      );
      await execute({ op: "registered", name: "s4_late" });
      await execute({
        op: "join",
        name: "s4_late",
        matchId: groupId,
        expectedRevision: hostAfter.revision,
      });
      const lateBefore = await snapshot("s4_late", groupId);
      const left = await execute({
        op: "leave",
        name: "s4_late",
        matchId: groupId,
        expectedRevision: lateBefore.revision,
      });
      await execute({
        op: "join",
        name: "s4_late",
        matchId: groupId,
        expectedRevision: left.committedRevision,
      });
      const lateAfter = await snapshot("s4_late", groupId);
      assert.equal(
        lateAfter.members.find(
          (member) =>
            member.principalId ===
            cli.clients.get("s4_late").session.principalId,
        ).id,
        lateBefore.members.find(
          (member) =>
            member.principalId ===
            cli.clients.get("s4_late").session.principalId,
        ).id,
      );
      assert.deepEqual(await deadline(groupId), [retained]);
      assert.deepEqual(
        await obligation(groupId, retained.event_id),
        retainedObligation,
      );
      assert.deepEqual(
        (await snapshot("s4_host", groupId)).deadlines.map(
          ({ key, generation, dueAt }) => ({ key, generation, dueAt }),
        ),
        [
          {
            key: retained.key,
            generation: Number(retained.generation),
            dueAt: new Date(retained.due_at).toISOString(),
          },
        ],
      );
    },
  );

  await run(
    "F1-08/F2 CLI: supervised restart and deadline recovery",
    [
      "disconnect is transport-only and does not leave",
      "stopped worker leaves committed unscheduled effects durable",
      "real API/worker restart retains private note/count/scores",
      "overdue generation consumes once and awards no points",
      "reconnect refreshes the authoritative snapshot",
    ],
    async () => {
      await execute({ op: "subscribe", name: "s4_host", matchId: groupId });
      await execute({ op: "subscribe", name: "s4_peer", matchId: groupId });
      const before = await snapshot("s4_host", groupId);
      await execute({ op: "disconnect", name: "s4_peer" });
      await fixture.stopWorker();
      const committed = await execute({
        op: "act",
        name: "s4_host",
        matchId: groupId,
        type: "note",
        payload: { text: "survives process restart" },
        expectedRevision: before.revision,
      });
      assert.ok(
        (
          await pool.query(
            "SELECT 1 FROM next_round.outbox WHERE aggregate_id=$1 AND aggregate_revision=$2 AND topic='live.invalidate' AND delivered_at IS NULL",
            [groupId, committed.committedRevision],
          )
        ).rowCount > 0,
      );
      const expired = await execute({
        op: "expire-deadline",
        matchId: groupId,
      });
      const oldPids = fixture.pids;
      const restarted = await execute({ op: "restart", target: "all" });
      assert.notEqual(restarted.api, oldPids.api);
      assert.notEqual(restarted.worker, oldPids.worker);
      const after = await fixture.until(async () => {
        const value = await snapshot("s4_host", groupId);
        return value.revision > committed.committedRevision ? value : false;
      }, "restart consumes overdue deadline");
      assert.equal(after.revision, committed.committedRevision + 1);
      assert.equal(after.game.count, before.game.count);
      assert.deepEqual(after.game.scores, before.game.scores);
      assert.equal(after.game.myNote, "survives process restart");
      assert.notEqual(
        after.game.currentActorMemberId,
        before.game.currentActorMemberId,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM next_round.match_deadlines WHERE match_id=$1 AND key=$2 AND generation=$3",
            [groupId, expired.key, expired.generation],
          )
        ).rows[0].status,
        "consumed",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.match_events WHERE match_id=$1 AND event_id=$2",
            [groupId, expired.event_id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.notifications WHERE match_id=$1 AND kind='turn_missed' AND safe_payload->>'eventId'=$2",
            [groupId, expired.event_id],
          )
        ).rows[0].n,
        1,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT superseded_at FROM next_round.notifications WHERE match_id=$1 AND kind='action_required' AND safe_payload->>'eventId'=$2",
            [groupId, expired.event_id],
          )
        ).rows.every((row) => row.superseded_at),
      );
      await execute({ op: "reconnect", name: "s4_peer" });
      await execute({ op: "reconnect", name: "s4_host" });
      await fixture.until(
        () =>
          cli.clients
            .get("s4_peer")
            .receivedSnapshots.some(
              (value) =>
                value.id === groupId && value.revision === after.revision,
            ),
        "peer reconnect snapshot",
      );
      assert.equal(
        (await snapshot("s4_peer", groupId)).members.find(
          (member) =>
            member.principalId ===
            cli.clients.get("s4_peer").session.principalId,
        ).status,
        "active",
      );
    },
  );

  await run(
    "F2 H4: Test Counter completion and guest career separation",
    [
      "current actors rotate and each accepted add awards exactly one point",
      "fresh turn generation replaces the previous deadline",
      "count reaches target once and cancels active deadlines",
      "guest gets attributed result while registered career contributions remain eligible",
    ],
    async () => {
      let previousGeneration = Number((await deadline(groupId))[0].generation);
      let last;
      while ((await snapshot("s4_host", groupId)).phase === "active") {
        const before = await snapshot("s4_host", groupId);
        const name = currentName(before);
        const intent = `group-score-${before.game.count}`;
        last = await add(name, groupId, { intent });
        const after = await snapshot("s4_host", groupId);
        assert.equal(after.revision, before.revision + 1);
        if (after.phase === "active") {
          assert.equal(after.game.count, before.game.count + 1);
          const row = (await deadline(groupId))[0];
          assert.equal(Number(row.generation), previousGeneration + 1);
          previousGeneration = Number(row.generation);
        }
      }
      const result = await execute({
        op: "result",
        name: "s4_host",
        matchId: groupId,
      });
      assert.equal(result.outcome, "completed");
      assert.equal(result.data.count, 4);
      assert.equal(
        result.participants.reduce((total, value) => total + value.score, 0),
        4,
      );
      assert.equal(result.participants.length, 4);
      const guestMember = (
        await pool.query(
          "SELECT id FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
          [groupId, cli.clients.get("guest").session.principalId],
        )
      ).rows[0].id;
      assert.equal(
        result.participants.find((value) => value.memberId === guestMember)
          .score,
        1,
      );
      assert.equal(
        result.participants.find((value) => value.memberId === guestMember)
          .careerEligible,
        false,
      );
      const contributions = (
        await pool.query(
          "SELECT principal_id,points::integer AS points,played::integer AS played,wins::integer AS wins FROM next_round.career_contributions WHERE match_id=$1",
          [groupId],
        )
      ).rows;
      assert.equal(contributions.length, 3);
      assert.ok(
        contributions.every(
          (value) =>
            value.principal_id !==
              cli.clients.get("guest").session.principalId &&
            value.points === 1 &&
            value.played === 1 &&
            value.wins === 1,
        ),
      );
      assert.deepEqual(await deadline(groupId), []);
      const lastReplay = await execute({
        op: "replay",
        intent: "group-score-3",
      });
      assert.equal(lastReplay.replayed, true);
      assert.equal(lastReplay.committedRevision, last.committedRevision);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.match_results WHERE match_id=$1",
            [groupId],
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(
        await execute({ op: "result", name: "guest", matchId: groupId }),
        result,
      );
    },
  );

  await run(
    "F2 CLI: ended-early result and explicit finish retry",
    [
      "module finish capability is enforced",
      "host can finish early through real HTTP CLI",
      "retry creates no duplicate result",
      "participant projection records ended_early",
    ],
    async () => {
      const { matchId } = await execute({
        op: "create",
        name: "s4_host",
        settings: { target: 5, turnSeconds: null },
      });
      const join = await execute({
        op: "join",
        name: "s4_peer",
        matchId,
        expectedRevision: 0,
      });
      await execute({
        op: "start",
        name: "s4_host",
        matchId,
        expectedRevision: join.committedRevision,
      });
      const view = await snapshot("s4_host", matchId);
      await assert.rejects(
        () =>
          execute({
            op: "finish",
            name: "s4_peer",
            matchId,
            expectedRevision: view.revision,
          }),
        (error) => error instanceof HarnessHttpError && error.status === 403,
      );
      const commandId = randomUUID();
      const finished = await execute({
        op: "finish",
        name: "s4_host",
        matchId,
        expectedRevision: view.revision,
        commandId,
      });
      const replayed = await execute({
        op: "finish",
        name: "s4_host",
        matchId,
        expectedRevision: view.revision,
        commandId,
      });
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.committedRevision, finished.committedRevision);
      assert.equal(
        (await execute({ op: "result", name: "s4_host", matchId })).outcome,
        "ended_early",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.match_results WHERE match_id=$1",
            [matchId],
          )
        ).rows[0].n,
        1,
      );
    },
  );

  await run(
    "F2/D50 CLI: disabled sole actor suspends and reactivation resumes",
    [
      "real admin status transition retains disabled membership",
      "last enabled actor cancellation leaves no running deadline and invents no result",
      "reactivation restores actor with fresh generation while retaining counters",
    ],
    async () => {
      await execute({ op: "registered", name: "s4_suspend" });
      const { matchId } = await execute({
        op: "create",
        name: "s4_suspend",
        mode: "solo",
        settings: { target: 3, turnSeconds: 60 },
      });
      await execute({
        op: "start",
        name: "s4_suspend",
        matchId,
        expectedRevision: 0,
      });
      const before = await snapshot("s4_suspend", matchId);
      const priorDeadline = (await deadline(matchId))[0];
      const target = cli.clients.get("s4_suspend").session.principalId;
      const admin = cli.clients.get("s4_host");
      await fixture.data(`/admin/users/${target}`, {
        method: "PATCH",
        client: admin,
        body: { disabled: true },
      });
      const suspended = (
        await pool.query(
          "SELECT phase,state,revision::integer AS revision FROM next_round.matches WHERE id=$1",
          [matchId],
        )
      ).rows[0];
      assert.equal(suspended.phase, "active");
      assert.equal(suspended.state.currentActorMemberId, null);
      assert.equal(suspended.state.count, before.game.count);
      assert.deepEqual(suspended.state.scores, before.game.scores);
      assert.deepEqual(await deadline(matchId), []);
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
            [matchId, target],
          )
        ).rows[0].status,
        "active",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.match_results WHERE match_id=$1",
            [matchId],
          )
        ).rows[0].n,
        0,
      );
      await fixture.data(`/admin/users/${target}`, {
        method: "PATCH",
        client: admin,
        body: { disabled: false },
      });
      await execute({
        op: "registered",
        name: "s4_resumed",
        username: "s4_suspend",
      });
      const resumed = await snapshot("s4_resumed", matchId);
      const fresh = (await deadline(matchId))[0];
      assert.equal(
        resumed.game.currentActorMemberId,
        before.game.currentActorMemberId,
      );
      assert.equal(resumed.game.count, before.game.count);
      assert.deepEqual(resumed.game.scores, before.game.scores);
      assert.ok(Number(fresh.generation) > Number(priorDeadline.generation));
      assert.notEqual(fresh.event_id, priorDeadline.event_id);
      assert.ok(
        new Date(fresh.due_at).getTime() > Date.parse(resumed.serverNow),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.match_results WHERE match_id=$1",
            [matchId],
          )
        ).rows[0].n,
        0,
      );
      await execute({
        op: "finish",
        name: "s4_resumed",
        matchId,
        expectedRevision: resumed.revision,
      });
    },
  );

  await run(
    "F2 H1 residual: finished issuance, late registration and admin link revoke",
    [
      "finished match rejects new registration invitation issuance",
      "already-issued registration still creates an account when destination closes",
      "admin nonmember revokes host's reusable link",
    ],
    async () => {
      const peer = cli.clients.get("s4_peer");
      const host = cli.clients.get("s4_host");
      const { matchId } = await execute({
        op: "create",
        name: "s4_peer",
        mode: "solo",
        settings: { target: 1, turnSeconds: null },
      });
      const issued = await fixture.data(
        "/invitations/registration",
        { client: peer, body: { commandId: randomUUID(), matchId } },
        201,
      );
      const token = new URL(issued.url).hash.slice(1);
      await execute({
        op: "start",
        name: "s4_peer",
        matchId,
        expectedRevision: 0,
      });
      await add("s4_peer", matchId);
      const denied = await fixture.request("/invitations/registration", {
        client: peer,
        body: { commandId: randomUUID(), matchId },
      });
      assert.equal(denied.status, 403);
      const registered = await fixture.data(
        "/auth/register",
        {
          body: {
            commandId: randomUUID(),
            token,
            username: "s4_closed_destination",
            password: "sprint4-valid-password",
            displayName: "Closed destination",
          },
        },
        201,
      );
      assert.ok(registered.principal.id);
      assert.equal(registered.destination.matchId, matchId);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM next_round.accounts WHERE username='s4_closed_destination'",
          )
        ).rows[0].n,
        1,
      );
      const linkMatch = await execute({
        op: "create",
        name: "s4_peer",
        settings: { target: 2, turnSeconds: null },
        visibility: "invite",
      });
      const link = await fixture.data(`/matches/${linkMatch.matchId}/link`, {
        client: peer,
        body: { commandId: randomUUID(), rotate: false },
      });
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
            [linkMatch.matchId, host.session.principalId],
          )
        ).rowCount,
        0,
      );
      const revoked = await fixture.request(
        `/matches/${linkMatch.matchId}/link`,
        { client: host, method: "DELETE", body: {} },
      );
      assert.equal(revoked.status, 204);
      assert.equal(
        (
          await fixture.request("/match-links/resolve", {
            body: { token: new URL(link.url).hash.slice(1) },
          })
        ).status,
        410,
      );
    },
  );

  await run(
    "F2 H1 residual: rolling 10/minute budget across wall-minute boundary",
    [
      "ten accepted attempts just before the minute boundary still count after it",
      "eleven concurrent redemptions admit ten attempts and rate-limit one",
      "expired attempt rows release budget without a process-local reset",
    ],
    async () => {
      await pool.query("DELETE FROM next_round.rate_buckets");
      const key = createHash("sha256").update("127.0.0.1").digest();
      await fixture.until(
        async () =>
          Number(
            (
              await pool.query(
                "SELECT extract(second FROM clock_timestamp()) AS seconds",
              )
            ).rows[0].seconds,
          ) < 55,
        "safe wall-minute boundary fixture margin",
      );
      await pool.query(
        "INSERT INTO next_round.rate_buckets(key_hash,window_start,count,expires_at) SELECT $1,t,10,t+interval '1 minute' FROM (SELECT date_trunc('minute',clock_timestamp())-interval '1 microsecond' AS t) stamp",
        [key],
      );
      const invalid = () =>
        fixture.request("/auth/qr/redeem", {
          body: { commandId: randomUUID(), token: "0".repeat(64) },
        });
      assert.equal(
        (await invalid()).status,
        429,
        "Rolling budget must not reset at the wall-clock minute boundary",
      );
      await pool.query(
        "UPDATE next_round.rate_buckets SET window_start=clock_timestamp()-interval '61 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE key_hash=$1",
        [key],
      );
      const responses = await Promise.all(Array.from({ length: 11 }, invalid));
      assert.equal(
        responses.filter((response) => response.status === 410).length,
        10,
      );
      assert.equal(
        responses.filter((response) => response.status === 429).length,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT sum(count)::integer AS n FROM next_round.rate_buckets WHERE key_hash=$1 AND window_start>clock_timestamp()-interval '1 minute'",
            [key],
          )
        ).rows[0].n,
        10,
      );
    },
  );

  return {
    scenario: "Sprint 4 real development CLI and Test Counter acceptance",
    postgres: (await pool.query("SHOW server_version")).rows[0].server_version,
    pids: fixture.pids,
    cases,
    scope:
      "Complements (does not relabel) Sprint 2 F1 recovery/version and Sprint 3 H1-H6 platform cases. Full F2 also requires the separately recorded F1 browser-shell journey and login budgets.",
    faults:
      "post-commit response loss is in the Node client; restart and deadline expiry are isolated test-service controls, never production routes",
  };
}
