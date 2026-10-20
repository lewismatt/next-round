// SPDX-License-Identifier: Apache-2.0
import type {
  AuthorityResult,
  CareerMetric,
  Fact,
  FinalParticipant,
  FinalResult,
  GameEvent,
  GameServer,
  Json,
  MatchSummary,
  Member,
  RuleContext,
  RuleError,
  TransitionResult,
  ViewerContext,
} from "@next-round/game-sdk";
import { defineGameServer, ResourceImportError } from "@next-round/game-sdk";
import {
  crosswordPublicMetadata,
  parseCrosswordImport,
  type CrosswordContentV1,
  type CrosswordEntry,
} from "./content.js";
import type {
  CrosswordClueView,
  CrosswordSettingsV1,
  CrosswordStateV1,
  CrosswordTurn,
  CrosswordView,
  CrosswordWordState,
} from "./types.js";

/**
 * Master Spec §9 C2-C4 — crossword rules.
 *
 * The reducer is pure: it reads the rule context and the pinned resource
 * snapshot, and returns the next state. It never touches the database, the
 * network or the wall clock.
 */

/** Principal-scoped fact keys. A fact is scoped to one resource identity. */
export const CROSSWORD_FACT_SEEN = "crossword/seen";
export const CROSSWORD_FACT_IMPORTED = "crossword/imported";
export const CROSSWORD_FACT_DECLARED = "crossword/declared";

/** Match-wide, monotonic career exclusion reasons. */
export const CROSSWORD_EXCLUSION_CUSTOM_RULES = "custom_rules";
export const CROSSWORD_EXCLUSION_PRIOR_EXPOSURE = "prior_exposure";
export const CROSSWORD_EXCLUSION_IMPORTER_EXPOSURE = "importer_exposure";
export const CROSSWORD_EXCLUSION_DECLARED_EXPOSURE = "declared_exposure";
export const CROSSWORD_EXCLUSION_PARTICIPANT_DROPPED = "participant_dropped";
export const CROSSWORD_EXCLUSION_HOST_ENDED_EARLY = "host_ended_early";
export const CROSSWORD_EXCLUSION_ALL_LEFT = "all_left";

/** Per-participant reasons that are not match-wide. */
const CROSSWORD_EXCLUSION_SOLO_MODE = "solo_mode";
const CROSSWORD_EXCLUSION_GUEST_PLAYER = "guest_player";

const TURN_DEADLINE_KEY = "turn";

const MIN_WRONG_GUESSES = 1;
const MAX_WRONG_GUESSES = 100;
const MIN_CORRECT_WORDS = 1;
const MAX_CORRECT_WORDS = 100;
const MIN_TURN_SECONDS = 10;
const MAX_TURN_SECONDS = 86400;

function ruleError(
  code: string,
  message: string,
): { ok: false; error: RuleError } {
  return { ok: false, error: { code, message } };
}

/**
 * Answer normalization (Master Spec §9 C2): trim outer whitespace, remove
 * ASCII spaces and hyphens, uppercase ASCII a-z. Anything else is a malformed
 * submission, not a wrong guess.
 */
function normalizeAnswer(value: string): string | null {
  const stripped = value.trim().replace(/[ -]/g, "");
  if (!/^[A-Za-z]*$/.test(stripped)) return null;
  return stripped.toUpperCase();
}

function parseSettings(ctx: RuleContext): CrosswordSettingsV1 | null {
  const raw = ctx.settings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const settings = raw as Record<string, unknown>;
  const preset = settings.preset;
  if (preset !== "solo_casual" && preset !== "quick" && preset !== "custom") {
    return null;
  }
  const wrongGuessesPerTurn = settings.wrongGuessesPerTurn;
  const correctWordsPerTurn = settings.correctWordsPerTurn;
  const turnSeconds = settings.turnSeconds;
  if (
    wrongGuessesPerTurn !== null &&
    (typeof wrongGuessesPerTurn !== "number" ||
      !Number.isInteger(wrongGuessesPerTurn) ||
      wrongGuessesPerTurn < MIN_WRONG_GUESSES ||
      wrongGuessesPerTurn > MAX_WRONG_GUESSES)
  ) {
    return null;
  }
  if (
    correctWordsPerTurn !== null &&
    (typeof correctWordsPerTurn !== "number" ||
      !Number.isInteger(correctWordsPerTurn) ||
      correctWordsPerTurn < MIN_CORRECT_WORDS ||
      correctWordsPerTurn > MAX_CORRECT_WORDS)
  ) {
    return null;
  }
  if (
    turnSeconds !== null &&
    (typeof turnSeconds !== "number" ||
      !Number.isInteger(turnSeconds) ||
      turnSeconds < MIN_TURN_SECONDS ||
      turnSeconds > MAX_TURN_SECONDS)
  ) {
    return null;
  }
  const parsed: CrosswordSettingsV1 = {
    preset,
    wrongGuessesPerTurn: wrongGuessesPerTurn as number | null,
    correctWordsPerTurn: correctWordsPerTurn as number | null,
    turnSeconds: turnSeconds as number | null,
  };
  if (ctx.mode === "solo") {
    // A solo match is either the all-unlimited casual preset or a custom
    // adjustment. Any timer or limit is a custom match and career-ineligible.
    if (parsed.preset !== "solo_casual" && parsed.preset !== "custom") {
      return null;
    }
    if (
      parsed.preset === "solo_casual" &&
      (parsed.wrongGuessesPerTurn !== null ||
        parsed.correctWordsPerTurn !== null ||
        parsed.turnSeconds !== null)
    ) {
      return null;
    }
  }
  if (ctx.mode === "quick") {
    if (
      parsed.preset !== "quick" ||
      parsed.wrongGuessesPerTurn !== 3 ||
      parsed.correctWordsPerTurn !== 1 ||
      parsed.turnSeconds !== null
    ) {
      return null;
    }
  }
  if (ctx.mode === "custom" && parsed.preset !== "custom") return null;
  return parsed;
}

function contentFrom(ctx: RuleContext): CrosswordContentV1 | null {
  const data = ctx.resource?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const content = data as unknown as CrosswordContentV1;
  if (!Array.isArray(content.rows) || !Array.isArray(content.entries)) return null;
  if (typeof content.title !== "string" || typeof content.author !== "string") {
    return null;
  }
  return content;
}

function isActiveEnabled(member: Member | undefined): member is Member {
  return Boolean(member && member.status === "active" && !member.disabled);
}

function activeEnabledMembers(ctx: RuleContext): Member[] {
  return ctx.members.filter((member) => isActiveEnabled(member));
}

/**
 * Temporary acting-host authority (Master Spec §9 C4): the permanent host
 * keeps the host field, but a disabled host hands authority to the earliest
 * active enabled member until reactivation.
 */
function actingHostMemberId(
  ctx: RuleContext,
  state: CrosswordStateV1,
): string | null {
  const host = ctx.members.find((member) => member.id === ctx.hostMemberId);
  if (isActiveEnabled(host)) return host!.id;
  for (const memberId of state.rotation) {
    const member = ctx.members.find((candidate) => candidate.id === memberId);
    if (isActiveEnabled(member)) return memberId;
  }
  return null;
}

function nextActorId(
  state: CrosswordStateV1,
  ctx: RuleContext,
  fromMemberId: string | null,
): string | null {
  const eligible = state.rotation.filter((memberId) => {
    const member = ctx.members.find((candidate) => candidate.id === memberId);
    return isActiveEnabled(member);
  });
  if (eligible.length === 0) return null;
  if (!fromMemberId) return eligible[0];
  const index = eligible.indexOf(fromMemberId);
  if (index === -1) return eligible[0];
  return eligible[(index + 1) % eligible.length];
}

function latchExclusion(
  state: CrosswordStateV1,
  reason: string,
): CrosswordStateV1 {
  if (state.exclusionReasons.includes(reason)) return state;
  return { ...state, exclusionReasons: [...state.exclusionReasons, reason] };
}

function desiredDeadlines(state: CrosswordStateV1): Array<{
  key: string;
  generation: number;
  dueAt: string;
}> {
  if (!state.turn || !state.turn.dueAt) return [];
  return [
    {
      key: TURN_DEADLINE_KEY,
      generation: state.turn.generation,
      dueAt: state.turn.dueAt,
    },
  ];
}

function newTurn(
  settings: CrosswordSettingsV1,
  generation: number,
  now: string,
  remainingMs: number | null = null,
): CrosswordTurn {
  const dueAt =
    settings.turnSeconds === null
      ? null
      : new Date(
          Date.parse(now) + (remainingMs ?? settings.turnSeconds * 1000),
        ).toISOString();
  return { generation, wrong: 0, correct: 0, startedAt: now, dueAt };
}

function factValue(
  facts: readonly Fact[],
  principalId: string,
  key: string,
): unknown {
  return facts.find(
    (fact) => fact.principalId === principalId && fact.key === key,
  )?.value;
}

function seenInOtherMatch(
  facts: readonly Fact[],
  principalId: string,
  matchId: string,
): boolean {
  const value = factValue(facts, principalId, CROSSWORD_FACT_SEEN);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const factMatchId = (value as Record<string, unknown>).matchId;
  return typeof factMatchId === "string" && factMatchId !== matchId;
}

function importedPuzzle(
  facts: readonly Fact[],
  principalId: string,
): boolean {
  return factValue(facts, principalId, CROSSWORD_FACT_IMPORTED) !== undefined;
}

function entriesAtCell(
  content: CrosswordContentV1,
  row: number,
  col: number,
): CrosswordEntry[] {
  return content.entries.filter((entry) =>
    entry.cells.some((cell) => cell.row === row && cell.col === col),
  );
}

/**
 * Applies revealed letters. Every word that still crosses a newly revealed
 * cell becomes assisted, so it can complete later but never scores. Words
 * completed only by crossings earn no points.
 */
function applyReveal(
  state: CrosswordStateV1,
  content: CrosswordContentV1,
  fills: Array<{ row: number; col: number; letter: string }>,
  assistedEntryIds: string[],
): { board: Array<string | null>; words: Record<string, CrosswordWordState> } {
  const colCount = content.rows[0]?.length ?? 0;
  const board = [...state.board];
  for (const fill of fills) {
    board[fill.row * colCount + fill.col] = fill.letter;
  }
  const words: Record<string, CrosswordWordState> = { ...state.words };
  for (const id of assistedEntryIds) {
    const word = words[id];
    if (!word || word.completed) continue;
    words[id] = { ...word, assisted: true };
  }
  for (const entry of content.entries) {
    if (words[entry.id]?.completed) continue;
    const filled = entry.cells.every(
      (cell) => board[cell.row * colCount + cell.col] !== null,
    );
    if (filled) {
      words[entry.id] = {
        completed: true,
        explicitSolver: null,
        assisted: words[entry.id]?.assisted ?? false,
      };
    }
  }
  return { board, words };
}

// BL-049: every finish path derives completedWords from the final state's
// own completion flags, never from the entry count, so the retained result
// cannot drift from the state it describes. (On the reveal/solved paths the
// finish is gated on allComplete, so the values coincide today; deriving
// them keeps the invariant true by construction.)
function countCompletedWords(
  words: Record<string, CrosswordWordState>,
): number {
  return Object.values(words).filter((word) => word.completed).length;
}

function buildView(
  ctx: RuleContext,
  state: CrosswordStateV1,
  viewer: ViewerContext,
  settings: CrosswordSettingsV1,
  content: CrosswordContentV1 | null,
): CrosswordView {
  const isSolo = ctx.mode === "solo";
  const memberId = viewer.memberId;
  const myFeedback = memberId ? state.privateFeedback[memberId] ?? null : null;
  const published = ctx.phase !== "lobby" && content !== null;
  const clues: CrosswordClueView[] | null = published
    ? content.entries.map((entry) => ({
        id: entry.id,
        number: entry.number,
        direction: entry.direction,
        row: entry.row,
        col: entry.col,
        length: entry.length,
        cells: entry.cells.map((cell) => ({ row: cell.row, col: cell.col })),
        text: entry.clue,
      }))
    : null;
  const blocked = published
    ? content.rows.flatMap((row) => Array.from(row, (cell) => cell === "#"))
    : null;
  const myScore = memberId ? state.scores[memberId] ?? null : null;
  const isMyTurn =
    memberId !== null &&
    state.currentMemberId === memberId &&
    ctx.phase === "active" &&
    !state.suspended &&
    !state.soloAwaitingContinue;

  return {
    phase: ctx.phase ?? "lobby",
    mode: ctx.mode,
    preset: settings.preset,
    title: content?.title ?? null,
    author: content?.author ?? null,
    difficulty: content?.difficulty ?? null,
    attribution: content?.rights.attribution ?? null,
    license: content?.rights.license ?? null,
    rows: content ? content.rows.length : null,
    cols: content ? content.rows[0]?.length ?? 0 : null,
    numbers: published ? content.numbers : null,
    blocked,
    clues,
    board: published ? [...state.board] : null,
    completedWordIds: Object.entries(state.words)
      .filter(([, word]) => word.completed)
      .map(([id]) => id),
    assistedWordIds: Object.entries(state.words)
      .filter(([, word]) => word.assisted)
      .map(([id]) => id),
    scores: { ...state.scores },
    rotation: [...state.rotation],
    currentMemberId: state.currentMemberId,
    actingHostMemberId: actingHostMemberId(ctx, state),
    myMemberId: memberId,
    myScore,
    privateFeedback: myFeedback,
    turnGeneration: state.turn?.generation ?? null,
    turnDueAt: state.turn?.dueAt ?? null,
    soloAwaitingContinue: state.soloAwaitingContinue,
    suspended: state.suspended,
    suspendedRemainingMs: state.suspendedRemainingMs,
    timeoutRemovalEligible: [...state.timeoutRemovalEligible],
    exclusionReasons: [...state.exclusionReasons],
    canReveal: isSolo && ctx.phase === "active" && !state.suspended,
    canDeclareExposure: ctx.members.some(
      (member) =>
        member.id === memberId && member.status === "active" && !member.disabled,
    ),
    canSubmitWord: isMyTurn,
    canPass: isMyTurn,
  };
}

function buildParticipants(
  ctx: RuleContext,
  state: CrosswordStateV1,
  winners: string[],
  matchWideExclusions: string[],
): FinalParticipant[] {
  return ctx.members.map((member) => {
    const score = state.scores[member.id] ?? 0;
    const reasons = [...matchWideExclusions];
    if (ctx.mode === "solo") reasons.push(CROSSWORD_EXCLUSION_SOLO_MODE);
    if (member.kind === "guest") reasons.push(CROSSWORD_EXCLUSION_GUEST_PLAYER);
    return {
      memberId: member.id,
      score,
      contribution: {
        wordsSolved: Object.values(state.words).filter(
          (word) => word.completed && word.explicitSolver === member.id,
        ).length,
        mode: ctx.mode,
      },
      win: winners.includes(member.id),
      careerEligible:
        reasons.length === 0 &&
        member.kind === "registered" &&
        ctx.mode !== "solo",
      exclusionReasons: reasons,
    };
  });
}

/**
 * Ends the current turn. A multiplayer turn moves to the next active enabled
 * participant; a solo turn pauses awaiting the Continue action. When nobody is
 * enabled the match suspends with its counters preserved.
 */
function endTurn(
  state: CrosswordStateV1,
  ctx: RuleContext,
  settings: CrosswordSettingsV1,
  isSolo: boolean,
): CrosswordStateV1 {
  const generation = (state.turn?.generation ?? 0) + 1;
  // An ended turn keeps its counters and generation but runs no deadline.
  const idleTurn = state.turn ? { ...state.turn, dueAt: null } : null;
  if (isSolo) {
    return {
      ...state,
      turn: idleTurn,
      currentMemberId: null,
      soloAwaitingContinue: true,
      suspended: false,
      suspendedRemainingMs: null,
    };
  }
  const nextActor = nextActorId(state, ctx, state.currentMemberId);
  if (!nextActor) {
    return {
      ...state,
      turn: idleTurn,
      currentMemberId: null,
      soloAwaitingContinue: false,
      suspended: true,
      suspendedRemainingMs: state.turn?.dueAt
        ? Math.max(0, Date.parse(state.turn.dueAt) - Date.parse(ctx.now))
        : null,
    };
  }
  return {
    ...state,
    turn: newTurn(settings, generation, ctx.now),
    currentMemberId: nextActor,
    soloAwaitingContinue: false,
    suspended: false,
    suspendedRemainingMs: null,
  };
}

export const server: GameServer<CrosswordStateV1, CrosswordView> =
  defineGameServer<CrosswordStateV1, CrosswordView>({
    authority(
      ctx: RuleContext,
      state: CrosswordStateV1,
      memberId: string,
    ): AuthorityResult {
      const host = actingHostMemberId(ctx, state);
      const isHost = host !== null && host === memberId;
      const minPlayers = ctx.mode === "solo" ? 1 : 2;
      const canStart =
        ctx.phase === "lobby" &&
        isHost &&
        activeEnabledMembers(ctx).length >= minPlayers;
      const canFinish = ctx.phase === "active" && isHost;
      const removableMemberIds =
        isHost && ctx.phase === "active"
          ? state.timeoutRemovalEligible.filter((id) => id !== memberId)
          : [];
      return { canStart, canFinish, removableMemberIds };
    },

    importResource(input: Json, ctx: { principalId: string; now: string }) {
      const parsed = parseCrosswordImport(input);
      if (!parsed.ok) {
        throw new ResourceImportError(parsed.errors);
      }
      return {
        identity: parsed.identity,
        metadata: crosswordPublicMetadata(parsed.content) as unknown as Json,
        data: parsed.content as unknown as Json,
        importerFacts: [
          {
            key: CROSSWORD_FACT_IMPORTED,
            value: {
              importedAt: ctx.now,
              resourceIdentity: parsed.identity,
            },
          },
        ],
      };
    },

    transition(
      ctx: RuleContext,
      state: CrosswordStateV1 | null,
      event: GameEvent,
    ): TransitionResult<CrosswordStateV1> {
      const settings = parseSettings(ctx);
      if (!settings) {
        return ruleError(
          "INVALID_SETTINGS",
          "The match settings are not valid for this mode.",
        );
      }
      const content = contentFrom(ctx);
      if (!content) {
        return ruleError(
          "MISSING_RESOURCE",
          "This match has no puzzle resource attached.",
        );
      }
      const isSolo = ctx.mode === "solo";
      const colCount = content.rows[0]?.length ?? 0;

      if (event.kind === "create") {
        const words: Record<string, CrosswordWordState> = {};
        for (const entry of content.entries) {
          words[entry.id] = {
            completed: false,
            explicitSolver: null,
            assisted: false,
          };
        }
        const initialState: CrosswordStateV1 = {
          board: new Array(content.rows.length * colCount).fill(null),
          words,
          scores: {},
          rotation: ctx.members.map((member) => member.id),
          currentMemberId: null,
          turn: null,
          soloAwaitingContinue: false,
          suspended: false,
          suspendedRemainingMs: null,
          timeoutRemovalEligible: [],
          privateFeedback: {},
          exclusionReasons: [],
        };
        for (const member of ctx.members) {
          initialState.scores[member.id] = 0;
          initialState.privateFeedback[member.id] = {
            turnGeneration: 0,
            lastWrongGuess: null,
            remainingWrong: null,
          };
        }
        const nextState =
          settings.preset === "custom"
            ? latchExclusion(initialState, CROSSWORD_EXCLUSION_CUSTOM_RULES)
            : initialState;
        return {
          ok: true,
          value: {
            state: nextState,
            phase: "lobby",
            hostMemberId: ctx.hostMemberId,
            deadlines: [],
            needsActionFrom: [],
            facts: [],
            final: null,
          },
        };
      }

      if (!state) {
        return ruleError("INVALID_STATE", "The match state is not initialized.");
      }

      if (event.kind === "join") {
        const { memberId, rejoin } = event;
        const rotation = state.rotation.includes(memberId)
          ? state.rotation
          : [...state.rotation, memberId];
        const scores = { ...state.scores };
        const privateFeedback = { ...state.privateFeedback };
        if (!rejoin && scores[memberId] === undefined) {
          scores[memberId] = 0;
          privateFeedback[memberId] = {
            turnGeneration: 0,
            lastWrongGuess: null,
            remainingWrong: null,
          };
        }
        let nextState: CrosswordStateV1 = {
          ...state,
          rotation,
          scores,
          privateFeedback,
        };
        const facts: Array<{ principalId: string; key: string; value: Json }> = [];

        if (ctx.phase === "active" && !rejoin) {
          const member = ctx.members.find((candidate) => candidate.id === memberId);
          if (member) {
            if (importedPuzzle(ctx.facts, member.principalId)) {
              nextState = latchExclusion(
                nextState,
                CROSSWORD_EXCLUSION_IMPORTER_EXPOSURE,
              );
            } else if (
              seenInOtherMatch(ctx.facts, member.principalId, ctx.matchId)
            ) {
              nextState = latchExclusion(
                nextState,
                CROSSWORD_EXCLUSION_PRIOR_EXPOSURE,
              );
            }
            facts.push({
              principalId: member.principalId,
              key: CROSSWORD_FACT_SEEN,
              value: { matchId: ctx.matchId, seenAt: ctx.now },
            });
          }
        }

        return {
          ok: true,
          value: {
            state: nextState,
            phase: ctx.phase ?? "lobby",
            hostMemberId: ctx.hostMemberId,
            deadlines: desiredDeadlines(nextState),
            needsActionFrom:
              ctx.phase === "active" && nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
            facts,
            final: null,
          },
        };
      }

      if (event.kind === "start") {
        if (ctx.phase !== "lobby") {
          return ruleError("ALREADY_STARTED", "The match has already started.");
        }
        const participants = activeEnabledMembers(ctx);
        const minPlayers = isSolo ? 1 : 2;
        if (participants.length < minPlayers) {
          return ruleError(
            "INSUFFICIENT_PLAYERS",
            `This mode needs at least ${minPlayers} active players.`,
          );
        }
        let nextState: CrosswordStateV1 = { ...state };
        const facts: Array<{ principalId: string; key: string; value: Json }> = [];
        for (const member of participants) {
          if (importedPuzzle(ctx.facts, member.principalId)) {
            nextState = latchExclusion(
              nextState,
              CROSSWORD_EXCLUSION_IMPORTER_EXPOSURE,
            );
          } else if (seenInOtherMatch(ctx.facts, member.principalId, ctx.matchId)) {
            nextState = latchExclusion(
              nextState,
              CROSSWORD_EXCLUSION_PRIOR_EXPOSURE,
            );
          }
          facts.push({
            principalId: member.principalId,
            key: CROSSWORD_FACT_SEEN,
            value: { matchId: ctx.matchId, seenAt: ctx.now },
          });
        }
        const rotation = participants.map((member) => member.id);
        const currentMemberId = rotation[0] ?? null;
        nextState = {
          ...nextState,
          rotation,
          currentMemberId,
          turn: newTurn(settings, 1, ctx.now),
          soloAwaitingContinue: false,
          suspended: false,
          suspendedRemainingMs: null,
        };
        return {
          ok: true,
          value: {
            state: nextState,
            phase: "active",
            hostMemberId: ctx.hostMemberId,
            deadlines: desiredDeadlines(nextState),
            needsActionFrom: currentMemberId ? [currentMemberId] : [],
            facts,
            final: null,
          },
        };
      }

      if (event.kind === "action") {
        const actorMemberId = ctx.actor?.memberId ?? null;
        const actor = ctx.members.find((member) => member.id === actorMemberId);
        if (!actorMemberId || !isActiveEnabled(actor)) {
          return ruleError("NOT_A_MEMBER", "Only active members can act.");
        }
        const payload =
          typeof event.payload === "object" && event.payload !== null
            ? (event.payload as Record<string, unknown>)
            : {};

        if (event.type === "declare_exposure") {
          // A declaration is valid in the lobby and during play, and it
          // latches the match-wide career exclusion before the start.
          if (ctx.phase === "finished") {
            return ruleError("NOT_ACTIVE", "The match is not active.");
          }
          const nextState = latchExclusion(
            state,
            CROSSWORD_EXCLUSION_DECLARED_EXPOSURE,
          );
          return {
            ok: true,
            value: {
              state: nextState,
              phase: ctx.phase ?? "lobby",
              hostMemberId: ctx.hostMemberId,
              deadlines: desiredDeadlines(nextState),
              needsActionFrom: nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
              facts: [
                {
                  principalId: actor.principalId,
                  key: CROSSWORD_FACT_DECLARED,
                  value: { matchId: ctx.matchId, declaredAt: ctx.now },
                },
              ],
              final: null,
            },
          };
        }

        if (ctx.phase !== "active") {
          return ruleError("NOT_ACTIVE", "The match is not active.");
        }
        if (state.suspended) {
          return ruleError(
            "MATCH_SUSPENDED",
            "The match is suspended until an enabled member returns.",
          );
        }

        if (
          event.type === "reveal_letter" ||
          event.type === "reveal_word" ||
          event.type === "reveal_puzzle"
        ) {
          if (!isSolo) {
            return ruleError(
              "REVEALS_ARE_SOLO_ONLY",
              "Reveals are only available in a solo match.",
            );
          }
        }

        if (event.type === "pass") {
          if (state.soloAwaitingContinue) {
            return ruleError(
              "AWAITING_CONTINUE",
              "The solo turn is waiting for the Continue action.",
            );
          }
          if (actorMemberId !== state.currentMemberId) {
            return ruleError(
              "NOT_CURRENT_ACTOR",
              "Only the current player can pass.",
            );
          }
          const generation = (state.turn?.generation ?? 0) + 1;
          let nextState: CrosswordStateV1 = {
            ...state,
            timeoutRemovalEligible: state.timeoutRemovalEligible.filter(
              (id) => id !== actorMemberId,
            ),
            soloAwaitingContinue: false,
          };
          if (isSolo) {
            nextState = {
              ...nextState,
              turn: newTurn(settings, generation, ctx.now),
              currentMemberId: actorMemberId,
            };
          } else {
            const nextActor = nextActorId(state, ctx, actorMemberId);
            nextState = {
              ...nextState,
              currentMemberId: nextActor,
              turn: nextActor
                ? newTurn(settings, generation, ctx.now)
                : null,
              suspended: nextActor === null,
              suspendedRemainingMs:
                nextActor === null && state.turn?.dueAt
                  ? Math.max(
                      0,
                      Date.parse(state.turn.dueAt) - Date.parse(ctx.now),
                    )
                  : null,
            };
          }
          return {
            ok: true,
            value: {
              state: nextState,
              phase: "active",
              hostMemberId: ctx.hostMemberId,
              deadlines: desiredDeadlines(nextState),
              needsActionFrom: nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
              facts: [],
              final: null,
            },
          };
        }

        if (event.type === "continue") {
          if (!isSolo) {
            return ruleError(
              "CONTINUE_IS_SOLO_ONLY",
              "Only a solo match can continue.",
            );
          }
          if (!state.soloAwaitingContinue) {
            return ruleError(
              "NOT_AWAITING_CONTINUE",
              "The solo turn is not waiting to continue.",
            );
          }
          const turn = newTurn(
            settings,
            (state.turn?.generation ?? 0) + 1,
            ctx.now,
          );
          const nextState: CrosswordStateV1 = {
            ...state,
            turn,
            soloAwaitingContinue: false,
            currentMemberId: state.rotation[0] ?? null,
          };
          return {
            ok: true,
            value: {
              state: nextState,
              phase: "active",
              hostMemberId: ctx.hostMemberId,
              deadlines: desiredDeadlines(nextState),
              needsActionFrom: nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
              facts: [],
              final: null,
            },
          };
        }

        if (
          event.type === "reveal_letter" ||
          event.type === "reveal_word" ||
          event.type === "reveal_puzzle"
        ) {
          const fills: Array<{ row: number; col: number; letter: string }> = [];
          const assistedEntryIds = new Set<string>();
          if (event.type === "reveal_letter") {
            const row = payload.row;
            const col = payload.col;
            if (
              typeof row !== "number" ||
              !Number.isInteger(row) ||
              typeof col !== "number" ||
              !Number.isInteger(col)
            ) {
              return ruleError(
                "MALFORMED_REVEAL",
                "A cell reveal needs integer row and col.",
              );
            }
            if (
              row < 0 ||
              col < 0 ||
              row >= content.rows.length ||
              col >= colCount
            ) {
              return ruleError("OUT_OF_RANGE", "That cell is not on the grid.");
            }
            if (content.rows[row][col] === "#") {
              return ruleError(
                "NOT_A_CELL",
                "That cell is blocked and cannot be revealed.",
              );
            }
            if (state.board[row * colCount + col] !== null) {
              return ruleError(
                "ALREADY_FILLED",
                "That cell is already filled.",
              );
            }
            fills.push({ row, col, letter: content.rows[row][col] });
            for (const entry of entriesAtCell(content, row, col)) {
              assistedEntryIds.add(entry.id);
            }
          } else if (event.type === "reveal_word") {
            const wordId = typeof payload.wordId === "string" ? payload.wordId : "";
            const entry = content.entries.find(
              (candidate) => candidate.id === wordId,
            );
            if (!entry) {
              return ruleError(
                "UNKNOWN_WORD",
                "That word is not part of this puzzle.",
              );
            }
            for (const cell of entry.cells) {
              if (state.board[cell.row * colCount + cell.col] !== null) continue;
              fills.push({
                row: cell.row,
                col: cell.col,
                letter: content.rows[cell.row][cell.col],
              });
            }
            if (fills.length === 0) {
              return ruleError(
                "ALREADY_FILLED",
                "That word is already filled.",
              );
            }
            for (const fill of fills) {
              for (const crossing of entriesAtCell(
                content,
                fill.row,
                fill.col,
              )) {
                assistedEntryIds.add(crossing.id);
              }
            }
          } else {
            content.rows.forEach((row, rowIndex) => {
              Array.from(row).forEach((character, colIndex) => {
                if (character === "#") return;
                if (state.board[rowIndex * colCount + colIndex] !== null) return;
                fills.push({
                  row: rowIndex,
                  col: colIndex,
                  letter: character,
                });
              });
            });
            if (fills.length === 0) {
              return ruleError(
                "ALREADY_FILLED",
                "The puzzle is already revealed.",
              );
            }
            for (const fill of fills) {
              for (const crossing of entriesAtCell(
                content,
                fill.row,
                fill.col,
              )) {
                assistedEntryIds.add(crossing.id);
              }
            }
          }

          const revealed = applyReveal(
            state,
            content,
            fills,
            [...assistedEntryIds],
          );
          const nextState: CrosswordStateV1 = {
            ...state,
            board: revealed.board,
            words: revealed.words,
          };
          const allComplete = content.entries.every(
            (entry) => revealed.words[entry.id]?.completed,
          );
          if (allComplete || event.type === "reveal_puzzle") {
            const scores = { ...state.scores };
            const maxScore = Math.max(0, ...Object.values(scores));
            const winners =
              maxScore > 0
                ? Object.entries(scores)
                    .filter(([, score]) => score === maxScore)
                    .map(([id]) => id)
                : [];
            const final: FinalResult = {
              outcome: "revealed",
              data: {
                mode: ctx.mode,
                preset: settings.preset,
                completedWords: countCompletedWords(revealed.words),
                totalWords: content.entries.length,
                winners: [],
                attribution: crosswordPublicMetadata(content) as unknown as Json,
              },
              participants: buildParticipants(
                ctx,
                nextState,
                [],
                nextState.exclusionReasons,
              ),
            };
            return {
              ok: true,
              value: {
                state: { ...nextState, currentMemberId: null, turn: null },
                phase: "finished",
                hostMemberId: ctx.hostMemberId,
                deadlines: [],
                needsActionFrom: [],
                facts: [],
                final,
              },
            };
          }
          return {
            ok: true,
            value: {
              state: nextState,
              phase: "active",
              hostMemberId: ctx.hostMemberId,
              deadlines: desiredDeadlines(nextState),
              needsActionFrom: nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
              facts: [],
              final: null,
            },
          };
        }

        if (event.type === "submit_word") {
          if (state.soloAwaitingContinue) {
            return ruleError(
              "AWAITING_CONTINUE",
              "The solo turn is waiting for the Continue action.",
            );
          }
          if (actorMemberId !== state.currentMemberId) {
            return ruleError(
              "NOT_CURRENT_ACTOR",
              "Only the current player can submit a word.",
            );
          }
          const wordId = typeof payload.wordId === "string" ? payload.wordId : "";
          const rawAnswer =
            typeof payload.answer === "string" ? payload.answer : "";
          const entry = content.entries.find(
            (candidate) => candidate.id === wordId,
          );
          if (!entry) {
            return ruleError(
              "UNKNOWN_WORD",
              "That word is not part of this puzzle.",
            );
          }
          const answer = normalizeAnswer(rawAnswer);
          if (answer === null || answer.length !== entry.length) {
            return ruleError(
              "MALFORMED_ANSWER",
              "The answer must be letters matching the entry length.",
            );
          }
          const existing = state.words[entry.id];
          if (!existing || existing.completed) {
            return ruleError("ALREADY_FILLED", "That word is already complete.");
          }
          let conflicts = false;
          entry.cells.forEach((cell, index) => {
            const filled = state.board[cell.row * colCount + cell.col];
            if (filled !== null && filled !== answer[index]) conflicts = true;
          });
          if (conflicts) {
            return ruleError(
              "CONFLICTING_CROSSING",
              "The answer conflicts with an already solved crossing letter.",
            );
          }

          const turn = state.turn ?? newTurn(settings, 1, ctx.now);

          if (answer !== entry.answer) {
            const updatedTurn: CrosswordTurn = {
              ...turn,
              wrong: turn.wrong + 1,
            };
            const privateFeedback = { ...state.privateFeedback };
            privateFeedback[actorMemberId] = {
              turnGeneration: updatedTurn.generation,
              lastWrongGuess: answer,
              remainingWrong:
                settings.wrongGuessesPerTurn === null
                  ? null
                  : Math.max(0, settings.wrongGuessesPerTurn - updatedTurn.wrong),
            };
            let nextState: CrosswordStateV1 = {
              ...state,
              turn: updatedTurn,
              privateFeedback,
              // An accepted wrong guess is a voluntary gameplay action, so
              // it clears the actor's timeout-removal flag (Spec §9 C4).
              timeoutRemovalEligible: state.timeoutRemovalEligible.filter(
                (id) => id !== actorMemberId,
              ),
            };
            if (
              settings.wrongGuessesPerTurn !== null &&
              updatedTurn.wrong >= settings.wrongGuessesPerTurn
            ) {
              nextState = endTurn(nextState, ctx, settings, isSolo);
            }
            return {
              ok: true,
              value: {
                state: nextState,
                phase: "active",
                hostMemberId: ctx.hostMemberId,
                deadlines: desiredDeadlines(nextState),
                needsActionFrom: nextState.currentMemberId
                  ? [nextState.currentMemberId]
                  : [],
                facts: [],
                final: null,
              },
            };
          }

          const board = [...state.board];
          const words: Record<string, CrosswordWordState> = { ...state.words };
          entry.cells.forEach((cell, index) => {
            board[cell.row * colCount + cell.col] = answer[index];
          });
          const scored = !existing.assisted;
          words[entry.id] = {
            completed: true,
            explicitSolver: scored ? actorMemberId : null,
            assisted: existing.assisted,
          };
          const scores = { ...state.scores };
          if (scored) {
            scores[actorMemberId] = (scores[actorMemberId] ?? 0) + 1;
          }
          for (const other of content.entries) {
            if (words[other.id]?.completed) continue;
            const filled = other.cells.every(
              (cell) => board[cell.row * colCount + cell.col] !== null,
            );
            if (filled) {
              words[other.id] = {
                completed: true,
                explicitSolver: null,
                assisted: words[other.id]?.assisted ?? false,
              };
            }
          }
          const allComplete = content.entries.every(
            (candidate) => words[candidate.id]?.completed,
          );

          let nextState: CrosswordStateV1 = {
            ...state,
            board,
            words,
            scores,
            timeoutRemovalEligible: state.timeoutRemovalEligible.filter(
              (id) => id !== actorMemberId,
            ),
          };

          if (allComplete) {
            const maxScore = Math.max(0, ...Object.values(scores));
            const winners =
              maxScore > 0
                ? Object.entries(scores)
                    .filter(([, score]) => score === maxScore)
                    .map(([id]) => id)
                : [];
            const final: FinalResult = {
              outcome: "solved",
              data: {
                mode: ctx.mode,
                preset: settings.preset,
                completedWords: countCompletedWords(words),
                totalWords: content.entries.length,
                winners,
                attribution: crosswordPublicMetadata(content) as unknown as Json,
              },
              participants: buildParticipants(
                ctx,
                nextState,
                winners,
                nextState.exclusionReasons,
              ),
            };
            nextState = {
              ...nextState,
              currentMemberId: null,
              turn: null,
              soloAwaitingContinue: false,
            };
            return {
              ok: true,
              value: {
                state: nextState,
                phase: "finished",
                hostMemberId: ctx.hostMemberId,
                deadlines: [],
                needsActionFrom: [],
                facts: [],
                final,
              },
            };
          }

          const updatedTurn: CrosswordTurn = {
            ...turn,
            correct: turn.correct + 1,
          };
          const privateFeedback = { ...state.privateFeedback };
          privateFeedback[actorMemberId] = {
            turnGeneration: updatedTurn.generation,
            lastWrongGuess: privateFeedback[actorMemberId]?.lastWrongGuess ?? null,
            remainingWrong:
              settings.wrongGuessesPerTurn === null
                ? null
                : Math.max(0, settings.wrongGuessesPerTurn - updatedTurn.wrong),
          };
          nextState = { ...nextState, turn: updatedTurn, privateFeedback };

          const wrongLimitReached =
            settings.wrongGuessesPerTurn !== null &&
            updatedTurn.wrong >= settings.wrongGuessesPerTurn;
          const correctLimitReached =
            settings.correctWordsPerTurn !== null &&
            updatedTurn.correct >= settings.correctWordsPerTurn;
          if (wrongLimitReached || correctLimitReached) {
            nextState = endTurn(nextState, ctx, settings, isSolo);
          }
          return {
            ok: true,
            value: {
              state: nextState,
              phase: "active",
              hostMemberId: ctx.hostMemberId,
              deadlines: desiredDeadlines(nextState),
              needsActionFrom: nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
              facts: [],
              final: null,
            },
          };
        }

        return ruleError("UNKNOWN_ACTION", `Unsupported action '${event.type}'.`);
      }

      if (event.kind === "deadline") {
        if (ctx.phase !== "active") {
          return ruleError("NOT_ACTIVE", "The match is not active.");
        }
        const expired = state.currentMemberId;
        const timeoutRemovalEligible = expired
          ? state.timeoutRemovalEligible.includes(expired)
            ? state.timeoutRemovalEligible
            : [...state.timeoutRemovalEligible, expired]
          : state.timeoutRemovalEligible;
        let nextState: CrosswordStateV1 = { ...state, timeoutRemovalEligible };
        nextState = endTurn(nextState, ctx, settings, isSolo);
        return {
          ok: true,
          value: {
            state: nextState,
            phase: "active",
            hostMemberId: ctx.hostMemberId,
            deadlines: desiredDeadlines(nextState),
            needsActionFrom: nextState.currentMemberId
              ? [nextState.currentMemberId]
              : [],
            facts: [],
            final: null,
          },
        };
      }

      if (event.kind === "leave") {
        const leaving = event.memberId;
        const rotation = state.rotation.filter((id) => id !== leaving);
        const remainingMembers = ctx.members.filter(
          (member) => member.id !== leaving && member.status === "active",
        );
        const hostMemberId =
          ctx.hostMemberId === leaving
            ? rotation.find((id) =>
                ctx.members.some(
                  (member) => member.id === id && member.status === "active",
                ),
              ) ?? null
            : ctx.hostMemberId;

        let nextState: CrosswordStateV1 = {
          ...state,
          rotation,
          timeoutRemovalEligible: state.timeoutRemovalEligible.filter(
            (id) => id !== leaving,
          ),
        };

        if (remainingMembers.length === 0) {
          nextState = latchExclusion(nextState, CROSSWORD_EXCLUSION_ALL_LEFT);
          const final: FinalResult = {
            outcome: "abandoned",
            data: {
              mode: ctx.mode,
              preset: settings.preset,
              completedWords: countCompletedWords(state.words),
              totalWords: content.entries.length,
              winners: [],
              attribution: crosswordPublicMetadata(content) as unknown as Json,
            },
            participants: buildParticipants(
              ctx,
              nextState,
              [],
              nextState.exclusionReasons,
            ),
          };
          nextState = { ...nextState, currentMemberId: null, turn: null };
          return {
            ok: true,
            value: {
              state: nextState,
              phase: "finished",
              hostMemberId: null,
              deadlines: [],
              needsActionFrom: [],
              facts: [],
              final,
            },
          };
        }

        if (!isSolo && ctx.phase === "active" && remainingMembers.length === 1) {
          nextState = latchExclusion(
            nextState,
            CROSSWORD_EXCLUSION_PARTICIPANT_DROPPED,
          );
        }

        if (state.currentMemberId === leaving) {
          nextState = endTurn(nextState, ctx, settings, isSolo);
        }

        return {
          ok: true,
          value: {
            state: nextState,
            phase: ctx.phase ?? "lobby",
            hostMemberId,
            deadlines: desiredDeadlines(nextState),
            needsActionFrom:
              ctx.phase === "active" && nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
            facts: [],
            final: null,
          },
        };
      }

      if (event.kind === "principal_status") {
        let nextState: CrosswordStateV1 = { ...state };
        if (event.disabled) {
          if (state.currentMemberId === event.memberId) {
            nextState = endTurn(nextState, ctx, settings, isSolo);
          }
        } else if (state.suspended) {
          const actor = nextActorId(nextState, ctx, null);
          nextState = {
            ...nextState,
            currentMemberId: actor,
            turn: newTurn(
              settings,
              (state.turn?.generation ?? 0) + 1,
              ctx.now,
              state.suspendedRemainingMs,
            ),
            suspended: false,
            suspendedRemainingMs: null,
          };
        }
        return {
          ok: true,
          value: {
            state: nextState,
            phase: ctx.phase ?? "lobby",
            hostMemberId: ctx.hostMemberId,
            deadlines: desiredDeadlines(nextState),
            needsActionFrom:
              ctx.phase === "active" && nextState.currentMemberId
                ? [nextState.currentMemberId]
                : [],
            facts: [],
            final: null,
          },
        };
      }

      if (event.kind === "finish") {
        let nextState = latchExclusion(state, CROSSWORD_EXCLUSION_HOST_ENDED_EARLY);
        const final: FinalResult = {
          outcome: "ended_early",
          data: {
            mode: ctx.mode,
            preset: settings.preset,
            completedWords: countCompletedWords(state.words),
            totalWords: content.entries.length,
            winners: [],
            attribution: crosswordPublicMetadata(content) as unknown as Json,
          },
          participants: buildParticipants(
            ctx,
            nextState,
            [],
            nextState.exclusionReasons,
          ),
        };
        nextState = { ...nextState, currentMemberId: null, turn: null };
        return {
          ok: true,
          value: {
            state: nextState,
            phase: "finished",
            hostMemberId: ctx.hostMemberId,
            deadlines: [],
            needsActionFrom: [],
            facts: [],
            final,
          },
        };
      }

      return ruleError("UNHANDLED_EVENT", "The event kind is not supported.");
    },

    view(
      ctx: RuleContext,
      state: CrosswordStateV1,
      viewer: ViewerContext,
    ): CrosswordView {
      const settings = parseSettings(ctx);
      if (!settings) {
        throw new Error("Invalid crossword settings");
      }
      return buildView(ctx, state, viewer, settings, contentFrom(ctx));
    },

    summary(
      ctx: RuleContext,
      state: CrosswordStateV1,
      viewerPrincipalId: string,
    ): MatchSummary {
      const completed = Object.values(state.words).filter(
        (word) => word.completed,
      ).length;
      const total = Object.keys(state.words).length;
      const viewer = ctx.members.find(
        (member) => member.principalId === viewerPrincipalId,
      );
      return {
        label: `Crossword ${completed}/${total}`,
        needsAction:
          Boolean(viewer) &&
          state.currentMemberId === viewer!.id &&
          ctx.phase === "active" &&
          !state.suspended,
        detail: `Mode: ${ctx.mode}`,
      };
    },

    resultView(ctx: RuleContext, result: FinalResult): Json {
      const content = contentFrom(ctx);
      return {
        outcome: result.outcome,
        data: result.data,
        participants: result.participants.map((participant) => ({
          memberId: participant.memberId,
          score: participant.score,
          win: participant.win,
          careerEligible: participant.careerEligible,
          exclusionReasons: participant.exclusionReasons,
        })),
        attribution: content
          ? (crosswordPublicMetadata(content) as unknown as Json)
          : null,
      };
    },

    career(result: FinalResult): CareerMetric[] {
      return result.participants
        .filter((participant) => participant.careerEligible)
        .map((participant) => ({
          memberId: participant.memberId,
          points: participant.score,
          played: 1,
          wins: participant.win ? 1 : 0,
        }));
    },
  });
