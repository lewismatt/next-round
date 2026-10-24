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
import { feedback, server } from "./server.js";
import type { CipherSettings, CipherState } from "./types.js";

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

function fixture(
  settings: CipherSettings = { preset: "standard", turnSeconds: 3600 },
  mode: "group" | "solo" = "group",
) {
  let ctx: RuleContext = {
    matchId: "match-cipher",
    moduleVersion: "0.1.0",
    mode,
    phase: null,
    revision: 0,
    now: "2026-10-24T00:00:00.000Z",
    eventId: "event-create",
    actor: { principalId: "principal-m1", memberId: "m1" },
    members: mode === "solo" ? [member("m1")] : [member("m1"), member("m2")],
    hostMemberId: "m1",
    settings: { ...settings },
    resource: null,
    facts: [],
  };
  let state: CipherState | null = null;
  function step(event: GameEvent): Transition<CipherState> {
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
    guess(id: string, guess: number[]) {
      this.actor(id);
      return step({ kind: "action", type: "guess", payload: { guess } });
    },
    /** A guess that cannot crack: the code with its first symbol rotated. */
    wrongGuess() {
      const code = state!.code;
      const first = (code[0] + 1) % manifestAlphabet(state!);
      return [first, ...code.slice(1)];
    },
  };
}

function manifestAlphabet(state: CipherState): number {
  return Math.max(...state.code) >= 6 ? 8 : 6;
}

describe("cipher feedback", () => {
  it("counts exact first and never double-counts duplicates", () => {
    expect(feedback([1, 1, 2, 3], [1, 2, 1, 1])).toEqual({
      exact: 1,
      misplaced: 2,
    });
    expect(feedback([0, 0, 0, 0], [0, 1, 1, 1])).toEqual({
      exact: 1,
      misplaced: 0,
    });
    expect(feedback([1, 2, 3, 4], [4, 3, 2, 1])).toEqual({
      exact: 0,
      misplaced: 4,
    });
    expect(feedback([5, 5, 5, 5], [5, 5, 5, 5])).toEqual({
      exact: 4,
      misplaced: 0,
    });
  });
});

describe("cipher match flow", () => {
  it("rotates turns, keeps boards private, and never leaks the code", () => {
    const f = fixture();
    const start = f.step({ kind: "start" });
    expect(start.needsActionFrom).toEqual(["m1"]);
    expect(start.deadlines).toHaveLength(1);
    const code = f.state.code;
    const guess = f.wrongGuess();
    const after = f.guess("m1", guess);
    expect(after.needsActionFrom).toEqual(["m2"]);
    expect(f.state.boards.m1).toHaveLength(1);
    expect(f.state.boards.m1[0]).toMatchObject({
      guess,
      exact: code.length - 1,
      misplaced: 0,
    });
    // Privacy: the other player sees counts only — no board, no code.
    const other = f.view("m2");
    expect(other.myBoard).toEqual([]);
    expect(other.players).toEqual([
      { memberId: "m1", guessesUsed: 1, done: false, cracked: false },
      { memberId: "m2", guessesUsed: 0, done: false, cracked: false },
    ]);
    expect(other.reveal).toBeNull();
    expect(JSON.stringify(other)).not.toContain(JSON.stringify(code));
    expect(f.view("m1").myBoard).toHaveLength(1);
    // Out-of-turn play is refused.
    expect(
      server.transition(f.ctx, f.state, {
        kind: "action",
        type: "guess",
        payload: { guess },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_YOUR_TURN" } });
  });

  it("ends the match instantly on a crack and scores by speed", () => {
    const f = fixture();
    f.step({ kind: "start" });
    f.guess("m1", f.wrongGuess());
    f.guess("m2", f.wrongGuess());
    const final = f.guess("m1", [...f.state.code]).final!;
    expect(final.outcome).toBe("completed");
    expect(final.data).toMatchObject({
      preset: "standard",
      winners: ["m1"],
      draw: false,
      guessesUsed: { m1: 2, m2: 1 },
    });
    expect(final.data).toMatchObject({ code: f.state.code });
    expect(final.participants).toEqual([
      expect.objectContaining({
        memberId: "m1",
        score: 9, // cap 10 - 2 guesses + 1
        win: true,
        careerEligible: true,
      }),
      expect.objectContaining({ memberId: "m2", score: 0, win: false }),
    ]);
    expect(server.career(final)).toEqual([
      { memberId: "m1", points: 9, played: 1, wins: 1 },
      { memberId: "m2", points: 0, played: 1, wins: 0 },
    ]);
    // The finished view reveals everything.
    const view = f.view("m2");
    expect(view.reveal?.code).toEqual(f.state.code);
    expect(view.reveal?.boards.m1).toHaveLength(2);
  });

  it("rejects malformed guesses without consuming the turn", () => {
    const f = fixture({ preset: "cadet", turnSeconds: null });
    f.step({ kind: "start" });
    const bad = [
      [0, 1, 2], // too short
      [0, 1, 2, 6], // symbol outside the cadet alphabet (0-5)
      [0, 0, 1, 2], // repeats are off in cadet
      [0, 1, 2, 2.5], // non-integer
    ];
    for (const guess of bad) {
      expect(
        server.transition(f.ctx, f.state, {
          kind: "action",
          type: "guess",
          payload: { guess },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_GUESS" } });
    }
    expect(f.state.boards.m1).toEqual([]);
    expect(f.state.currentMemberId).toBe("m1");
    expect(f.view("m1").canGuess).toBe(true);
  });

  it("skips a turn on deadline without consuming a guess", () => {
    const f = fixture({ preset: "standard", turnSeconds: 60 });
    const start = f.step({ kind: "start" });
    f.patch({ now: start.deadlines[0].dueAt });
    const skipped = f.step({
      kind: "deadline",
      deadline: start.deadlines[0],
    });
    expect(skipped.state.boards.m1).toEqual([]);
    expect(skipped.needsActionFrom).toEqual(["m2"]);
    expect(skipped.deadlines[0].generation).toBe(2);
  });

  it("ranks a no-winner finish by best guess; an exact tie is a draw", () => {
    // Closest winner: m1's wrong guess is one off; m2 guesses a symbol that
    // is not in the code at all (exact 0, misplaced 0).
    const f = fixture();
    f.step({ kind: "start" });
    const near = f.wrongGuess(); // exact = code length - 1
    const absent = [0, 1, 2, 3, 4, 5].find((s) => !f.state.code.includes(s))!;
    const far = [absent, absent, absent, absent];
    let lastF: Transition<CipherState> | null = null;
    for (let round = 0; round < 10; round++) {
      f.guess("m1", near);
      lastF = f.guess("m2", far);
    }
    expect(lastF!.final).toMatchObject({
      outcome: "completed",
      data: { winners: ["m1"], draw: false },
      participants: [
        expect.objectContaining({ memberId: "m1", win: true, score: 1 }),
        expect.objectContaining({ memberId: "m2", win: false, score: 0 }),
      ],
    });
    // Draw: both players play identically.
    const g = fixture();
    g.step({ kind: "start" });
    const same = g.wrongGuess();
    let last: Transition<CipherState> | null = null;
    for (let round = 0; round < 10; round++) {
      g.guess("m1", same);
      last = g.guess("m2", same);
    }
    expect(last!.final).toMatchObject({
      outcome: "completed",
      data: { winners: ["m1", "m2"], draw: true },
    });
    expect(last!.final!.participants.every((p) => !p.win)).toBe(true);
    const view = server.resultView(g.ctx, last!.final!, "principal-m1");
    expect(view).toMatchObject({ data: { draw: true } });
  });

  it("records a solo cap exhaustion as uncracked, not a win", () => {
    const f = fixture({ preset: "standard", turnSeconds: null }, "solo");
    f.step({ kind: "start" });
    let last: Transition<CipherState> | null = null;
    for (let i = 0; i < 10; i++) last = f.guess("m1", f.wrongGuess());
    expect(last!.final).toMatchObject({
      outcome: "completed",
      data: { winners: [], draw: false },
      participants: [
        expect.objectContaining({
          memberId: "m1",
          win: false,
          score: 0,
          contribution: expect.objectContaining({ cracked: false }),
        }),
      ],
    });
  });

  it("suspends when nobody enabled can act and resumes with time preserved", () => {
    const f = fixture({ preset: "standard", turnSeconds: 100 });
    const start = f.step({ kind: "start" });
    f.patch({ now: "2026-10-24T00:00:40.000Z" });
    // Disabling the non-holder changes nothing; disabling the holder too
    // leaves nobody who can act, so the match suspends with 60s preserved.
    expect(f.status("m2", true).deadlines).toEqual(start.deadlines);
    const paused = f.status("m1", true);
    expect(paused.state).toMatchObject({
      suspended: true,
      suspendedRemainingMs: 60000,
    });
    expect(paused.deadlines).toEqual([]);
    f.patch({ now: "2026-10-24T00:10:00.000Z" });
    const resumed = f.status("m2", false);
    expect(resumed.state.suspended).toBe(false);
    expect(resumed.deadlines).toEqual([
      { key: "turn", generation: 2, dueAt: "2026-10-24T00:11:00.000Z" },
    ]);
    expect(resumed.needsActionFrom).toEqual(["m2"]);
  });

  it("refuses invalid settings at create", () => {
    const result = server.transition(
      {
        ...fixture().ctx,
        phase: null,
        settings: { preset: "impossible", turnSeconds: 60 },
      },
      null,
      { kind: "create" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_SETTINGS" },
    });
  });
});
