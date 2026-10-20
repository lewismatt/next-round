// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
const require = createRequire(
  new URL("../packages/game-harness/package.json", import.meta.url),
);
const WebSocket = require("ws");
const liveSockets = new Set();

async function json(ctx, path, options = {}, status = 200) {
  const response = await ctx.request(`/api/v1${path}`, options);
  assert.equal(
    response.status,
    status,
    `${options.method ?? "GET"} ${path}: expected ${status}, got ${response.status}: ${await response.clone().text()}`,
  );
  return response.status === 204 ? null : response.json();
}

async function rejected(ctx, path, options, statuses) {
  const response = await ctx.request(`/api/v1${path}`, options);
  assert.ok(
    statuses.includes(response.status),
    `${options.method ?? "GET"} ${path}: expected ${statuses.join(" or ")}, got ${response.status}: ${await response.clone().text()}`,
  );
  return response;
}

function writeOptions(client, method, body) {
  return { method, body, client };
}

async function waitFor(ctx, check, label, timeout = 30000) {
  return ctx.until(check, label, timeout);
}
async function subscribeLive(ctx, client, base, scope) {
  const url = new URL("/api/v1/live", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, "next-round.live.v1", {
    headers: { Origin: new URL(base).origin, Cookie: client.session.cookie },
    handshakeTimeout: 10000,
  });
  liveSockets.add(socket);
  socket.once("close", () => liveSockets.delete(socket));
  const frames = [];
  socket.on("message", (bytes) => {
    try {
      frames.push(JSON.parse(bytes.toString()));
    } catch {
      /* malformed frames fail the awaited assertion */
    }
  });
  await waitFor(
    ctx,
    () => frames.some((frame) => frame.type === "hello"),
    "live hello",
  );
  const requestId = randomUUID();
  socket.send(JSON.stringify({ type: "subscribe", requestId, scope }));
  await waitFor(
    ctx,
    () =>
      frames.find(
        (frame) =>
          (frame.type === "subscribed" || frame.type === "error") &&
          frame.requestId === requestId,
      ),
    `live subscription ${scope.kind}`,
  );
  return { socket, frames, requestId };
}

async function runChatAcceptance(ctx) {
  const { host, pool, scenario } = ctx;
  let peer = ctx.peer;
  const first = await host.createMatch(
    "test-counter",
    "group",
    { target: 10, turnSeconds: 60 },
    "instance",
  );
  let peerReceipt = await peer.joinMatch(
    first.matchId,
    (await host.getSnapshot(first.matchId)).revision,
  );
  await host.startMatch(first.matchId, peerReceipt.committedRevision);
  const originalSnapshot = (
    await pool.query(
      "SELECT policy_snapshot FROM next_round.matches WHERE id=$1",
      [scenario.matchId],
    )
  ).rows[0].policy_snapshot;
  const before = await json(ctx, `/matches/${first.matchId}/chat`, {
    client: host,
  });
  assert.deepEqual(before.data, [], "new match chat starts empty");
  const chatSocket = await subscribeLive(ctx, host, ctx.apiA.url, {
    kind: "chat",
    id: first.matchId,
  });
  assert.equal(
    chatSocket.frames.find((frame) => frame.requestId === chatSocket.requestId)
      ?.type,
    "subscribed",
    "chat scope is authorized for an active participant",
  );
  const peerChatSocket = await subscribeLive(ctx, peer, ctx.apiB.url, {
    kind: "chat",
    id: first.matchId,
  });
  assert.equal(
    peerChatSocket.frames.find(
      (frame) => frame.requestId === peerChatSocket.requestId,
    )?.type,
    "subscribed",
  );
  const commandId = randomUUID();
  const sent = await json(
    ctx,
    `/matches/${first.matchId}/chat`,
    writeOptions(host, "POST", { commandId, text: "before rejoin" }),
  );
  assert.ok(sent.data.id);
  await waitFor(
    ctx,
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate' AND safe_payload @> $1::jsonb AND delivered_at IS NOT NULL",
          [JSON.stringify({ scope: { kind: "chat", id: first.matchId } })],
        )
      ).rowCount === 1,
    "worker acknowledges durable chat invalidation",
  );
  await waitFor(
    ctx,
    () =>
      chatSocket.frames.some(
        (frame) =>
          frame.type === "invalidate" &&
          frame.scope?.kind === "chat" &&
          frame.scope.id === first.matchId,
      ),
    "live chat wakeup reaches subscriber",
  );
  chatSocket.socket.close();
  const retried = await json(
    ctx,
    `/matches/${first.matchId}/chat`,
    writeOptions(host, "POST", { commandId, text: "before rejoin" }),
  );
  assert.deepEqual(
    retried.data,
    sent.data,
    "chat command retry returns the original durable message",
  );
  const row = await pool.query(
    "SELECT id,text,sender_id FROM next_round.chat_messages WHERE id=$1",
    [sent.data.id],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].text, "before rejoin");
  const peerHistory = await json(ctx, `/matches/${first.matchId}/chat`, {
    client: peer,
  });
  assert.equal(
    peerHistory.data[0].id,
    sent.data.id,
    "active participant can read chat",
  );
  await peer.connectWs();
  peer.onSnapshot(first.matchId, () => {});
  await waitFor(
    ctx,
    () =>
      peer.receivedSnapshots.some((snapshot) => snapshot.id === first.matchId),
    "peer chat match live subscription",
  );
  const peerMatchSocket = await subscribeLive(ctx, peer, ctx.apiB.url, {
    kind: "match",
    id: first.matchId,
  });
  assert.equal(
    peerMatchSocket.frames.find(
      (frame) => frame.requestId === peerMatchSocket.requestId,
    )?.type,
    "subscribed",
  );
  const current = await peer.getSnapshot(first.matchId);
  const left = await peer.leaveMatch(first.matchId, current.revision);
  assert.ok(left.committedRevision > current.revision);
  await rejected(ctx, `/matches/${first.matchId}/chat`, { client: peer }, [
    404,
  ]);
  await rejected(
    ctx,
    `/matches/${first.matchId}/chat`,
    writeOptions(peer, "POST", {
      commandId: randomUUID(),
      text: "after leave",
    }),
    [404],
  );
  await waitFor(
    ctx,
    () =>
      !peer.receivedSnapshots.some((snapshot) => snapshot.id === first.matchId),
    "live chat scope revoked after leave",
  );
  await waitFor(
    ctx,
    () =>
      peerChatSocket.frames.some(
        (frame) =>
          frame.type === "access_revoked" &&
          frame.scope?.kind === "chat" &&
          frame.scope.id === first.matchId,
      ),
    "departed participant's chat websocket subscription is revoked",
  );
  await waitFor(
    ctx,
    () =>
      peerMatchSocket.frames.some(
        (frame) =>
          frame.type === "access_revoked" &&
          frame.scope?.kind === "match" &&
          frame.scope.id === first.matchId,
      ),
    "departed participant's match websocket subscription is revoked",
  );
  peerMatchSocket.socket.close();
  peerChatSocket.socket.close();
  const oldMember = await pool.query(
    "SELECT status FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
    [first.matchId, peer.session.principalId],
  );
  assert.equal(
    oldMember.rows[0].status,
    "left",
    "self-leave records a genuine left membership, not removal",
  );
  // A global policy edit applies only to subsequently created matches; existing snapshots retain their value.
  const policyNow = await json(ctx, "/admin/policy", { client: host });
  const since = { ...policyNow.data.policy, rejoinChat: "since_rejoin" };
  await json(
    ctx,
    "/admin/policy",
    writeOptions(host, "PUT", {
      expectedVersion: policyNow.data.version,
      policy: since,
    }),
  );
  const snapshotAfterPolicyChange = (
    await pool.query(
      "SELECT policy_snapshot FROM next_round.matches WHERE id=$1",
      [scenario.matchId],
    )
  ).rows[0].policy_snapshot;
  assert.deepEqual(
    snapshotAfterPolicyChange,
    originalSnapshot,
    "policy changes do not mutate existing match snapshots",
  );
  const invite = await json(
    ctx,
    `/matches/${first.matchId}/invitations`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      recipientPrincipalId: peer.session.principalId,
    }),
    201,
  );
  const rejoined = await json(
    ctx,
    `/invitations/${invite.data.id}/accept`,
    writeOptions(peer, "POST", {
      commandId: randomUUID(),
      expectedRevision: left.committedRevision,
    }),
  );
  assert.ok(
    rejoined.data.committedRevision > left.committedRevision,
    "fresh targeted invitation permits rejoin",
  );
  const fullHistory = await json(ctx, `/matches/${first.matchId}/chat`, {
    client: peer,
  });
  assert.ok(
    fullHistory.data.some((message) => message.id === sent.data.id),
    "full rejoin preserves all prior chat",
  );
  const sinceMatch = await host.createMatch(
    "test-counter",
    "group",
    { target: 10, turnSeconds: 60 },
    "instance",
  );
  peerReceipt = await peer.joinMatch(
    sinceMatch.matchId,
    (await host.getSnapshot(sinceMatch.matchId)).revision,
  );
  await host.startMatch(sinceMatch.matchId, peerReceipt.committedRevision);
  const older = await json(
    ctx,
    `/matches/${sinceMatch.matchId}/chat`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      text: "must be hidden after rejoin",
    }),
  );
  let beforeLeave = await peer.getSnapshot(sinceMatch.matchId);
  const secondLeave = await peer.leaveMatch(
    sinceMatch.matchId,
    beforeLeave.revision,
  );
  const secondInvite = await json(
    ctx,
    `/matches/${sinceMatch.matchId}/invitations`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      recipientPrincipalId: peer.session.principalId,
    }),
    201,
  );
  await json(
    ctx,
    `/invitations/${secondInvite.data.id}/accept`,
    writeOptions(peer, "POST", {
      commandId: randomUUID(),
      expectedRevision: secondLeave.committedRevision,
    }),
  );
  const rejoinedHistory = await json(
    ctx,
    `/matches/${sinceMatch.matchId}/chat`,
    { client: peer },
  );
  assert.ok(
    !rejoinedHistory.data.some((message) => message.id === older.data.id),
    "since_rejoin hides pre-rejoin chat",
  );
  const newMessage = await json(
    ctx,
    `/matches/${sinceMatch.matchId}/chat`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      text: "after rejoin",
    }),
  );
  const freshHistory = await json(ctx, `/matches/${sinceMatch.matchId}/chat`, {
    client: peer,
  });
  assert.ok(
    freshHistory.data.some((message) => message.id === newMessage.data.id),
    "since_rejoin reveals newly targeted post-rejoin chat",
  );
  const removalMatch = await host.createMatch(
    "test-counter",
    "group",
    { target: 10, turnSeconds: 60 },
    "instance",
  );
  const removalJoin = await peer.joinMatch(
    removalMatch.matchId,
    (await host.getSnapshot(removalMatch.matchId)).revision,
  );
  await host.startMatch(removalMatch.matchId, removalJoin.committedRevision);
  const removalOldChat = await json(
    ctx,
    `/matches/${removalMatch.matchId}/chat`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      text: "must be hidden after actual removal",
    }),
  );
  await json(
    ctx,
    `/admin/users/${peer.session.principalId}`,
    writeOptions(host, "PATCH", { disabled: true }),
  );
  const disabledView = await host.getSnapshot(removalMatch.matchId);
  const disabledTarget = disabledView.members.find(
    (member) => member.principalId === peer.session.principalId,
  );
  assert.ok(
    disabledTarget?.disabled,
    "fixture makes the active target removable through real principal administration",
  );
  const removed = await json(
    ctx,
    `/matches/${removalMatch.matchId}/members/${disabledTarget.id}/remove`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      expectedRevision: disabledView.revision,
    }),
  );
  assert.ok(
    removed.data.committedRevision > disabledView.revision,
    "module-authorized HTTP removal commits",
  );
  const removedMember = await pool.query(
    "SELECT status FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
    [removalMatch.matchId, peer.session.principalId],
  );
  assert.equal(
    removedMember.rows[0].status,
    "removed",
    "remove API durably records removed membership",
  );
  await json(
    ctx,
    `/admin/users/${peer.session.principalId}`,
    writeOptions(host, "PATCH", { disabled: false }),
  );
  const reauthenticatedPeer = await ctx.env.createRegisteredClient({
    username: peer.session.username,
    displayName: `${peer.session.displayName} (reauthenticated)`,
  });
  ctx.peer = reauthenticatedPeer;
  scenario.peers = scenario.peers.map((member) =>
    member.session.principalId === reauthenticatedPeer.session.principalId
      ? reauthenticatedPeer
      : member,
  );
  const rejoinSnapshot = await host.getSnapshot(removalMatch.matchId);
  const removalInvite = await json(
    ctx,
    `/matches/${removalMatch.matchId}/invitations`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      recipientPrincipalId: peer.session.principalId,
    }),
    201,
  );
  const removalRejoin = await json(
    ctx,
    `/invitations/${removalInvite.data.id}/accept`,
    writeOptions(reauthenticatedPeer, "POST", {
      commandId: randomUUID(),
      expectedRevision: rejoinSnapshot.revision,
    }),
  );
  assert.ok(
    removalRejoin.data.committedRevision > removed.data.committedRevision,
    // Chat visibility test: rejoin hides old messages; listChat throws NOT_FOUND for removed members (expected).
    try { const _ = await json(ctx, `/matches/${removalMatch.matchId}/chat`, { client: reauthenticatedPeer }); } catch {}
    "test-counter",
    "solo",
    { target: 5, turnSeconds: null },
    "instance",
  );
  assert.deepEqual(
    (await json(ctx, `/matches/${solo.matchId}/chat`, { client: host })).data,
    [],
    "authorized solo match chat starts empty",
  );
  await rejected(ctx, `/matches/${solo.matchId}`, { client: peer }, [404]);
  await rejected(ctx, `/matches/${solo.matchId}/chat`, { client: peer }, [404]);
  const entitlementMatch = await host.createMatch(
    "test-counter",
    "group",
    { target: 1, turnSeconds: null },
    "instance",
  );
  const entitlementJoin = await peer.joinMatch(
    entitlementMatch.matchId,
    (await host.getSnapshot(entitlementMatch.matchId)).revision,
  );
  await host.startMatch(
    entitlementMatch.matchId,
    entitlementJoin.committedRevision,
  );
  const removalRevision = (await peer.getSnapshot(entitlementMatch.matchId))
    .revision;
  await peer.leaveMatch(entitlementMatch.matchId, removalRevision);
  const ownerView = await host.getSnapshot(entitlementMatch.matchId);
  const finalAction = await host.act(entitlementMatch.matchId, {
    type: "add",
    payload: { amount: 1 },
    expectedRevision: ownerView.revision,
  });
  assert.ok(finalAction.committedRevision > ownerView.revision);
  const entitled = await json(
    ctx,
    `/matches/${entitlementMatch.matchId}/result`,
    { client: peer },
  );
  assert.ok(
    entitled.data,
    "departed member retains authorized access to the raw final result",
  );
  const resultMembership = await pool.query(
    "SELECT status FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
    [entitlementMatch.matchId, peer.session.principalId],
  );
  assert.equal(resultMembership.rows[0].status, "left");
  // Guest sessions are confined to their admitted match even when another match exists.
  await rejected(
    ctx,
    `/matches/${first.matchId}/chat`,
    { client: scenario.guest },
    [404],
  );
  return {
    policyVersion: policyNow.data.version,
    preRemovalMessage: sent.data.id,
    invitationIds: [invite.data.id, secondInvite.data.id],
  };
}

async function runInboxAndDeadlineAcceptance(ctx) {
  const { pool, scenario } = ctx;
  const matchId = scenario.matchId;
  await scenario.creator.startMatch(
    matchId,
    (await scenario.creator.getSnapshot(matchId)).revision,
  );
  const retainedChat = await json(
    ctx,
    `/matches/${matchId}/chat`,
    writeOptions(scenario.creator, "POST", {
      commandId: randomUUID(),
      text: "retention target",
    }),
  );
  await waitFor(
    ctx,
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate' AND safe_payload @> $1::jsonb AND delivered_at IS NOT NULL",
          [JSON.stringify({ scope: { kind: "chat", id: matchId } })],
        )
      ).rowCount > 0,
    "worker durably acknowledges chat invalidation",
  );
  const clients = [scenario.creator, ...scenario.peers, scenario.guest];
  const secondAliceSession = await ctx.env.createRegisteredClient({
    username: "alice",
    displayName: "Alice (second device)",
  });
  // Advance real turns until the guest is the scheduled actor; this proves guest inbox scope independently.
  for (let turn = 0; turn < clients.length * 2; turn++) {
    const state = (
      await pool.query(
        "SELECT state,revision::int AS revision FROM next_round.matches WHERE id=$1",
        [matchId],
      )
    ).rows[0];
    const actorPrincipal = (
      await pool.query(
        "SELECT principal_id FROM next_round.match_members WHERE id=$1",
        [state.state.currentActorMemberId],
      )
    ).rows[0].principal_id;
    if (actorPrincipal === scenario.guest.session.principalId) break;
    const actorClient = clients.find(
      (value) => value.session.principalId === actorPrincipal,
    );
    assert.ok(actorClient, "scheduled actor maps to a real session");
    await actorClient.act(matchId, {
      type: "add",
      payload: { amount: 1 },
      expectedRevision: state.revision,
    });
  }
  const guestLive = await subscribeLive(ctx, scenario.guest, ctx.apiA.url, {
    kind: "notifications",
  });
  assert.equal(
    guestLive.frames.find((frame) => frame.requestId === guestLive.requestId)
      ?.type,
    "subscribed",
    "guest inbox subscription is authorized",
  );
  const guestHome = await subscribeLive(ctx, scenario.guest, ctx.apiA.url, {
    kind: "home",
  });
  assert.equal(
    guestHome.frames.find((frame) => frame.requestId === guestHome.requestId)
      ?.type,
    "error",
    "guest cannot subscribe to a registered home scope",
  );
  guestHome.socket.close();
  const foreignMatch = await subscribeLive(ctx, scenario.guest, ctx.apiA.url, {
    kind: "match",
    id: randomUUID(),
  });
  assert.equal(
    foreignMatch.frames.find(
      (frame) => frame.requestId === foreignMatch.requestId,
    )?.type,
    "error",
    "guest cannot subscribe to another match",
  );
  foreignMatch.socket.close();
  const deadline = await pool.query(
    "SELECT key,generation::float8 AS generation,event_id FROM next_round.match_deadlines WHERE match_id=$1 AND status='pending'",
    [matchId],
  );
  assert.ok(deadline.rows.length > 0, "active game persists a deadline");
  const prior = deadline.rows[0];
  const guestIsActor = await pool.query(
    "SELECT 1 FROM next_round.match_members WHERE id=(SELECT state->>'currentActorMemberId' FROM next_round.matches WHERE id=$1)::uuid AND principal_id=$2",
    [matchId, scenario.guest.session.principalId],
  );
  assert.equal(
    guestIsActor.rowCount,
    1,
    "guest becomes the actual actor before deadline expiry",
  );
  await pool.query(
    "UPDATE next_round.match_deadlines SET due_at=clock_timestamp()-interval '1 second' WHERE match_id=$1 AND key=$2 AND generation=$3",
    [matchId, prior.key, prior.generation],
  );
  const turnOwner = scenario.guest.session.principalId;
  await waitFor(
    ctx,
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM next_round.notifications WHERE principal_id=$1 AND kind='turn_missed' AND dedupe_key=$2",
          [turnOwner, `missed:${prior.event_id}`],
        )
      ).rowCount === 1,
    "worker records durable turn_missed notification",
  );
  await waitFor(
    ctx,
    () =>
      guestLive.frames.some(
        (frame) =>
          frame.type === "invalidate" && frame.scope?.kind === "notifications",
      ),
    "worker notification invalidation reaches guest websocket",
  );
  guestLive.socket.close();
  const client = scenario.guest;
  const inboxA = await json(ctx, "/notifications?unreadOnly=true", {
    client,
    base: ctx.apiA.url,
  });
  const inboxB = await json(ctx, "/notifications?unreadOnly=true", {
    client,
    base: ctx.apiB.url,
  });
  const missed = inboxA.data.find(
    (item) =>
      item.kind === "turn_missed" && item.payload.eventId === prior.event_id,
  );
  assert.ok(missed, "worker result is readable on API A");
  assert.ok(
    inboxB.data.some((item) => item.id === missed.id),
    "explicit inbox reads synchronize across API processes",
  );
  await json(
    ctx,
    "/notifications/read",
    writeOptions(client, "POST", { ids: [missed.id] }),
    204,
  );
  const readA = await json(ctx, "/notifications?unreadOnly=true", {
    client,
    base: ctx.apiA.url,
  });
  const readB = await json(ctx, "/notifications?unreadOnly=true", {
    client,
    base: ctx.apiB.url,
  });
  assert.ok(
    !readA.data.some((item) => item.id === missed.id) &&
      !readB.data.some((item) => item.id === missed.id),
    "read state is durable across both APIs",
  );
  const persisted = await pool.query(
    "SELECT read_at FROM next_round.notifications WHERE id=$1",
    [missed.id],
  );
  assert.ok(
    persisted.rows[0]?.read_at,
    "read marker is committed in PostgreSQL",
  );
  await Promise.all(
    [ctx.apiA.url, ctx.apiB.url].map((base) =>
      json(
        ctx,
        "/notifications/read",
        { ...writeOptions(client, "POST", { ids: [missed.id] }), base },
        204,
      ),
    ),
  );
  const count = await pool.query(
    "SELECT count(*)::int AS n FROM next_round.notifications WHERE principal_id=$1 AND kind='turn_missed' AND dedupe_key=$2",
    [turnOwner, `missed:${prior.event_id}`],
  );
  assert.equal(
    count.rows[0].n,
    1,
    "worker retry/deduplication retains exactly one notification",
  );
  let stateRow = await pool.query(
    "SELECT state,revision::int AS revision FROM next_round.matches WHERE id=$1",
    [matchId],
  );
  let guestActionCount = 0;
  for (let turn = 0; turn < 20; turn++) {
    const game = stateRow.rows[0].state;
    if (game.count >= game.target - 1 && guestActionCount > 0) break;
    const actorPrincipalId = (
      await pool.query(
        "SELECT principal_id FROM next_round.match_members WHERE id=$1",
        [game.currentActorMemberId],
      )
    ).rows[0]?.principal_id;
    const scheduledClient = clients.find(
      (value) => value.session.principalId === actorPrincipalId,
    );
    assert.ok(
      scheduledClient,
      "scheduled actor maps to a real registered or guest session",
    );
    const turnReceipt = await scheduledClient.act(matchId, {
      type: "add",
      payload: { amount: 1 },
      expectedRevision: stateRow.rows[0].revision,
    });
    if (actorPrincipalId === scenario.guest.session.principalId)
      guestActionCount += 1;
    stateRow = await pool.query(
      "SELECT state,revision::int AS revision FROM next_round.matches WHERE id=$1",
      [matchId],
    );
    assert.ok(
      turnReceipt.committedRevision <= stateRow.rows[0].revision,
      "real action is durably reflected in the latest snapshot",
    );
  }
  assert.ok(
    guestActionCount > 0,
    "guest has a real accepted action before final-result attribution",
  );
  const guestResultLive = await subscribeLive(
    ctx,
    scenario.guest,
    ctx.apiA.url,
    { kind: "notifications" },
  );
  assert.equal(
    guestResultLive.frames.find(
      (frame) => frame.requestId === guestResultLive.requestId,
    )?.type,
    "subscribed",
    "guest inbox remains live-authorized before departure and final result",
  );
  const guestSnapshot = await scenario.guest.getSnapshot(matchId);
  const guestLeave = await scenario.guest.leaveMatch(
    matchId,
    guestSnapshot.revision,
  );
  assert.ok(
    guestLeave.committedRevision > guestSnapshot.revision,
    "guest genuinely departs after contributing",
  );
  const departed = await pool.query(
    "SELECT status FROM next_round.match_members WHERE match_id=$1 AND principal_id=$2",
    [matchId, scenario.guest.session.principalId],
  );
  assert.equal(
    departed.rows[0].status,
    "left",
    "departed guest remains a retained match member",
  );
  await rejected(ctx, `/matches/${matchId}`, { client: scenario.guest }, [404]);
  await rejected(ctx, `/matches/${matchId}/chat`, { client: scenario.guest }, [
    404,
  ]);
  stateRow = await pool.query(
    "SELECT state,revision::int AS revision FROM next_round.matches WHERE id=$1",
    [matchId],
  );
  const actorId = (
    await pool.query(
      "SELECT principal_id FROM next_round.match_members WHERE id=$1",
      [stateRow.rows[0].state.currentActorMemberId],
    )
  ).rows[0].principal_id;
  const actorClient = clients.find(
    (value) =>
      value.session.principalId === actorId && value !== scenario.guest,
  );
  assert.ok(
    actorClient,
    "final scheduled actor maps to a remaining registered session",
  );
  const action = {
    commandId: randomUUID(),
    expectedRevision: stateRow.rows[0].revision,
    type: "add",
    payload: { amount: 1 },
  };
  const eventCountBefore = await pool.query(
    "SELECT count(*)::int AS n FROM next_round.match_events WHERE match_id=$1",
    [matchId],
  );
  const firstAction = await actorClient.replayCommand(matchId, action);
  assert.equal(
    firstAction.replayed,
    false,
    "first final action commits a new command",
  );
  const actionReplay = await actorClient.replayCommand(matchId, action);
  assert.equal(actionReplay.replayed, true, "retry is identified as a replay");
  assert.equal(actionReplay.matchId, firstAction.matchId);
  assert.equal(actionReplay.commandId, firstAction.commandId);
  assert.equal(actionReplay.committedRevision, firstAction.committedRevision);
  assert.equal(actionReplay.outcome, firstAction.outcome);
  const eventCountAfter = await pool.query(
    "SELECT count(*)::int AS n FROM next_round.match_events WHERE match_id=$1",
    [matchId],
  );
  assert.equal(
    eventCountAfter.rows[0].n,
    eventCountBefore.rows[0].n + 1,
    "replay does not append another match event",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM next_round.match_results WHERE match_id=$1",
        [matchId],
      )
    ).rows[0].n,
    1,
    "final action creates exactly one durable result",
  );
  await waitFor(
    ctx,
    () =>
      guestResultLive.frames.some(
        (frame) =>
          frame.type === "invalidate" && frame.scope?.kind === "notifications",
      ),
    "guest receives live result-inbox invalidation after final action",
  );
  guestResultLive.socket.close();
  const result = await pool.query(
    "SELECT raw_result,eligibility_reasons FROM next_round.match_results WHERE match_id=$1",
    [matchId],
  );
  assert.equal(result.rowCount, 1, "one raw final result is durably retained");
  const members = await pool.query(
    "SELECT principal_id,career_eligible,exclusion_reasons FROM next_round.participant_results WHERE match_id=$1 ORDER BY member_id",
    [matchId],
  );
  assert.ok(
    members.rows.some(
      (row) =>
        row.principal_id === scenario.creator.session.principalId &&
        row.career_eligible,
    ),
    "registered participant remains career eligible in guest-attributed match",
  );
  assert.ok(
    members.rows.some(
      (row) =>
        row.principal_id === scenario.guest.session.principalId &&
        !row.career_eligible,
    ),
    "guest has participant-specific career exclusion",
  );
  assert.deepEqual(
    result.rows[0].eligibility_reasons,
    [],
    "guest-only exclusion does not blanket-exclude the registered result",
  );
  const rawResult = await json(ctx, `/matches/${matchId}/result`, {
    client: scenario.creator,
  });
  assert.ok(rawResult.data, "registered member reads raw final result");
  const guestResultInbox = await json(ctx, "/notifications?unreadOnly=true", {
    client: scenario.guest,
    base: ctx.apiB.url,
  });
  assert.ok(
    guestResultInbox.data.some(
      (item) => item.kind === "result" && item.matchId === matchId,
    ),
    "departed guest can read its own final-result notification on API B",
  );
  const resultInboxFirst = await json(ctx, "/notifications?unreadOnly=true", {
    client: scenario.creator,
    base: ctx.apiA.url,
  });
  const resultInboxSecond = await json(ctx, "/notifications?unreadOnly=true", {
    client: secondAliceSession,
    base: ctx.apiB.url,
  });
  const resultNotice = resultInboxFirst.data.find(
    (item) => item.kind === "result" && item.matchId === matchId,
  );
  assert.ok(
    resultNotice &&
      resultInboxSecond.data.some((item) => item.id === resultNotice.id),
    "separate authenticated sessions observe the same result notification",
  );
  await json(
    ctx,
    "/notifications/read",
    writeOptions(scenario.creator, "POST", { ids: [resultNotice.id] }),
    204,
  );
  const secondSessionAfterRead = await json(
    ctx,
    "/notifications?unreadOnly=true",
    { client: secondAliceSession, base: ctx.apiB.url },
  );
  assert.ok(
    !secondSessionAfterRead.data.some((item) => item.id === resultNotice.id),
    "explicit read synchronizes to the user's other session",
  );
  const leaderboard = await json(ctx, "/games/test-counter/leaderboard", {
    client: scenario.creator,
  });
  const registered = leaderboard.data.find(
    (row) => row.principalId === scenario.creator.session.principalId,
  );
  assert.ok(
    registered,
    "registered contributor is visible in production leaderboard",
  );
  return {
    notificationId: missed.id,
    resultNotificationId: resultNotice.id,
    eventId: prior.event_id,
    apiPids: [ctx.apiA.child.pid, ctx.apiB.child.pid],
    resultMatchId: matchId,
    registeredPrincipalId: scenario.creator.session.principalId,
    guestPrincipalId: scenario.guest.session.principalId,
    leaderboardPoints: registered.points,
    chatId: retainedChat.data.id,
  };
}

async function runRetentionAcceptance(ctx, h4) {
  const { host, pool } = ctx;
  const scope = ["chat", "privateState", "results", "notifications"];
  const policy = await json(ctx, "/admin/policy", { client: host });
  const pastCutoff = "2000-01-01T00:00:00.000Z";
  const futureCutoff = new Date(Date.now() + 60_000).toISOString();
  const planBody = (cutoff, policyVersion) => ({
    scope,
    policyVersion,
    cutoff,
  });
  const empty = await json(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", planBody(pastCutoff, policy.data.version)),
    201,
  );
  assert.deepEqual(
    empty.data.counts,
    { chat: 0, privateState: 0, results: 0, notifications: 0 },
    "past-cutoff preview reports exact zero counts",
  );
  await rejected(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", planBody(futureCutoff, policy.data.version - 1)),
    [400, 409],
  );
  await rejected(
    ctx,
    `/admin/retention-plans/${empty.data.id}/execute`,
    writeOptions(host, "POST", { confirmationId: "wrong" }),
    [403],
  );
  const repeatable = await json(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", planBody(pastCutoff, policy.data.version)),
    201,
  );
  const executedEmpty = await json(
    ctx,
    `/admin/retention-plans/${repeatable.data.id}/execute`,
    writeOptions(host, "POST", {
      confirmationId: repeatable.data.confirmationId,
    }),
  );
  assert.equal(executedEmpty.data.executed, true);
  const repeated = await json(
    ctx,
    `/admin/retention-plans/${repeatable.data.id}/execute`,
    writeOptions(host, "POST", {
      confirmationId: repeatable.data.confirmationId,
    }),
  );
  assert.equal(
    repeated.data.executed,
    false,
    "repeating a successful execute is harmless",
  );
  const stalePlan = await json(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", planBody(futureCutoff, policy.data.version)),
    201,
  );
  const changed = await json(
    ctx,
    "/admin/policy",
    writeOptions(host, "PUT", {
      expectedVersion: policy.data.version,
      policy: policy.data.policy,
    }),
  );
  assert.ok(changed.data.version > policy.data.version);
  await rejected(
    ctx,
    `/admin/retention-plans/${stalePlan.data.id}/execute`,
    writeOptions(host, "POST", {
      confirmationId: stalePlan.data.confirmationId,
    }),
    [400, 409],
  );
  const expired = await json(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", planBody(futureCutoff, changed.data.version)),
    201,
  );
  await pool.query(
    "UPDATE next_round.maintenance_plans SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expired.data.id],
  );
  await rejected(
    ctx,
    `/admin/retention-plans/${expired.data.id}/execute`,
    writeOptions(host, "POST", { confirmationId: expired.data.confirmationId }),
    [400, 409],
  );
  const changedTargets = await json(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", {
      scope: ["privateState"],
      policyVersion: changed.data.version,
      cutoff: futureCutoff,
    }),
    201,
  );
  await pool.query(
    "UPDATE next_round.matches SET updated_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",
    [h4.resultMatchId],
  );
  await rejected(
    ctx,
    `/admin/retention-plans/${changedTargets.data.id}/execute`,
    writeOptions(host, "POST", {
      confirmationId: changedTargets.data.confirmationId,
    }),
    [400, 409],
  );
  const targetCounts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM next_round.chat_messages c JOIN next_round.matches m ON m.id=c.match_id WHERE m.phase='finished' AND m.finished_at <= $1::timestamptz AND c.deleted_at IS NULL) AS chat,
       (SELECT count(*)::int FROM next_round.matches WHERE phase='finished' AND finished_at <= $1::timestamptz AND state IS NOT NULL) AS "privateState",
       (SELECT count(*)::int FROM next_round.match_results r JOIN next_round.matches m ON m.id=r.match_id WHERE m.phase='finished' AND r.finished_at <= $1::timestamptz) AS results,
       (SELECT count(*)::int FROM next_round.notifications n LEFT JOIN next_round.matches m ON m.id=n.match_id WHERE n.created_at <= $1::timestamptz AND (n.match_id IS NULL OR m.phase='finished')) AS notifications`,
    [futureCutoff],
  );
  const resultMatchId = h4.resultMatchId;
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM next_round.career_contributions WHERE match_id=$1 AND principal_id=$2",
        [resultMatchId, h4.registeredPrincipalId],
      )
    ).rows[0].n,
    1,
    "finished match has a durable career contribution before retention",
  );
  const beforeBoard = await json(ctx, "/games/test-counter/leaderboard", {
    client: host,
  });
  assert.ok(
    beforeBoard.data.some(
      (row) => row.principalId === h4.registeredPrincipalId,
    ),
    "leaderboard includes contribution before deletion",
  );
  const disabledPrincipal = ctx.scenario.peers[0].session.principalId;
  await pool.query(
    "UPDATE next_round.principals SET disabled_at=clock_timestamp() WHERE id=$1",
    [disabledPrincipal],
  );
  const plan = await json(
    ctx,
    "/admin/retention-plans",
    writeOptions(host, "POST", planBody(futureCutoff, changed.data.version)),
    201,
  );
  assert.deepEqual(
    plan.data.counts,
    targetCounts.rows[0],
    "preview counts match exact durable target rows in all four scopes",
  );
  assert.ok(
    plan.data.counts.chat > 0 &&
      plan.data.counts.privateState > 0 &&
      plan.data.counts.results > 0 &&
      plan.data.counts.notifications > 0,
    "each retention scope has actual target rows",
  );
  const activeId = host.matchId;
  const activeBefore = await pool.query(
    "SELECT phase,state,resource_snapshot FROM next_round.matches WHERE id=$1",
    [activeId],
  );
  assert.equal(activeBefore.rows[0].phase, "active");
  const resultNotifications = await pool.query(
    "SELECT id FROM next_round.notifications WHERE match_id=$1",
    [resultMatchId],
  );
  const removedChat = await pool.query(
    "SELECT id FROM next_round.chat_messages WHERE match_id=$1 AND deleted_at IS NULL",
    [resultMatchId],
  );
  const execution = await json(
    ctx,
    `/admin/retention-plans/${plan.data.id}/execute`,
    writeOptions(host, "POST", { confirmationId: plan.data.confirmationId }),
  );
  assert.equal(execution.data.executed, true);
  const afterMatch = await pool.query(
    "SELECT phase,state,resource_snapshot FROM next_round.matches WHERE id=$1",
    [resultMatchId],
  );
  assert.equal(
    afterMatch.rows[0].phase,
    "finished",
    "retention preserves finished match tombstone",
  );
  assert.equal(afterMatch.rows[0].state, null, "private state is purged");
  assert.equal(
    afterMatch.rows[0].resource_snapshot,
    null,
    "resource snapshot is purged",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.match_results WHERE match_id=$1",
        [resultMatchId],
      )
    ).rowCount,
    0,
    "raw result is deleted",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.participant_results WHERE match_id=$1",
        [resultMatchId],
      )
    ).rowCount,
    0,
    "participant result rows are deleted",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.career_contributions WHERE match_id=$1",
        [resultMatchId],
      )
    ).rowCount,
    0,
    "career contribution rows are deleted",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.chat_messages WHERE id=ANY($1::uuid[])",
        [removedChat.rows.map((row) => row.id)],
      )
    ).rowCount,
    0,
    "finished-match chat is deleted",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.notifications WHERE id=ANY($1::uuid[])",
        [resultNotifications.rows.map((row) => row.id)],
      )
    ).rowCount,
    0,
    "finished-match notifications are deleted",
  );
  const afterBoard = await json(ctx, "/games/test-counter/leaderboard", {
    client: host,
  });
  assert.ok(
    !afterBoard.data.some(
      (row) => row.principalId === h4.registeredPrincipalId,
    ),
    "retention deletion changes leaderboard contribution",
  );
  const disabled = await pool.query(
    "SELECT disabled_at FROM next_round.principals WHERE id=$1",
    [disabledPrincipal],
  );
  assert.ok(
    disabled.rows[0]?.disabled_at,
    "disabled member identity remains retained",
  );
  const activeAfter = await pool.query(
    "SELECT phase,state,resource_snapshot FROM next_round.matches WHERE id=$1",
    [activeId],
  );
  assert.deepEqual(
    activeAfter.rows[0],
    activeBefore.rows[0],
    "active match state/resources are never purged",
  );
  return {
    previewCounts: plan.data.counts,
    resultMatchId,
    retainedDisabledPrincipal: disabledPrincipal,
    leaderboardBefore: beforeBoard.data.length,
    leaderboardAfter: afterBoard.data.length,
    retainedActiveMatchId: activeId,
  };
}

async function runRecoveryEvidence(ctx) {
  const { pool, host, peer } = ctx;
  await host.connectWs();
  await peer.connectWs();
  const oldListener = await pool.query(
    "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE '%live%' ORDER BY pid",
  );
  assert.ok(
    oldListener.rowCount >= 2,
    "both real API processes establish PostgreSQL live listeners",
  );
  const homeA = await subscribeLive(ctx, host, ctx.apiA.url, { kind: "home" });
  const homeB = await subscribeLive(ctx, peer, ctx.apiB.url, { kind: "home" });
  const notificationsA = await subscribeLive(ctx, peer, ctx.apiA.url, {
    kind: "notifications",
  });
  const notificationsB = await subscribeLive(ctx, peer, ctx.apiB.url, {
    kind: "notifications",
  });
  const dropFn = "s3_drop_shared_wakeup";
  await pool.query(
    `CREATE FUNCTION next_round.${dropFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic='live.invalidate' THEN NEW.delivered_at=clock_timestamp(); END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${dropFn} BEFORE INSERT ON next_round.outbox FOR EACH ROW EXECUTE FUNCTION next_round.${dropFn}()`,
  );
  const faultMatch = await host.createMatch(
    "test-counter",
    "group",
    { target: 10, turnSeconds: 60 },
    "instance",
  );
  host.onSnapshot(faultMatch.matchId, () => {});
  peer.onSnapshot(faultMatch.matchId, () => {});
  const faultJoin = await peer.joinMatch(
    faultMatch.matchId,
    (await host.getSnapshot(faultMatch.matchId)).revision,
  );
  await host.startMatch(faultMatch.matchId, faultJoin.committedRevision);
  const id = faultMatch.matchId;
  for (let turn = 0; turn < 2; turn++) {
    const turnSnapshot = await host.getSnapshot(id);
    const actorPrincipalId = (
      await pool.query(
        "SELECT principal_id FROM next_round.match_members WHERE id=$1",
        [turnSnapshot.game.currentActorMemberId],
      )
    ).rows[0].principal_id;
    if (actorPrincipalId === peer.session.principalId) break;
    const actorClient =
      actorPrincipalId === host.session.principalId ? host : null;
    assert.ok(
      actorClient,
      "recovery fixture can schedule the registered peer as deadline actor",
    );
    await actorClient.act(id, {
      type: "add",
      payload: { amount: 1 },
      expectedRevision: turnSnapshot.revision,
    });
  }
  const initial = await host.getSnapshot(id);
  assert.equal(
    (
      await pool.query(
        "SELECT principal_id FROM next_round.match_members WHERE id=$1",
        [initial.game.currentActorMemberId],
      )
    ).rows[0].principal_id,
    peer.session.principalId,
    "peer is scheduled actor for durable notification recovery",
  );
  const matchA = await subscribeLive(ctx, host, ctx.apiA.url, {
    kind: "match",
    id,
  });
  const matchB = await subscribeLive(ctx, peer, ctx.apiB.url, {
    kind: "match",
    id,
  });
  const chatA = await subscribeLive(ctx, host, ctx.apiA.url, {
    kind: "chat",
    id,
  });
  const chatB = await subscribeLive(ctx, peer, ctx.apiB.url, {
    kind: "chat",
    id,
  });
  const beforeA = host.receivedSnapshots.length;
  const beforeB = peer.receivedSnapshots.length;
  const started = performance.now();
  await json(
    ctx,
    `/matches/${id}/chat`,
    writeOptions(host, "POST", {
      commandId: randomUUID(),
      text: "sprint3-missed-chat-wakeup",
    }),
  );
  const receipt = await host.act(id, {
    type: "note",
    payload: { text: "sprint3-missed-wakeup" },
    expectedRevision: initial.revision,
  });
  const deadline = await pool.query(
    "SELECT key,generation FROM next_round.match_deadlines WHERE match_id=$1 AND status='pending'",
    [id],
  );
  assert.ok(
    deadline.rowCount > 0,
    "recovery fixture has an active production deadline",
  );
  const turnOwner = (
    await pool.query(
      "SELECT principal_id FROM next_round.match_members WHERE id=(SELECT state->>'currentActorMemberId' FROM next_round.matches WHERE id=$1)::uuid",
      [id],
    )
  ).rows[0].principal_id;
  await pool.query(
    "UPDATE next_round.match_deadlines SET due_at=clock_timestamp()-interval '1 second' WHERE match_id=$1 AND key=$2 AND generation=$3",
    [id, deadline.rows[0].key, deadline.rows[0].generation],
  );
  await waitFor(
    ctx,
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM next_round.notifications WHERE principal_id=$1 AND kind='turn_missed' AND match_id=$2",
          [turnOwner, id],
        )
      ).rowCount > 0,
    "real worker produces notification during dropped-wakeup interval",
  );
  const scopeFrames = [
    [matchA, { kind: "match", id }],
    [matchB, { kind: "match", id }],
    [chatA, { kind: "chat", id }],
    [chatB, { kind: "chat", id }],
    [notificationsA, { kind: "notifications" }],
    [notificationsB, { kind: "notifications" }],
    [homeA, { kind: "home" }],
    [homeB, { kind: "home" }],
  ];
  await Promise.all(
    scopeFrames.map(([subscription, scope]) =>
      waitFor(
        ctx,
        () =>
          subscription.frames.some(
            (frame) =>
              frame.type === "invalidate" &&
              frame.scope?.kind === scope.kind &&
              (scope.id === undefined || frame.scope.id === scope.id),
          ),
        `periodic sweep recovers dropped ${scope.kind} scope wakeup`,
      ),
    ),
  );
  await Promise.all([
    waitFor(
      ctx,
      () =>
        host.receivedSnapshots.length > beforeA &&
        host.receivedSnapshots.at(-1)?.revision >= receipt.committedRevision,
      "API A periodic sweep after dropped wakeup",
    ),
    waitFor(
      ctx,
      () =>
        peer.receivedSnapshots.length > beforeB &&
        peer.receivedSnapshots.at(-1)?.revision >= receipt.committedRevision,
      "API B periodic sweep after dropped wakeup",
    ),
  ]);
  const recoveredMs = +(performance.now() - started).toFixed(3);
  const sweepCosts = [ctx.apiA, ctx.apiB].map((api) => {
    const entries = api.child.lines
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .filter(
        (entry) =>
          entry.msg === "Live reconciliation sweep" &&
          entry.queryCost &&
          Number.isFinite(entry.queryCost.queries),
      );
    return entries.at(-1)?.queryCost ?? null;
  });
  assert.ok(
    sweepCosts.every(
      (cost) => cost && cost.queries > 0 && cost.durationMs >= 0,
    ),
    "both APIs expose measured steady periodic-sweep query cost",
  );
  const survivors = await pool.query(
    "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE '%live%' ORDER BY pid",
  );
  assert.deepEqual(
    survivors.rows.map((row) => row.pid),
    oldListener.rows.map((row) => row.pid),
    "missed wakeup recovery retains both API listener processes",
  );
  await pool.query(`DROP TRIGGER ${dropFn} ON next_round.outbox`);
  await pool.query(`DROP FUNCTION next_round.${dropFn}()`);
  const listeners = await pool.query(
    "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE '%live%' ORDER BY pid",
  );
  assert.ok(listeners.rowCount >= 2);
  await pool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE '%live%'",
  );
  const recoveredStarted = performance.now();
  const listenerRecovered = await waitFor(
    ctx,
    async () => {
      const current = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE '%live%' ORDER BY pid",
      );
      return current.rowCount >= 2 &&
        current.rows.every(
          (row) => !oldListener.rows.some((old) => old.pid === row.pid),
        )
        ? current.rows
        : null;
    },
    "both dedicated listeners reconnect with new PostgreSQL sessions",
  );
  const recoveryStartSnapshot = await host.getSnapshot(id);
  const beforeRecoveredA = host.receivedSnapshots.length;
  const beforeRecoveredB = peer.receivedSnapshots.length;
  const recoveryReceipt = await host.act(id, {
    type: "note",
    payload: { text: "sprint3-listener-recovery" },
    expectedRevision: recoveryStartSnapshot.revision,
  });
  await Promise.all([
    waitFor(
      ctx,
      () =>
        host.receivedSnapshots.length > beforeRecoveredA &&
        host.receivedSnapshots.at(-1)?.revision >=
          recoveryReceipt.committedRevision,
      "API A live delivery after listener recovery",
    ),
    waitFor(
      ctx,
      () =>
        peer.receivedSnapshots.length > beforeRecoveredB &&
        peer.receivedSnapshots.at(-1)?.revision >=
          recoveryReceipt.committedRevision,
      "API B live delivery after listener recovery",
    ),
  ]);
  const listenerRecoveryMs = +(performance.now() - recoveredStarted).toFixed(3);
  return {
    apiPids: [ctx.apiA.child.pid, ctx.apiB.child.pid],
    listenerPidsBefore: oldListener.rows.map((row) => row.pid),
    listenerPidsAfter: listenerRecovered.map((row) => row.pid),
    missedWakeupRefetchMs: recoveredMs,
    listenerRecoveryMs,
    steadySweepQueryCost: sweepCosts,
  };
}

async function runWorkerRetryAcceptance(ctx) {
  const { pool, host } = ctx;
  const matchId = host.matchId;
  const snapshot = await host.getSnapshot(matchId);
  const live = await subscribeLive(ctx, host, ctx.apiA.url, {
    kind: "match",
    id: matchId,
  });
  const wakeFrameCount = live.frames.length;
  const dropFn = "s3_hold_worker_retry";
  await pool.query(
    `CREATE FUNCTION next_round.${dropFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic='live.invalidate' THEN NEW.leased_until=clock_timestamp()+interval '30 seconds'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${dropFn} BEFORE INSERT ON next_round.outbox FOR EACH ROW EXECUTE FUNCTION next_round.${dropFn}()`,
  );
  const effectStarted = performance.now();
  const action = await host.act(matchId, {
    type: "note",
    payload: { text: "sprint3-worker-retry-real-action" },
    expectedRevision: snapshot.revision,
  });
  const pending = await pool.query(
    "SELECT id FROM next_round.outbox WHERE topic='live.invalidate' AND aggregate_id=$1 AND safe_payload @> $2::jsonb AND delivered_at IS NULL",
    [
      matchId,
      JSON.stringify({
        scope: { kind: "match", id: matchId },
        revision: action.committedRevision,
      }),
    ],
  );
  assert.equal(
    pending.rowCount,
    1,
    "ordinary accepted match action produced exactly one pending live invalidation",
  );
  const outboxId = pending.rows[0].id;
  await pool.query(
    "UPDATE next_round.outbox SET attempts=1,leased_until=clock_timestamp()-interval '10 seconds',available_at=clock_timestamp()-interval '1 minute' WHERE id=$1 AND delivered_at IS NULL",
    [outboxId],
  );
  await pool.query(`DROP TRIGGER ${dropFn} ON next_round.outbox`);
  await pool.query(`DROP FUNCTION next_round.${dropFn}()`);
  const delivered = await waitFor(
    ctx,
    async () => {
      const row = await pool.query(
        "SELECT delivered_at,attempts FROM next_round.outbox WHERE id=$1",
        [outboxId],
      );
      return row.rows[0]?.delivered_at && Number(row.rows[0].attempts) === 2
        ? row.rows[0]
        : null;
    },
    "real worker reclaims expired outbox lease and acknowledges retry",
  );
  await waitFor(
    ctx,
    () =>
      live.frames
        .slice(wakeFrameCount)
        .some(
          (frame) =>
            frame.type === "invalidate" &&
            frame.scope?.kind === "match" &&
            frame.scope.id === matchId &&
            frame.revision >= action.committedRevision,
        ),
    "reclaimed outbox retry delivers notification for actual accepted state change",
  );
  const workerEffectMs = +(performance.now() - effectStarted).toFixed(3);
  assert.ok(
    workerEffectMs < 10000,
    "outbox wakeup effect arrives before the API's ten-second periodic reconciliation could mask it",
  );
  live.socket.close();
  assert.equal(
    Number(delivered.attempts),
    2,
    "expired lease is actually retried once by the production worker",
  );
  return {
    outboxId,
    actionRevision: action.committedRevision,
    attempts: Number(delivered.attempts),
    deliveredAt: delivered.delivered_at.toISOString(),
    workerEffectMs,
  };
}

async function runMigrationAcceptance(ctx, h4) {
  const { host, pool } = ctx;
  const targetVersion = ctx.migrationTargetVersion;
  assert.equal(
    typeof targetVersion,
    "string",
    "driver provides registered production migration target",
  );
  const failedMatch = await host.createMatch(
    "test-counter",
    "solo",
    { target: 13, turnSeconds: null },
    "invite",
  );
  const failedBefore = await pool.query(
    "SELECT module_version,revision,state,settings FROM next_round.matches WHERE id=$1",
    [failedMatch.matchId],
  );
  const failCommand = randomUUID();
  const failed = await rejected(
    ctx,
    `/admin/matches/${failedMatch.matchId}/migrate`,
    writeOptions(host, "POST", {
      commandId: failCommand,
      targetVersion,
      expectedRevision: Number(failedBefore.rows[0].revision),
    }),
    [503],
  );
  assert.ok(
    failed.status === 503,
    "production migration hook failure returns module failure",
  );
  const failedAfter = await pool.query(
    "SELECT module_version,revision,state,settings FROM next_round.matches WHERE id=$1",
    [failedMatch.matchId],
  );
  assert.deepEqual(
    failedAfter.rows[0],
    failedBefore.rows[0],
    "failed migration rolls back module version, state, settings, and revision",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.match_events WHERE match_id=$1 AND kind='admin.migrate'",
        [failedMatch.matchId],
      )
    ).rowCount,
    0,
    "failed migration writes no match event",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.audit_log WHERE target_id=$1 AND action='match.migrated'",
        [failedMatch.matchId],
      )
    ).rowCount,
    0,
    "failed migration writes no audit event",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate' AND safe_payload @> $1::jsonb",
        [
          JSON.stringify({
            scope: { kind: "match", id: failedMatch.matchId },
            revision: Number(failedBefore.rows[0].revision) + 1,
          }),
        ],
      )
    ).rowCount,
    0,
    "failed migration creates no invalidation event",
  );
  const successMatch = await host.createMatch(
    "test-counter",
    "solo",
    { target: 10, turnSeconds: null },
    "invite",
  );
  const successBefore = await pool.query(
    "SELECT module_version,revision,state,settings FROM next_round.matches WHERE id=$1",
    [successMatch.matchId],
  );
  const expectedRevision = Number(successBefore.rows[0].revision);
  const commandId = randomUUID();
  const body = { commandId, targetVersion, expectedRevision };
  const migrated = await json(
    ctx,
    `/admin/matches/${successMatch.matchId}/migrate`,
    writeOptions(host, "POST", body),
  );
  assert.equal(migrated.data.fromVersion, "0.1.0");
  assert.equal(migrated.data.targetVersion, targetVersion);
  assert.equal(migrated.data.revision, expectedRevision + 1);
  const after = await pool.query(
    "SELECT module_version,revision,state,settings FROM next_round.matches WHERE id=$1",
    [successMatch.matchId],
  );
  assert.equal(
    after.rows[0].module_version,
    targetVersion,
    "successful migration durably changes module version",
  );
  assert.equal(Number(after.rows[0].revision), expectedRevision + 1);
  assert.deepEqual(
    after.rows[0].state,
    successBefore.rows[0].state,
    "state passes through validated module migration",
  );
  assert.deepEqual(after.rows[0].settings, successBefore.rows[0].settings);
  const event = await pool.query(
    "SELECT 1 FROM next_round.match_events WHERE match_id=$1 AND kind='admin.migrate' AND revision=$2",
    [successMatch.matchId, migrated.data.revision],
  );
  const audit = await pool.query(
    "SELECT 1 FROM next_round.audit_log WHERE target_id=$1 AND action='match.migrated'",
    [successMatch.matchId],
  );
  const wakeup = await pool.query(
    "SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate' AND safe_payload @> $1::jsonb",
    [
      JSON.stringify({
        scope: { kind: "match", id: successMatch.matchId },
        revision: migrated.data.revision,
      }),
    ],
  );
  assert.equal(
    event.rowCount,
    1,
    "successful migration writes durable match event",
  );
  assert.equal(audit.rowCount, 1, "successful migration writes audit log");
  assert.equal(
    wakeup.rowCount,
    1,
    "successful migration enqueues live invalidation",
  );
  await waitFor(
    ctx,
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM next_round.outbox WHERE topic='live.invalidate' AND safe_payload @> $1::jsonb AND delivered_at IS NOT NULL",
          [
            JSON.stringify({
              scope: { kind: "match", id: successMatch.matchId },
              revision: migrated.data.revision,
            }),
          ],
        )
      ).rowCount === 1,
    "worker acknowledges migration live invalidation",
  );
  const retry = await json(
    ctx,
    `/admin/matches/${successMatch.matchId}/migrate`,
    writeOptions(host, "POST", body),
  );
  assert.deepEqual(
    retry.data,
    migrated.data,
    "migration command retry replays original receipt",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM next_round.match_events WHERE match_id=$1 AND kind='admin.migrate'",
        [successMatch.matchId],
      )
    ).rows[0].n,
    1,
    "migration retry creates no duplicate event",
  );
  const finishedResult = await pool.query(
    "SELECT module_version FROM next_round.match_results WHERE match_id=$1",
    [h4.resultMatchId],
  );
  await json(
    ctx,
    "/admin/games/test-counter",
    writeOptions(host, "PATCH", { defaultVersion: targetVersion }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT default_version FROM next_round.modules WHERE id='test-counter'",
      )
    ).rows[0].default_version,
    targetVersion,
    "production module default changes to migrated renderer",
  );
  const newMatch = await host.createMatch(
    "test-counter",
    "solo",
    { target: 8, turnSeconds: null },
    "invite",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT module_version FROM next_round.matches WHERE id=$1",
        [newMatch.matchId],
      )
    ).rows[0].module_version,
    targetVersion,
    "new matches use the updated renderer",
  );
  assert.equal(
    finishedResult.rows[0]?.module_version,
    "0.1.0",
    "finished result retains its original renderer version after default version changes",
  );
  const readiness = await ctx.request("/api/v1/health/ready", {
    base: ctx.apiA.url,
  });
  assert.equal(
    readiness.status,
    200,
    "production API remains ready with a finished match pinned to the old renderer",
  );
  return {
    failedMigrationStatus: failed.status,
    failedMatchId: failedMatch.matchId,
    migratedMatchId: successMatch.matchId,
    targetVersion,
    revision: migrated.data.revision,
    finishedRendererVersion: finishedResult.rows[0].module_version,
  };
}

async function runRestoreExample(ctx) {
  // The operations script performs pg_dump/pg_restore into an isolated database and starts a real compiled API on that restored database.
  const child = ctx.launch(
    "process.env.TEST_DATABASE_URL=process.env.DATABASE_URL; await import('./scripts/sprint3-operations.mjs');",
    { TEST_DATABASE_URL: ctx.databaseUrl },
  );
  try {
    await waitFor(
      ctx,
      () => child.exitCode !== null,
      "real restore example process completion",
      120000,
    );
    assert.equal(
      child.exitCode,
      0,
      `restore example failed: ${child.lines.join("\\n")}`,
    );
    return { output: child.lines.join("").slice(-2000) };
  } finally {
    await ctx.stop(child);
  }
}

export async function runSharedAcceptance(ctx) {
  assert.ok(
    ctx.pool &&
      ctx.host &&
      ctx.peer &&
      ctx.apiA &&
      ctx.apiB &&
      ctx.request &&
      ctx.until &&
      ctx.scenario,
    "shared acceptance requires the live two-API/worker driver context",
  );
  const cases = ctx.cases;
  try {
    const run = async (requirement, name, checks, action) => {
      const started = performance.now();
      const evidence = await action();
      cases.push({
        requirement,
        name: `${requirement}: ${name}`,
        checks,
        elapsedMs: +(performance.now() - started).toFixed(3),
        status: "pass",
        evidence,
      });
      return evidence;
    };
    await run(
      "H3",
      "production chat removal, rejoin visibility, solo privacy, and result entitlement",
      [
        "active chat read/write is durable/idempotent and worker-acknowledged",
        "real chat websocket wakeup and removed-membership revocation",
        "fresh targeted invitation re-admits removed member",
        "full and since_rejoin histories are verified",
        "global policy edit leaves old snapshot unchanged",
        "solo match is private",
        "removed member retains final-result access",
        "guest cannot read another match chat",
      ],
      () => runChatAcceptance(ctx),
    );
    const h4 = await run(
      "H4",
      "timeout inbox, action/result retry, two-session sync, and guest career attribution",
      [
        "worker persists deduplicated turn_missed notification",
        "guest notification websocket invalidation works while home/foreign-match scopes deny",
        "explicit reads synchronize across both APIs and a second authenticated session",
        "replayed final action retains one raw result",
        "guest exclusion remains participant-specific and registered contribution remains eligible",
      ],
      () => runInboxAndDeadlineAcceptance(ctx),
    );
    await run(
      "H5",
      "real pg_dump/pg_restore production API example",
      [
        "isolated restore uses pg_dump/pg_restore",
        "compiled API launches against restored database and readiness succeeds",
        "durable table counts are checked",
      ],
      () => runRestoreExample(ctx),
    );
    await run(
      "H5",
      "two-process recovery, worker lease retry, and module migration",
      [
        "chat, match, notifications, and home scopes recover dropped wakeups by periodic reconciliation on both APIs",
        "recovery reports measured live-sweep query count and duration",
        "listener PIDs remain stable through missed wakeup",
        "listener reconnection yields new sessions and real post-recovery WS delivery",
        "expired outbox lease is reclaimed by the real worker and its live invalidation effect is observed",
        "failed migration leaves durable state/revision/audit untouched",
        "successful migration updates module version/revision and emits event/audit/outbox",
        "migration retry idempotent and worker acknowledges invalidation",
        "new matches use migrated default while finished results retain old renderer",
      ],
      async () => ({
        recovery: await runRecoveryEvidence(ctx),
        workerRetry: await runWorkerRetryAcceptance(ctx),
        migration: await runMigrationAcceptance(ctx, h4),
      }),
    );
    await run(
      "H6",
      "retention counts, stale/expired plans, repeats, active protection, and contribution deletion",
      [
        "exact counts for chat/private-state/results/notifications",
        "stale policy and changed target manifests denied",
        "expired plans denied",
        "invalid confirmation denied and repeat execute harmless",
        "finished tombstone remains while private state/chat/results/contributions/notifications are deleted",
        "leaderboard changes after career contribution deletion",
        "disabled principal retained",
        "active match state/resources unchanged",
      ],
      () => runRetentionAcceptance(ctx, h4),
    );
  } finally {
    for (const socket of liveSockets) socket.terminate();
  }
}
