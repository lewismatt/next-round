// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseJsonSchemaValue } from "@next-round/contracts";
import type {
  GameEvent,
  Member,
  RuleContext,
  Transition,
} from "@next-round/game-sdk";
import { manifest } from "./manifest.js";
import { server } from "./server.js";
import type { TriviaBank, TriviaState } from "./types.js";

const member = (id: string): Member => ({
  id,
  principalId: `principal-${id}`,
  kind: "registered",
  displayName: id,
  status: "active",
  joinOrdinal: Number(id.slice(1)),
  disabled: false,
  accessEpoch: 1,
});
const bank: TriviaBank = {
  format: "next-round.trivia/1",
  title: "Fixture",
  attribution: "Fixture author",
  license: "CC0-1.0",
  questions: [
    {
      id: "first",
      prompt: "First public prompt",
      choices: ["Zero", "One"],
      correctChoice: 1,
      explanation: "First secret explanation",
    },
    {
      id: "second",
      prompt: "Second hidden prompt",
      choices: ["Two", "Three"],
      correctChoice: 0,
      explanation: "Second secret explanation",
    },
  ],
};

function fixture(rounds = 2) {
  let ctx: RuleContext = {
    matchId: "match",
    moduleVersion: "0.1.0",
    mode: "group",
    phase: null,
    revision: 0,
    now: "2026-10-24T00:00:00.000Z",
    eventId: "event",
    actor: { principalId: "principal-m1", memberId: "m1" },
    members: [member("m1"), member("m2")],
    hostMemberId: "m1",
    settings: { rounds, secondsPerRound: 30 },
    resource: { id: "resource", identity: "identity", version: 1, data: bank },
    facts: [],
  };
  let state: TriviaState | null = null;
  function step(event: GameEvent): Transition<TriviaState> {
    const result = server.transition(ctx, state, event);
    if (!result.ok) throw new Error(result.error.code);
    parseJsonSchemaValue(manifest.stateSchema, result.value.state);
    if (result.value.final)
      parseJsonSchemaValue(manifest.resultSchema, result.value.final.data);
    state = result.value.state;
    ctx = {
      ...ctx,
      phase: result.value.phase,
      hostMemberId: result.value.hostMemberId,
      revision: ctx.revision + 1,
    };
    return result.value;
  }
  step({ kind: "create" });
  return {
    get ctx() {
      return ctx;
    },
    get state() {
      return state!;
    },
    step,
    patch(values: Partial<RuleContext>) {
      ctx = { ...ctx, ...values };
    },
    actor(id: string) {
      ctx = { ...ctx, actor: { memberId: id, principalId: `principal-${id}` } };
    },
    status(id: string, disabled: boolean) {
      ctx = {
        ...ctx,
        members: ctx.members.map((m) => (m.id === id ? { ...m, disabled } : m)),
      };
      return step({ kind: "principal_status", memberId: id, disabled });
    },
    view(id: string) {
      const view = server.view(ctx, state!, {
        memberId: id,
        principalId: `principal-${id}`,
        access: "active",
      });
      parseJsonSchemaValue(manifest.viewSchema, view);
      return view;
    },
  };
}

describe("simultaneous trivia rules", () => {
  it("holds the deadline until reveal and never leaks another answer or a future question", () => {
    const f = fixture();
    const start = f.step({ kind: "start" });
    expect(start.needsActionFrom).toEqual(["m1", "m2"]);
    const after = f.step({
      kind: "action",
      type: "submit",
      payload: { roundIndex: 0, choice: 1 },
    });
    expect(after.deadlines).toEqual(start.deadlines);
    expect(after.needsActionFrom).toEqual(["m2"]);
    expect(f.view("m1").myChoice).toBe(1);
    expect(f.view("m2").myChoice).toBeNull();
    expect(f.view("m2").question).toEqual({
      id: "first",
      prompt: "First public prompt",
      choices: ["Zero", "One"],
    });
    expect(JSON.stringify(f.view("m2"))).not.toMatch(
      /correctChoice|secret explanation|Second hidden|identity|answers/,
    );
    expect(
      server.transition(f.ctx, f.state, {
        kind: "action",
        type: "submit",
        payload: { roundIndex: 0, choice: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: "ALREADY_SUBMITTED" } });
    f.actor("m2");
    f.step({
      kind: "action",
      type: "submit",
      payload: { roundIndex: 0, choice: 0 },
    });
    f.patch({ now: start.deadlines[0].dueAt });
    const reveal = f.step({ kind: "deadline", deadline: start.deadlines[0] });
    expect(reveal.state.scores).toEqual({ m1: 1, m2: 0 });
    expect(f.view("m2").reveals[0]).toMatchObject({
      correctChoice: 1,
      explanation: "First secret explanation",
      answers: { m1: 1, m2: 0 },
    });
    expect(f.view("m1").myChoice).toBeNull();
    expect(
      server.transition(f.ctx, f.state, {
        kind: "action",
        type: "submit",
        payload: { roundIndex: 0, choice: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: "WRONG_ROUND" } });
  });

  it("preserves answers and remaining time while disabled, and fences late joins/rejoins", () => {
    const f = fixture();
    const start = f.step({ kind: "start" });
    f.step({
      kind: "action",
      type: "submit",
      payload: { roundIndex: 0, choice: 1 },
    });
    f.patch({ now: "2026-10-24T00:00:05.000Z" });
    expect(f.status("m1", true).deadlines).toEqual(start.deadlines);
    const paused = f.status("m2", true);
    expect(paused.deadlines).toEqual([]);
    expect(paused.needsActionFrom).toEqual([]);
    expect(paused.state).toMatchObject({
      suspended: true,
      suspendedRemainingMs: 25000,
      answers: { m1: 1 },
    });
    f.patch({ now: "2026-10-24T00:05:00.000Z" });
    const resumed = f.status("m2", false);
    expect(resumed.deadlines).toEqual([
      { key: "round", generation: 2, dueAt: "2026-10-24T00:05:25.000Z" },
    ]);
    expect(resumed.state.answers).toEqual({ m1: 1 });
    f.patch({ members: [...f.ctx.members, member("m3")] });
    const joined = f.step({ kind: "join", memberId: "m3", rejoin: false });
    expect(joined.deadlines).toEqual(resumed.deadlines);
    expect(f.view("m3").canSubmit).toBe(false);
    f.patch({
      members: f.ctx.members.map((m) =>
        m.id === "m2" ? { ...m, status: "left" } : m,
      ),
    });
    f.step({ kind: "leave", memberId: "m2", reason: "left" });
    f.patch({
      members: f.ctx.members.map((m) =>
        m.id === "m2" ? { ...m, status: "active" } : m,
      ),
    });
    f.step({ kind: "join", memberId: "m2", rejoin: true });
    expect(f.view("m2").canSubmit).toBe(false);
    f.patch({ now: resumed.deadlines[0].dueAt });
    const next = f.step({ kind: "deadline", deadline: resumed.deadlines[0] });
    expect(next.needsActionFrom).toEqual(["m2", "m3"]);
    expect(next.state.scores.m1).toBe(1);
  });

  it("projects complete results without resource/state and does not score an unfinished round", () => {
    const f = fixture(1);
    const start = f.step({ kind: "start" });
    f.step({
      kind: "action",
      type: "submit",
      payload: { roundIndex: 0, choice: 1 },
    });
    f.patch({ now: start.deadlines[0].dueAt });
    const final = f.step({
      kind: "deadline",
      deadline: start.deadlines[0],
    }).final!;
    expect(final).toMatchObject({
      outcome: "completed",
      data: { roundsPlayed: 1, winners: ["m1"] },
      participants: [
        { memberId: "m1", score: 1, win: true, careerEligible: true },
        { memberId: "m2", score: 0, win: false, careerEligible: true },
      ],
    });
    const projection = server.resultView(
      { ...f.ctx, resource: null },
      final,
      "principal-m1",
    );
    expect(JSON.stringify(projection)).not.toMatch(
      /secret explanation|correctChoice|answers|prompt/,
    );
    expect(server.career(final)).toEqual([
      { memberId: "m1", points: 1, played: 1, wins: 1 },
      { memberId: "m2", points: 0, played: 1, wins: 0 },
    ]);
    const early = fixture();
    early.step({ kind: "start" });
    early.step({
      kind: "action",
      type: "submit",
      payload: { roundIndex: 0, choice: 1 },
    });
    const ended = early.step({ kind: "finish", reason: "host_ended" }).final!;
    expect(ended.data).toMatchObject({ roundsPlayed: 0, winners: [] });
    expect(
      ended.participants.every((p) => p.score === 0 && !p.careerEligible),
    ).toBe(true);
    expect(server.career(ended)).toEqual([]);
  });
});
