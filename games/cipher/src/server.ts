// SPDX-License-Identifier: Apache-2.0
import {
  defineGameServer,
  type FinalResult,
  type GameServer,
  type RuleContext,
  type Transition,
  type TransitionResult,
} from "@next-round/game-sdk";
import {
  CIPHER_PRESETS,
  type CipherPreset,
  type CipherSettings,
  type CipherState,
  type CipherView,
  type GuessRecord,
} from "./types.js";

const enabled = (ctx: RuleContext) =>
  ctx.members.filter((m) => m.status === "active" && !m.disabled);
const settings = (ctx: RuleContext) =>
  ctx.settings as unknown as CipherSettings;
const spec = (ctx: RuleContext): CipherPreset =>
  CIPHER_PRESETS[settings(ctx).preset];
const failure = (
  code: string,
  message: string,
): TransitionResult<CipherState> => ({ ok: false, error: { code, message } });

/** Deterministic code generation. The entropy source is the server-provided
 * create event id combined with the match id; neither is projected into a
 * client view, so the code cannot be recomputed by a player. The generated
 * code is stored in server state, which is the audit record. */
function generateCode(ctx: RuleContext, preset: CipherPreset): number[] {
  let h = 2166136261;
  const seedText = `${ctx.matchId}:${ctx.eventId}`;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let seed = h >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = Array.from({ length: preset.alphabetSize }, (_, i) => i);
  const code: number[] = [];
  for (let slot = 0; slot < preset.codeLength; slot++) {
    if (preset.repeats) {
      code.push(Math.floor(rand() * preset.alphabetSize));
    } else {
      const pick = Math.floor(rand() * pool.length);
      code.push(pool.splice(pick, 1)[0]);
    }
  }
  return code;
}

/** Two-pass feedback: exact matches first, then misplaced counted among the
 * remaining symbol multiset, so no symbol is ever double-counted. */
export function feedback(
  code: readonly number[],
  guess: readonly number[],
): { exact: number; misplaced: number } {
  let exact = 0;
  const remaining = new Map<number, number>();
  const rest: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (guess[i] === code[i]) {
      exact++;
    } else {
      remaining.set(code[i], (remaining.get(code[i]) ?? 0) + 1);
      rest.push(guess[i]);
    }
  }
  let misplaced = 0;
  for (const symbol of rest) {
    const available = remaining.get(symbol) ?? 0;
    if (available > 0) {
      misplaced++;
      remaining.set(symbol, available - 1);
    }
  }
  return { exact, misplaced };
}

function bestGuess(board: GuessRecord[]): GuessRecord | null {
  let best: GuessRecord | null = null;
  for (const record of board) {
    if (
      !best ||
      record.exact > best.exact ||
      (record.exact === best.exact && record.misplaced > best.misplaced)
    ) {
      best = record;
    }
  }
  return best;
}

const used = (state: CipherState, memberId: string) =>
  state.boards[memberId]?.length ?? 0;
const done = (ctx: RuleContext, state: CipherState, memberId: string) =>
  used(state, memberId) >= spec(ctx).guessCap;
const cracked = (state: CipherState, memberId: string) =>
  (state.boards[memberId] ?? []).some(
    (r) => r.exact === state.code.length,
  );
const eligible = (ctx: RuleContext, state: CipherState, memberId: string) =>
  state.playerOrder.includes(memberId) &&
  enabled(ctx).some((m) => m.id === memberId) &&
  !done(ctx, state, memberId);
const anyEligible = (ctx: RuleContext, state: CipherState) =>
  state.playerOrder.some((id) => eligible(ctx, state, id));
const allDone = (ctx: RuleContext, state: CipherState) =>
  state.playerOrder.length > 0 &&
  state.playerOrder.every((id) => done(ctx, state, id));

function obligations(ctx: RuleContext, state: CipherState): string[] {
  if (ctx.phase !== "active" || state.suspended) return [];
  return state.currentMemberId &&
    eligible(ctx, state, state.currentMemberId)
    ? [state.currentMemberId]
    : [];
}

function transition(
  ctx: RuleContext,
  state: CipherState,
  phase = ctx.phase ?? "lobby",
  final: FinalResult | null = null,
): TransitionResult<CipherState> {
  const active = enabled(ctx);
  const host = active.some((m) => m.id === ctx.hostMemberId)
    ? ctx.hostMemberId
    : (active[0]?.id ?? ctx.hostMemberId);
  const value: Transition<CipherState> = {
    state,
    phase,
    hostMemberId: host,
    deadlines:
      phase === "active" && state.dueAt !== null && !state.suspended
        ? [{ key: "turn", generation: state.generation, dueAt: state.dueAt }]
        : [],
    needsActionFrom:
      phase === "active" ? obligations({ ...ctx, phase }, state) : [],
    facts: [],
    final,
  };
  return { ok: true, value };
}

/** Give the turn to `memberId` with a fresh deadline (or none, untimed). */
function grantTurn(
  ctx: RuleContext,
  state: CipherState,
  memberId: string,
): CipherState {
  const seconds = settings(ctx).turnSeconds;
  return {
    ...state,
    currentMemberId: memberId,
    generation: state.generation + 1,
    dueAt:
      seconds === null
        ? null
        : new Date(Date.parse(ctx.now) + seconds * 1000).toISOString(),
    suspended: false,
    suspendedRemainingMs: null,
  };
}

/** The next eligible player strictly after `fromId` in turn order, wrapping.
 * May return `fromId` itself when it is the only eligible player. */
function nextEligible(
  ctx: RuleContext,
  state: CipherState,
  fromId: string | null,
): string | null {
  const order = state.playerOrder;
  if (order.length === 0) return null;
  const start = fromId ? order.indexOf(fromId) : -1;
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(start + step) % order.length];
    if (eligible(ctx, state, candidate)) return candidate;
  }
  return null;
}

function suspend(ctx: RuleContext, state: CipherState): CipherState {
  const seconds = settings(ctx).turnSeconds;
  const remaining =
    state.dueAt !== null
      ? Math.max(0, Date.parse(state.dueAt) - Date.parse(ctx.now))
      : seconds === null
        ? null
        : seconds * 1000;
  return {
    ...state,
    suspended: true,
    suspendedRemainingMs: remaining,
    dueAt: null,
  };
}

/** Reconcile the turn with the current roster after membership changes:
 * resume from suspension, pass the turn on from an ineligible holder, or
 * suspend when nobody can act but the match is not over. */
function membership(
  ctx: RuleContext,
  state: CipherState,
): TransitionResult<CipherState> {
  if (ctx.phase !== "active") return transition(ctx, state);
  if (allDone(ctx, state)) return finishNoWinner(ctx, state);
  if (state.suspended) {
    if (!anyEligible(ctx, state)) return transition(ctx, state);
    const holder =
      state.currentMemberId &&
      eligible(ctx, state, state.currentMemberId)
        ? state.currentMemberId
        : nextEligible(ctx, state, state.currentMemberId);
    if (!holder) return transition(ctx, state);
    const seconds = settings(ctx).turnSeconds;
    const remainingMs =
      state.suspendedRemainingMs ?? (seconds === null ? 0 : seconds * 1000);
    return transition(ctx, {
      ...state,
      currentMemberId: holder,
      generation: state.generation + 1,
      dueAt:
        seconds === null
          ? null
          : new Date(Date.parse(ctx.now) + remainingMs).toISOString(),
      suspended: false,
      suspendedRemainingMs: null,
    });
  }
  if (
    state.currentMemberId &&
    eligible(ctx, state, state.currentMemberId)
  ) {
    return transition(ctx, state);
  }
  const next = nextEligible(ctx, state, state.currentMemberId);
  if (next) return transition(ctx, grantTurn(ctx, state, next));
  return transition(ctx, suspend(ctx, state));
}

/** Move play on after the current holder guessed or was skipped. */
function advance(
  ctx: RuleContext,
  state: CipherState,
): TransitionResult<CipherState> {
  if (allDone(ctx, state)) return finishNoWinner(ctx, state);
  const next = nextEligible(ctx, state, state.currentMemberId);
  if (next) return transition(ctx, grantTurn(ctx, state, next));
  return transition(ctx, suspend(ctx, state));
}

function buildFinal(
  ctx: RuleContext,
  state: CipherState,
  outcome: "completed" | "ended_early",
  winners: string[],
  draw: boolean,
  crackerId: string | null,
  closestWinnerId: string | null,
): FinalResult {
  const preset = spec(ctx);
  return {
    outcome,
    data: {
      preset: settings(ctx).preset,
      winners,
      draw,
      code: [...state.code],
      guessesUsed: Object.fromEntries(
        state.playerOrder.map((id) => [id, used(state, id)]),
      ),
    },
    participants: ctx.members.map((m) => {
      const board = state.boards[m.id] ?? [];
      const best = bestGuess(board);
      const isCracker = crackerId === m.id;
      const score =
        outcome !== "completed"
          ? 0
          : isCracker
            ? preset.guessCap - board.length + 1
            : closestWinnerId === m.id
              ? 1
              : 0;
      const exclusionReasons: string[] = [];
      if (ctx.mode === "solo") exclusionReasons.push("solo_mode");
      if (m.kind === "guest") exclusionReasons.push("guest_player");
      if (m.disabled) exclusionReasons.push("disabled_principal");
      if (outcome === "ended_early") exclusionReasons.push("ended_early");
      return {
        memberId: m.id,
        score,
        contribution: {
          guessesUsed: board.length,
          cracked: isCracker,
          bestExact: best?.exact ?? 0,
          bestMisplaced: best?.misplaced ?? 0,
        },
        win: outcome === "completed" && winners.includes(m.id) && !draw,
        careerEligible: exclusionReasons.length === 0,
        exclusionReasons,
      };
    }),
  };
}

function finishCrack(
  ctx: RuleContext,
  state: CipherState,
  winnerId: string,
): TransitionResult<CipherState> {
  const final = buildFinal(ctx, state, "completed", [winnerId], false, winnerId, null);
  return transition(
    ctx,
    { ...state, dueAt: null, suspended: false, suspendedRemainingMs: null },
    "finished",
    final,
  );
}

function finishNoWinner(
  ctx: RuleContext,
  state: CipherState,
): TransitionResult<CipherState> {
  let topKey: [number, number] | null = null;
  let leaders: string[] = [];
  for (const id of state.playerOrder) {
    const best = bestGuess(state.boards[id] ?? []);
    const key: [number, number] = [best?.exact ?? 0, best?.misplaced ?? 0];
    if (
      !topKey ||
      key[0] > topKey[0] ||
      (key[0] === topKey[0] && key[1] > topKey[1])
    ) {
      topKey = key;
      leaders = [id];
    } else if (key[0] === topKey[0] && key[1] === topKey[1]) {
      leaders.push(id);
    }
  }
  // Solo has no closest-winner: exhausting the cap is simply uncracked.
  const draw = ctx.mode !== "solo" && leaders.length !== 1;
  const winners = ctx.mode === "solo" ? [] : leaders;
  const final = buildFinal(
    ctx,
    state,
    "completed",
    winners,
    draw,
    null,
    draw || ctx.mode === "solo" ? null : leaders[0],
  );
  return transition(
    ctx,
    { ...state, dueAt: null, suspended: false, suspendedRemainingMs: null },
    "finished",
    final,
  );
}

function finishEarly(
  ctx: RuleContext,
  state: CipherState,
): TransitionResult<CipherState> {
  const final = buildFinal(ctx, state, "ended_early", [], false, null, null);
  return transition(
    ctx,
    { ...state, dueAt: null, suspended: false, suspendedRemainingMs: null },
    "finished",
    final,
  );
}

export const server: GameServer<CipherState, CipherView> = defineGameServer<
  CipherState,
  CipherView
>({
  authority(ctx, _state, memberId) {
    const members = enabled(ctx);
    const host =
      members.some((m) => m.id === memberId) && ctx.hostMemberId === memberId;
    return {
      canStart:
        host &&
        ctx.phase === "lobby" &&
        members.length >= (ctx.mode === "solo" ? 1 : 2),
      canFinish: host && ctx.phase === "active",
      removableMemberIds: host
        ? ctx.members
            .filter(
              (m) => m.id !== memberId && m.disabled && m.status === "active",
            )
            .map((m) => m.id)
        : [],
    };
  },
  transition(ctx, state, event) {
    if (event.kind === "create") {
      const s = settings(ctx);
      if (
        !s ||
        !(s.preset in CIPHER_PRESETS) ||
        !(
          s.turnSeconds === null ||
          (Number.isInteger(s.turnSeconds) &&
            s.turnSeconds >= 30 &&
            s.turnSeconds <= 604800)
        )
      ) {
        return failure(
          "INVALID_SETTINGS",
          "Choose a Cipher preset and a turn timer from 30 seconds to 7 days, or no timer.",
        );
      }
      return transition(
        ctx,
        {
          code: generateCode(ctx, CIPHER_PRESETS[s.preset]),
          boards: Object.fromEntries(ctx.members.map((m) => [m.id, []])),
          playerOrder: [],
          currentMemberId: null,
          generation: 0,
          dueAt: null,
          suspended: false,
          suspendedRemainingMs: null,
        },
        "lobby",
      );
    }
    if (!state)
      return failure("INVALID_STATE", "The match is not initialized.");
    if (event.kind === "join") {
      return membership(ctx, {
        ...state,
        boards: {
          ...state.boards,
          [event.memberId]: state.boards[event.memberId] ?? [],
        },
      });
    }
    if (event.kind === "leave" || event.kind === "principal_status") {
      return membership(ctx, state);
    }
    if (ctx.phase === "finished")
      return failure("MATCH_FINISHED", "The match has finished.");
    if (event.kind === "start") {
      if (
        !ctx.actor ||
        !this.authority(ctx, state, ctx.actor.memberId).canStart
      )
        return failure(
          "CANNOT_START",
          "The host needs enough enabled players to start.",
        );
      const order = enabled(ctx).map((m) => m.id);
      const started: CipherState = {
        ...state,
        boards: Object.fromEntries(
          order.map((id) => [id, state.boards[id] ?? []]),
        ),
        playerOrder: order,
        currentMemberId: null,
        generation: 0,
        dueAt: null,
        suspended: false,
        suspendedRemainingMs: null,
      };
      return transition(ctx, grantTurn(ctx, started, order[0]), "active");
    }
    if (ctx.phase !== "active")
      return failure("MATCH_NOT_ACTIVE", "Start the match first.");
    if (event.kind === "finish") {
      if (
        !ctx.actor ||
        !this.authority(ctx, state, ctx.actor.memberId).canFinish
      )
        return failure(
          "CANNOT_FINISH",
          "Only the enabled host can end the match.",
        );
      return finishEarly(ctx, state);
    }
    if (event.kind === "action") {
      if (event.type !== "guess")
        return failure("UNSUPPORTED_ACTION", "Cipher only takes guesses.");
      const actor =
        ctx.actor && enabled(ctx).find((m) => m.id === ctx.actor!.memberId);
      if (!actor || state.suspended)
        return failure(
          "NOT_ELIGIBLE",
          "The match is paused or you are not an enabled player.",
        );
      if (state.currentMemberId !== actor.id)
        return failure("NOT_YOUR_TURN", "Wait for your turn to guess.");
      if (done(ctx, state, actor.id))
        return failure(
          "OUT_OF_GUESSES",
          "You have used all your guesses for this match.",
        );
      if (
        state.dueAt !== null &&
        Date.parse(ctx.now) >= Date.parse(state.dueAt)
      )
        return failure("TURN_CLOSED", "The turn deadline has passed.");
      const preset = spec(ctx);
      const payload = event.payload as { guess?: unknown } | null;
      const guess = payload?.guess;
      if (
        !Array.isArray(guess) ||
        guess.length !== preset.codeLength ||
        !guess.every(
          (symbol) =>
            Number.isInteger(symbol) &&
            (symbol as number) >= 0 &&
            (symbol as number) < preset.alphabetSize,
        ) ||
        (!preset.repeats && new Set(guess).size !== guess.length)
      ) {
        return failure(
          "INVALID_GUESS",
          preset.repeats
            ? `Submit ${preset.codeLength} symbols from the alphabet.`
            : `Submit ${preset.codeLength} different symbols from the alphabet.`,
        );
      }
      const result = feedback(state.code, guess as number[]);
      const next: CipherState = {
        ...state,
        boards: {
          ...state.boards,
          [actor.id]: [
            ...(state.boards[actor.id] ?? []),
            { guess: [...(guess as number[])], ...result },
          ],
        },
      };
      if (result.exact === preset.codeLength)
        return finishCrack(ctx, next, actor.id);
      return advance(ctx, next);
    }
    if (event.kind === "deadline") {
      const d = event.deadline;
      if (
        state.suspended ||
        d.key !== "turn" ||
        d.generation !== state.generation ||
        state.dueAt === null ||
        Date.parse(ctx.now) < Date.parse(d.dueAt)
      ) {
        return failure(
          "INVALID_DEADLINE",
          "The deadline is not active or due.",
        );
      }
      // A missed deadline skips the turn; no guess is consumed.
      return advance(ctx, state);
    }
    return failure("UNSUPPORTED_EVENT", "This event is not supported.");
  },
  view(ctx, state, viewer) {
    const preset = spec(ctx);
    const roster = state.playerOrder.length
      ? state.playerOrder
      : ctx.members.map((m) => m.id);
    const finished = ctx.phase === "finished";
    return {
      phase: ctx.phase ?? "lobby",
      preset: settings(ctx).preset,
      codeLength: preset.codeLength,
      alphabetSize: preset.alphabetSize,
      repeats: preset.repeats,
      guessCap: preset.guessCap,
      myMemberId: viewer.memberId,
      myBoard: viewer.memberId
        ? [...(state.boards[viewer.memberId] ?? [])]
        : [],
      players: roster.map((id) => ({
        memberId: id,
        guessesUsed: used(state, id),
        done: done(ctx, state, id),
        cracked: cracked(state, id),
      })),
      currentMemberId: state.currentMemberId,
      canGuess:
        viewer.access === "active" &&
        viewer.memberId !== null &&
        obligations(ctx, state).includes(viewer.memberId),
      guessesRemaining: viewer.memberId
        ? Math.max(0, preset.guessCap - used(state, viewer.memberId))
        : null,
      dueAt: state.dueAt,
      suspended: state.suspended,
      reveal: finished
        ? { code: [...state.code], boards: state.boards }
        : null,
    };
  },
  summary(ctx, state, principalId) {
    const member = ctx.members.find((m) => m.principalId === principalId);
    const total = Object.values(state.boards).reduce(
      (sum, board) => sum + board.length,
      0,
    );
    const label = settings(ctx).preset;
    return {
      label: `Cipher · ${label[0].toUpperCase()}${label.slice(1)} · ${total} guesses`,
      needsAction: member ? obligations(ctx, state).includes(member.id) : false,
      detail: state.suspended ? "Paused: no enabled players" : null,
    };
  },
  resultView(_ctx, result) {
    return {
      outcome: result.outcome,
      data: result.data,
      participants: result.participants.map((p) => ({
        memberId: p.memberId,
        score: p.score,
        win: p.win,
        careerEligible: p.careerEligible,
        exclusionReasons: [...p.exclusionReasons],
      })),
    };
  },
  career(result) {
    return result.participants
      .filter((p) => p.careerEligible)
      .map((p) => ({
        memberId: p.memberId,
        points: p.score,
        played: 1,
        wins: p.win ? 1 : 0,
      }));
  },
});
