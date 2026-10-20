// SPDX-License-Identifier: Apache-2.0
import { assert, expect, it } from "vitest";
import type { Member, RuleContext } from "@next-round/game-sdk";
import { server, type CounterState } from "./server.js";

const members: Member[] = [
  {
    id: "a",
    principalId: "principal-a",
    kind: "registered",
    displayName: "A",
    status: "active",
    joinOrdinal: 1,
    disabled: false,
    accessEpoch: 0,
  },
  {
    id: "b",
    principalId: "principal-b",
    kind: "registered",
    displayName: "B",
    status: "active",
    joinOrdinal: 2,
    disabled: false,
    accessEpoch: 0,
  },
];
const context: RuleContext = {
  matchId: "match",
  moduleVersion: "0.1.0",
  mode: "group",
  phase: "active",
  revision: 3,
  now: "2026-10-20T12:00:00.000Z",
  eventId: "status-event",
  actor: null,
  members,
  hostMemberId: "a",
  settings: { target: 10, turnSeconds: 10 },
  resource: null,
  facts: [],
};
const state: CounterState = {
  count: 3,
  target: 10,
  turnSeconds: 10,
  scores: { a: 2, b: 1 },
  notes: { a: "retained note", b: "" },
  markers: { a: "marker-a", b: "marker-b" },
  turnOrder: ["a", "b"],
  currentActorMemberId: "a",
  deadlineGeneration: 3,
};

it("skips disabled actors, suspends all-disabled play, and resumes without losing progress", () => {
  const oneDisabled = [{ ...members[0]!, disabled: true }, members[1]!];
  const skipped = server.transition(
    { ...context, members: oneDisabled },
    state,
    { kind: "principal_status", memberId: "a", disabled: true },
  );
  assert(skipped.ok);
  expect(skipped.value.state.currentActorMemberId).toBe("b");
  expect(skipped.value.needsActionFrom).toEqual(["b"]);
  const allDisabled = oneDisabled.map((member) => ({
    ...member,
    disabled: true,
  }));
  const suspended = server.transition(
    { ...context, members: allDisabled },
    skipped.value.state,
    { kind: "principal_status", memberId: "b", disabled: true },
  );
  assert(suspended.ok);
  expect(suspended.value.phase).toBe("active");
  expect(suspended.value.final).toBeNull();
  expect(suspended.value.deadlines).toEqual([]);
  expect(suspended.value.needsActionFrom).toEqual([]);
  expect(suspended.value.state.currentActorMemberId).toBeNull();
  const resumed = server.transition(
    { ...context, members: oneDisabled },
    suspended.value.state,
    { kind: "principal_status", memberId: "b", disabled: false },
  );
  assert(resumed.ok);
  expect(resumed.value.state).toMatchObject({
    count: 3,
    scores: state.scores,
    notes: state.notes,
    currentActorMemberId: "b",
  });
  expect(resumed.value.deadlines).toEqual([
    { key: "turn", generation: 6, dueAt: "2026-10-20T12:00:10.000Z" },
  ]);
  expect(resumed.value.final).toBeNull();
});

it("does not abandon retained disabled members and admits an enabled late join into suspension", () => {
  const disabledPeer = [members[0]!, { ...members[1]!, disabled: true }];
  const departed = server.transition(
    { ...context, members: disabledPeer },
    state,
    { kind: "leave", memberId: "a", reason: "left" },
  );
  assert(departed.ok);
  expect(departed.value.final).toBeNull();
  expect(departed.value.phase).toBe("active");
  expect(departed.value.hostMemberId).toBe("b");
  expect(departed.value.deadlines).toEqual([]);
  expect(departed.value.state.currentActorMemberId).toBeNull();
  const incoming: Member = {
    ...members[0]!,
    id: "c",
    principalId: "principal-c",
    joinOrdinal: 3,
  };
  const joined = server.transition(
    {
      ...context,
      hostMemberId: "b",
      members: [{ ...members[0]!, status: "left" }, disabledPeer[1]!, incoming],
    },
    departed.value.state,
    { kind: "join", memberId: "c", rejoin: false },
  );
  assert(joined.ok);
  expect(joined.value.state.currentActorMemberId).toBe("c");
  expect(joined.value.deadlines).toEqual([
    { key: "turn", generation: 5, dueAt: "2026-10-20T12:00:10.000Z" },
  ]);
  expect(joined.value.state.scores).toEqual({ a: 2, b: 1, c: 0 });
});
