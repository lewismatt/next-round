// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type {
  Fact,
  GameEvent,
  Member,
  RuleContext,
  Transition,
} from "@next-round/game-sdk";
import type { Json } from "@next-round/contracts";
import { parseCrosswordImport } from "./content.js";
import { server } from "./server.js";
import type { CrosswordSettingsV1, CrosswordStateV1 } from "./types.js";

/**
 * A five-by-four grid with one blocked cell in the last row. The blocked cell
 * makes the middle down entry ("CHM") end above the last row, so a word can be
 * completed by crossings while other words remain unsolved.
 */
const ROWS = ["ABCDE", "FGHIJ", "KLMNO", "PQ#RS"];

const CLUES = [
  { direction: "across" as const, row: 0, col: 0, text: "First across" },
  { direction: "across" as const, row: 1, col: 0, text: "Second across" },
  { direction: "across" as const, row: 2, col: 0, text: "Third across" },
  { direction: "across" as const, row: 3, col: 0, text: "Fourth across" },
  { direction: "across" as const, row: 3, col: 3, text: "Fifth across" },
  { direction: "down" as const, row: 0, col: 0, text: "First down" },
  { direction: "down" as const, row: 0, col: 1, text: "Second down" },
  { direction: "down" as const, row: 0, col: 2, text: "Third down" },
  { direction: "down" as const, row: 0, col: 3, text: "Fourth down" },
  { direction: "down" as const, row: 0, col: 4, text: "Fifth down" },
];

function resource(): { identity: string; data: Record<string, unknown> } {
  const parsed = parseCrosswordImport({
    format: "next-round.crossword/1",
    title: "Test Grid",
    author: "Next Round",
    language: "en",
    difficulty: "easy",
    rights: {
      license: "CC0-1.0",
      sourceUrl: null,
      attribution: "Next Round test fixture",
      permissionNote: null,
    },
    rows: ROWS,
    clues: CLUES,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return {
    identity: parsed.identity,
    data: parsed.content as unknown as Record<string, unknown>,
  };
}

const RESOURCE = resource();

function member(
  id: string,
  overrides: Partial<Member> = {},
): Member {
  return {
    id,
    principalId: `principal-${id}`,
    kind: "registered",
    displayName: id,
    status: "active",
    joinOrdinal: 1,
    disabled: false,
    accessEpoch: 0,
    ...overrides,
  };
}

const SOLO_SETTINGS: CrosswordSettingsV1 = {
  preset: "solo_casual",
  wrongGuessesPerTurn: null,
  correctWordsPerTurn: null,
  turnSeconds: null,
};

const QUICK_SETTINGS: CrosswordSettingsV1 = {
  preset: "quick",
  wrongGuessesPerTurn: 3,
  correctWordsPerTurn: 1,
  turnSeconds: null,
};

const CUSTOM_SETTINGS: CrosswordSettingsV1 = {
  preset: "custom",
  wrongGuessesPerTurn: 2,
  correctWordsPerTurn: null,
  turnSeconds: 60,
};

interface Scenario {
  mode?: string;
  phase?: "lobby" | "active" | "finished";
  settings?: CrosswordSettingsV1;
  members?: Member[];
  hostMemberId?: string | null;
  actorMemberId?: string | null;
  facts?: Fact[];
  now?: string;
  matchId?: string;
}

function context(scenario: Scenario = {}): RuleContext {
  const members = scenario.members ?? [member("m1")];
  const actorMemberId =
    scenario.actorMemberId === undefined
      ? members[0]?.id ?? null
      : scenario.actorMemberId;
  const actor = members.find((candidate) => candidate.id === actorMemberId);
  return {
    matchId: scenario.matchId ?? "match-1",
    moduleVersion: "0.1.0",
    mode: scenario.mode ?? "solo",
    phase: scenario.phase ?? "lobby",
    revision: 1,
    now: scenario.now ?? "2026-10-20T10:00:00.000Z",
    eventId: "event-1",
    actor: actor ? { principalId: actor.principalId, memberId: actor.id } : null,
    members,
    hostMemberId:
      scenario.hostMemberId === undefined
        ? members[0]?.id ?? null
        : scenario.hostMemberId,
    settings: (scenario.settings ?? SOLO_SETTINGS) as unknown as Json,
    resource: {
      id: "resource-1",
      identity: RESOURCE.identity,
      version: 1,
      data: RESOURCE.data as never,
    },
    facts: scenario.facts ?? [],
  };
}

interface AcceptedTransition {
  ok: true;
  value: Transition<CrosswordStateV1>;
}

function apply(
  ctx: RuleContext,
  state: CrosswordStateV1 | null,
  event: GameEvent,
): AcceptedTransition {
  const result = server.transition(ctx, state, event);
  if (!result.ok) {
    throw new Error(`transition rejected: ${result.error.code}`);
  }
  return result;
}

/** Replaces the acting member without touching the rest of the context. */
function asActor(ctx: RuleContext, memberId: string): RuleContext {
  const actor = ctx.members.find((candidate) => candidate.id === memberId);
  return {
    ...ctx,
    actor: actor ? { principalId: actor.principalId, memberId: actor.id } : null,
  };
}

function rejected(
  ctx: RuleContext,
  state: CrosswordStateV1 | null,
  event: GameEvent,
): string {
  const result = server.transition(ctx, state, event);
  if (result.ok) throw new Error("Expected the transition to be rejected.");
  return result.error.code;
}

function createState(scenario: Scenario = {}): {
  ctx: RuleContext;
  state: CrosswordStateV1;
} {
  const ctx = context(scenario);
  const created = apply(ctx, null, { kind: "create" });
  return { ctx, state: created.value.state };
}

function startState(scenario: Scenario = {}): {
  ctx: RuleContext;
  state: CrosswordStateV1;
} {
  const { ctx, state } = createState(scenario);
  const started = apply(
    { ...ctx, phase: "lobby" },
    state,
    { kind: "start" },
  );
  return {
    ctx: { ...ctx, phase: "active" },
    state: started.value.state,
  };
}

describe("crossword rules (Master Spec §9 C2-C4)", () => {
  it("creates a lobby with one entry per derived word", () => {
    const { state } = createState();
    expect(Object.keys(state.words).sort()).toEqual([
      "1A",
      "1D",
      "2D",
      "3D",
      "4D",
      "5D",
      "6A",
      "7A",
      "8A",
      "9A",
    ]);
    expect(state.board).toHaveLength(20);
    expect(state.board.every((cell) => cell === null)).toBe(true);
    expect(state.exclusionReasons).toEqual([]);
  });

  it("rejects settings that do not match the mode", () => {
    const ctx = context({ mode: "quick", settings: CUSTOM_SETTINGS });
    expect(rejected(ctx, null, { kind: "create" })).toBe("INVALID_SETTINGS");
  });

  it("starts a solo match with one turn and no deadline", () => {
    const { ctx, state } = startState();
    expect(ctx.phase).toBe("active");
    expect(state.currentMemberId).toBe("m1");
    expect(state.turn?.generation).toBe(1);
    expect(state.turn?.wrong).toBe(0);
    expect(state.turn?.dueAt).toBeNull();
  });

  it("records the exposure fact for every starting participant", () => {
    const { ctx, state } = createState();
    const started = apply(ctx, state, { kind: "start" });
    expect(started.value.facts).toEqual([
      {
        principalId: "principal-m1",
        key: "crossword/seen",
        value: { matchId: "match-1", seenAt: ctx.now },
      },
    ]);
  });

  it("scores an explicit solve once and completes crossings for no points", () => {
    const { ctx, state } = startState();
    const solved = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    const next = solved.value.state;
    expect(next.scores.m1).toBe(1);
    expect(next.words["1A"].completed).toBe(true);
    expect(next.words["1A"].explicitSolver).toBe("m1");
    expect(next.words["1D"].completed).toBe(false);
    expect(next.turn?.correct).toBe(1);
  });

  it("completes a crossing word for zero points when its letters arrive", () => {
    const { ctx, state } = startState();
    const first = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    const second = apply(ctx, first.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "6A", answer: "FGHIJ" },
    });
    const third = apply(ctx, second.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "7A", answer: "KLMNO" },
    });
    const next = third.value.state;
    expect(next.words["3D"].completed).toBe(true);
    expect(next.words["3D"].explicitSolver).toBeNull();
    expect(next.scores.m1).toBe(3);
    expect(next.words["8A"].completed).toBe(false);
  });

  it("keeps a wrong guess out of the score and in the private feedback", () => {
    const { ctx, state } = startState();
    const wrong = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "XXXXX" },
    });
    const next = wrong.value.state;
    expect(next.scores.m1).toBe(0);
    expect(next.turn?.wrong).toBe(1);
    expect(next.privateFeedback.m1).toEqual({
      turnGeneration: 1,
      lastWrongGuess: "XXXXX",
      remainingWrong: null,
    });
    expect(next.privateFeedback.m2).toBeUndefined();
  });

  it("rejects a malformed answer without consuming a guess", () => {
    const { ctx, state } = startState();
    expect(
      rejected(ctx, state, {
        kind: "action",
        type: "submit_word",
        payload: { wordId: "1A", answer: "TOOLONG" },
      }),
    ).toBe("MALFORMED_ANSWER");
    expect(
      rejected(ctx, state, {
        kind: "action",
        type: "submit_word",
        payload: { wordId: "1A", answer: "ABC1E" },
      }),
    ).toBe("MALFORMED_ANSWER");
    const unchanged = server.transition(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    expect(unchanged.ok).toBe(true);
  });

  it("rejects a conflicting crossing letter", () => {
    const { ctx, state } = startState();
    const first = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    expect(
      rejected(ctx, first.value.state, {
        kind: "action",
        type: "submit_word",
        payload: { wordId: "1D", answer: "ZFKP" },
      }),
    ).toBe("CONFLICTING_CROSSING");
  });

  it("shares the wrong budget across clues and ends the turn at the limit", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const first = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "XXXXX" },
    });
    const second = apply(ctx, first.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "6A", answer: "YYYYY" },
    });
    expect(second.value.state.turn?.wrong).toBe(2);
    const third = apply(ctx, second.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "7A", answer: "ZZZZZ" },
    });
    const next = third.value.state;
    expect(next.currentMemberId).toBe("m2");
    expect(next.turn?.generation).toBe(2);
    expect(next.turn?.wrong).toBe(0);
    expect(next.privateFeedback.m1?.lastWrongGuess).toBe("ZZZZZ");
    expect(next.privateFeedback.m1?.remainingWrong).toBe(0);
  });

  it("ends the quick turn after one correct word without resetting the wrong count", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const wrong = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "XXXXX" },
    });
    const solved = apply(ctx, wrong.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "6A", answer: "FGHIJ" },
    });
    const next = solved.value.state;
    expect(next.currentMemberId).toBe("m2");
    expect(next.turn?.generation).toBe(2);
  });

  it("advances the rotation on a pass", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const passed = apply(ctx, state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    const next = passed.value.state;
    expect(next.currentMemberId).toBe("m2");
    expect(next.turn?.generation).toBe(2);
  });

  it("pauses a solo turn awaiting Continue and resumes with fresh counters", () => {
    const { ctx, state } = startState();
    const wrong = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "XXXXX" },
    });
    const customCtx: RuleContext = {
      ...ctx,
      mode: "solo",
      settings: {
        preset: "custom",
        wrongGuessesPerTurn: 1,
        correctWordsPerTurn: null,
        turnSeconds: null,
      },
    };
    const customState: CrosswordStateV1 = {
      ...wrong.value.state,
      turn: { ...wrong.value.state.turn!, wrong: 1 },
    };
    const limited = apply(customCtx, customState, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "6A", answer: "YYYYY" },
    });
    const next = limited.value.state;
    expect(next.soloAwaitingContinue).toBe(true);
    expect(next.turn?.dueAt).toBeNull();
    expect(next.turn?.generation).toBe(1);
    expect(next.currentMemberId).toBeNull();

    const continued = apply(customCtx, next, {
      kind: "action",
      type: "continue",
      payload: {},
    });
    const resumed = continued.value.state;
    expect(resumed.soloAwaitingContinue).toBe(false);
    expect(resumed.turn?.wrong).toBe(0);
    expect(resumed.turn?.generation).toBe(2);
    expect(resumed.scores.m1).toBe(0);
  });

  it("rejects a reveal in a multiplayer match", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    expect(
      rejected(ctx, state, {
        kind: "action",
        type: "reveal_letter",
        payload: { row: 0, col: 0 },
      }),
    ).toBe("REVEALS_ARE_SOLO_ONLY");
    expect(
      rejected(ctx, state, {
        kind: "action",
        type: "reveal_word",
        payload: { wordId: "1A" },
      }),
    ).toBe("REVEALS_ARE_SOLO_ONLY");
    expect(
      rejected(ctx, state, {
        kind: "action",
        type: "reveal_puzzle",
        payload: {},
      }),
    ).toBe("REVEALS_ARE_SOLO_ONLY");
  });

  it("marks both crossing words assisted when a letter is revealed", () => {
    const { ctx, state } = startState();
    const revealed = apply(ctx, state, {
      kind: "action",
      type: "reveal_letter",
      payload: { row: 0, col: 0 },
    });
    const next = revealed.value.state;
    expect(next.board[0]).toBe("A");
    expect(next.words["1A"].assisted).toBe(true);
    expect(next.words["1D"].assisted).toBe(true);
    expect(next.scores.m1).toBe(0);
  });

  it("scores zero for a word that was revealed", () => {
    const { ctx, state } = startState();
    const revealed = apply(ctx, state, {
      kind: "action",
      type: "reveal_letter",
      payload: { row: 0, col: 0 },
    });
    const solved = apply(ctx, revealed.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    const next = solved.value.state;
    expect(next.words["1A"].completed).toBe(true);
    expect(next.scores.m1).toBe(0);
  });

  it("rejects a repeated reveal of a filled cell", () => {
    const { ctx, state } = startState();
    const revealed = apply(ctx, state, {
      kind: "action",
      type: "reveal_letter",
      payload: { row: 0, col: 0 },
    });
    expect(
      rejected(ctx, revealed.value.state, {
        kind: "action",
        type: "reveal_letter",
        payload: { row: 0, col: 0 },
      }),
    ).toBe("ALREADY_FILLED");
  });

  it("finishes a revealed puzzle with the points already earned", () => {
    const { ctx, state } = startState();
    const solved = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    const revealed = apply(ctx, solved.value.state, {
      kind: "action",
      type: "reveal_puzzle",
      payload: {},
    });
    expect(revealed.value.phase).toBe("finished");
    expect(revealed.value.final?.outcome).toBe("revealed");
    const participant = revealed.value.final?.participants[0];
    expect(participant?.score).toBe(1);
  });

  it("derives the revealed result's completedWords from the final state (BL-049)", () => {
    const { ctx, state } = startState();
    const solved = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    const revealed = apply(ctx, solved.value.state, {
      kind: "action",
      type: "reveal_puzzle",
      payload: {},
    });
    const finalState = revealed.value.state;
    const stateCount = Object.values(finalState.words).filter(
      (word) => word.completed,
    ).length;
    const data = revealed.value.final?.data as Record<string, unknown>;
    expect(revealed.value.final?.outcome).toBe("revealed");
    expect(data.completedWords).toBe(stateCount);
    expect(data.totalWords).toBe(Object.keys(finalState.words).length);
    expect(stateCount).toBeGreaterThan(1);
  });

  it("latches a declared exposure before the match starts", () => {
    const { ctx, state } = createState();
    const declared = apply(ctx, state, {
      kind: "action",
      type: "declare_exposure",
      payload: {},
    });
    const next = declared.value.state;
    expect(next.exclusionReasons).toContain("declared_exposure");
    expect(declared.value.phase).toBe("lobby");
    expect(declared.value.facts[0]?.key).toBe("crossword/declared");
  });

  it("excludes a match whose player already saw the puzzle elsewhere", () => {
    const facts: Fact[] = [
      {
        principalId: "principal-m1",
        key: "crossword/seen",
        value: { matchId: "other-match", seenAt: "2026-10-19T10:00:00.000Z" },
      },
    ];
    const { ctx, state } = createState({ facts });
    const started = apply(ctx, state, { kind: "start" });
    const next = started.value.state;
    expect(next.exclusionReasons).toContain("prior_exposure");
  });

  it("does not exclude a match for its own exposure fact", () => {
    const facts: Fact[] = [
      {
        principalId: "principal-m1",
        key: "crossword/seen",
        value: { matchId: "match-1", seenAt: "2026-10-19T10:00:00.000Z" },
      },
    ];
    const { ctx, state } = createState({ facts });
    const started = apply(ctx, state, { kind: "start" });
    const next = started.value.state;
    expect(next.exclusionReasons).not.toContain("prior_exposure");
  });

  it("excludes the importer of the puzzle", () => {
    const facts: Fact[] = [
      {
        principalId: "principal-m1",
        key: "crossword/imported",
        value: { importedAt: "2026-10-19T10:00:00.000Z", resourceIdentity: "digest" },
      },
    ];
    const { ctx, state } = createState({ facts });
    const started = apply(ctx, state, { kind: "start" });
    const next = started.value.state;
    expect(next.exclusionReasons).toContain("importer_exposure");
  });

  it("excludes a custom-rules match from career credit", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { state } = createState({
      mode: "custom",
      settings: CUSTOM_SETTINGS,
      members,
    });
    expect(state.exclusionReasons).toContain("custom_rules");
  });

  it("flags a timed-out player for removal and advances the turn", () => {
    const members = [
      member("m1"),
      member("m2", { joinOrdinal: 2 }),
      member("m3", { joinOrdinal: 3 }),
    ];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const passed = apply(ctx, state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    const timedOut = apply(ctx, passed.value.state, {
      kind: "deadline",
      deadline: { key: "turn", generation: 2, dueAt: ctx.now },
    });
    const next = timedOut.value.state;
    expect(next.timeoutRemovalEligible).toEqual(["m2"]);
    expect(next.currentMemberId).toBe("m3");
    const authority = server.authority(ctx, next, "m1");
    expect(authority.removableMemberIds).toEqual(["m2"]);
    expect(server.authority(ctx, next, "m2").removableMemberIds).toEqual([]);
  });

  it("never grants removal eligibility for wrong guesses alone", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const wrong = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "XXXXX" },
    });
    const next = wrong.value.state;
    expect(next.timeoutRemovalEligible).toEqual([]);
  });

  it("clears the removal flag after the flagged member's next voluntary action", () => {
    const members = [
      member("m1"),
      member("m2", { joinOrdinal: 2 }),
      member("m3", { joinOrdinal: 3 }),
    ];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const passed = apply(ctx, state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    const timedOut = apply(ctx, passed.value.state, {
      kind: "deadline",
      deadline: { key: "turn", generation: 2, dueAt: ctx.now },
    });
    const timedOutState = timedOut.value.state;
    expect(timedOutState.timeoutRemovalEligible).toEqual(["m2"]);

    const thirdPassed = apply(asActor(ctx, "m3"), timedOutState, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    expect(thirdPassed.value.state.currentMemberId).toBe("m1");
    expect(thirdPassed.value.state.timeoutRemovalEligible).toEqual(["m2"]);

    const hostPassed = apply(asActor(ctx, "m1"), thirdPassed.value.state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    expect(hostPassed.value.state.currentMemberId).toBe("m2");
    expect(hostPassed.value.state.timeoutRemovalEligible).toEqual(["m2"]);

    const acted = apply(asActor(ctx, "m2"), hostPassed.value.state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    expect(acted.value.state.timeoutRemovalEligible).toEqual([]);
  });

  it("clears the removal flag when the flagged member's next action is an accepted wrong guess", () => {
    const members = [
      member("m1"),
      member("m2", { joinOrdinal: 2 }),
      member("m3", { joinOrdinal: 3 }),
    ];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const passed = apply(ctx, state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    const timedOut = apply(ctx, passed.value.state, {
      kind: "deadline",
      deadline: { key: "turn", generation: 2, dueAt: ctx.now },
    });
    const timedOutState = timedOut.value.state;
    expect(timedOutState.timeoutRemovalEligible).toEqual(["m2"]);
    expect(timedOutState.currentMemberId).toBe("m3");

    const thirdPassed = apply(asActor(ctx, "m3"), timedOutState, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    expect(thirdPassed.value.state.currentMemberId).toBe("m1");
    expect(thirdPassed.value.state.timeoutRemovalEligible).toEqual(["m2"]);

    const hostPassed = apply(asActor(ctx, "m1"), thirdPassed.value.state, {
      kind: "action",
      type: "pass",
      payload: {},
    });
    expect(hostPassed.value.state.currentMemberId).toBe("m2");
    expect(hostPassed.value.state.timeoutRemovalEligible).toEqual(["m2"]);
    expect(server.authority(ctx, hostPassed.value.state, "m1")
      .removableMemberIds).toEqual(["m2"]);

    // The wrong guess is accepted (it consumes wrong budget and records
    // private feedback), so it is a voluntary gameplay action under C4 and
    // must clear the flag exactly like the pass above does.
    const guessed = apply(asActor(ctx, "m2"), hostPassed.value.state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "XXXXX" },
    });
    const next = guessed.value.state;
    expect(next.turn?.wrong).toBe(1);
    expect(next.privateFeedback.m2?.lastWrongGuess).toBe("XXXXX");
    expect(next.timeoutRemovalEligible).toEqual([]);
    expect(server.authority(ctx, next, "m1").removableMemberIds).toEqual([]);
  });

  it("ends the obligation of a disabled current player without points", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const disabled = apply(
      { ...ctx, members: [member("m1", { disabled: true }), members[1]!] },
      state,
      { kind: "principal_status", memberId: "m1", disabled: true },
    );
    const next = disabled.value.state;
    expect(next.currentMemberId).toBe("m2");
    expect(next.scores.m1).toBe(0);
    expect(next.timeoutRemovalEligible).toEqual([]);
  });

  it("gives a disabled host's authority to the earliest enabled member", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const disabledCtx: RuleContext = {
      ...ctx,
      members: [member("m1", { disabled: true }), members[1]!],
    };
    expect(server.authority(disabledCtx, state, "m1").canFinish).toBe(false);
    expect(server.authority(disabledCtx, state, "m2").canFinish).toBe(true);
    const view = server.view(disabledCtx, state, {
      principalId: "principal-m2",
      memberId: "m2",
      access: "active",
    });
    expect(view.actingHostMemberId).toBe("m2");
  });

  it("suspends the match when no member is enabled and resumes on reactivation", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "custom",
      settings: {
        preset: "custom",
        wrongGuessesPerTurn: 3,
        correctWordsPerTurn: 1,
        turnSeconds: 60,
      },
      members,
    });
    const disabled = apply(
      { ...ctx, members: [member("m1", { disabled: true }), member("m2", { disabled: true })] },
      state,
      { kind: "principal_status", memberId: "m1", disabled: true },
    );
    const suspended = disabled.value.state;
    expect(suspended.suspended).toBe(true);
    expect(suspended.turn?.dueAt).toBeNull();
    expect(suspended.suspendedRemainingMs).not.toBeNull();

    const reactivated = apply(
      { ...ctx, members: [member("m1"), member("m2", { disabled: true })] },
      suspended,
      { kind: "principal_status", memberId: "m1", disabled: false },
    );
    const resumed = reactivated.value.state;
    expect(resumed.suspended).toBe(false);
    expect(resumed.turn?.dueAt).not.toBeNull();
  });

  it("transfers the host to the earliest remaining participant on departure", () => {
    const members = [member("m1"), member("m2", { joinOrdinal: 2 })];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const left = apply(
      { ...ctx, members: [member("m1"), member("m2", { joinOrdinal: 2 })] },
      state,
      { kind: "leave", memberId: "m1", reason: "left" },
    );
    expect(left.value.hostMemberId).toBe("m2");
    expect((left.value.state).exclusionReasons).toContain(
      "participant_dropped",
    );
  });

  it("keeps a registered player eligible while a guest shares the match", () => {
    const members = [
      member("m1"),
      member("g1", { kind: "guest", principalId: "principal-g1", joinOrdinal: 2 }),
    ];
    const { ctx, state } = startState({
      mode: "quick",
      settings: QUICK_SETTINGS,
      members,
    });
    const solved = apply(ctx, state, {
      kind: "action",
      type: "submit_word",
      payload: { wordId: "1A", answer: "ABCDE" },
    });
    const ended = apply(ctx, solved.value.state, {
      kind: "finish",
      reason: "host_ended",
    });
    const participants = ended.value.final?.participants ?? [];
    const registered = participants.find((entry) => entry.memberId === "m1");
    const guest = participants.find((entry) => entry.memberId === "g1");
    expect(registered?.careerEligible).toBe(false);
    expect(registered?.exclusionReasons).toContain("host_ended_early");
    expect(guest?.careerEligible).toBe(false);
    expect(guest?.exclusionReasons).toContain("guest_player");
  });

  it("keeps the lobby free of clues and the solution", () => {
    const { ctx, state } = createState();
    const view = server.view(ctx, state, {
      principalId: "principal-m1",
      memberId: "m1",
      access: "active",
    });
    expect(view.clues).toBeNull();
    expect(view.board).toBeNull();
    expect(view.numbers).toBeNull();
    expect(view.title).toBe("Test Grid");
  });

  it("publishes clues and the accepted board after the start", () => {
    const { ctx, state } = startState();
    const view = server.view(ctx, state, {
      principalId: "principal-m1",
      memberId: "m1",
      access: "active",
    });
    expect(view.clues?.length).toBe(10);
    expect(view.board).toHaveLength(20);
    expect(JSON.stringify(view)).not.toContain("ABCDE");
  });
});
