// SPDX-License-Identifier: Apache-2.0
import {
  defineGameServer,
  type FinalResult,
  type GameServer,
  type RuleContext,
  type Transition,
  type TransitionResult,
} from "@next-round/game-sdk";
import { parseTriviaImport } from "./content.js";
import type {
  TriviaBank,
  TriviaSettings,
  TriviaState,
  TriviaView,
} from "./types.js";

const enabled = (ctx: RuleContext) =>
  ctx.members.filter((m) => m.status === "active" && !m.disabled);
const settings = (ctx: RuleContext) =>
  ctx.settings as unknown as TriviaSettings;
const bank = (ctx: RuleContext) => ctx.resource?.data as TriviaBank | undefined;
const failure = (
  code: string,
  message: string,
): TransitionResult<TriviaState> => ({ ok: false, error: { code, message } });

function obligations(ctx: RuleContext, state: TriviaState): string[] {
  if (ctx.phase !== "active" || state.suspended) return [];
  return enabled(ctx)
    .filter(
      (m) =>
        state.roundMemberIds.includes(m.id) &&
        state.answers[m.id] === undefined,
    )
    .map((m) => m.id);
}

function transition(
  ctx: RuleContext,
  state: TriviaState,
  phase = ctx.phase ?? "lobby",
  final: FinalResult | null = null,
): TransitionResult<TriviaState> {
  const active = enabled(ctx);
  const host = active.some((m) => m.id === ctx.hostMemberId)
    ? ctx.hostMemberId
    : (active[0]?.id ?? ctx.hostMemberId);
  const value: Transition<TriviaState> = {
    state,
    phase,
    hostMemberId: host,
    deadlines:
      phase === "active" && state.dueAt !== null && !state.suspended
        ? [{ key: "round", generation: state.generation, dueAt: state.dueAt }]
        : [],
    needsActionFrom:
      phase === "active" ? obligations({ ...ctx, phase }, state) : [],
    facts: [],
    final,
  };
  return { ok: true, value };
}

/** Pause only when no enabled active members remain, retaining the exact round. */
function membership(ctx: RuleContext, state: TriviaState): TriviaState {
  if (ctx.phase !== "active") return state;
  const hasEnabled = enabled(ctx).length > 0;
  if (!hasEnabled && !state.suspended) {
    return {
      ...state,
      suspended: true,
      suspendedRemainingMs: Math.max(
        0,
        Date.parse(state.dueAt!) - Date.parse(ctx.now),
      ),
      dueAt: null,
    };
  }
  if (hasEnabled && state.suspended) {
    return {
      ...state,
      suspended: false,
      suspendedRemainingMs: null,
      generation: state.generation + 1,
      dueAt: new Date(
        Date.parse(ctx.now) + state.suspendedRemainingMs!,
      ).toISOString(),
    };
  }
  return state;
}

function finish(
  ctx: RuleContext,
  state: TriviaState,
  complete: boolean,
): TransitionResult<TriviaState> {
  const high = Math.max(0, ...Object.values(state.scores));
  const winners =
    high > 0
      ? Object.keys(state.scores).filter((id) => state.scores[id] === high)
      : [];
  const final: FinalResult = {
    outcome: complete ? "completed" : "ended_early",
    data: {
      roundsPlayed: state.reveals.length,
      totalRounds: settings(ctx).rounds,
      winners,
      attribution: bank(ctx)!.attribution,
    },
    participants: ctx.members.map((m) => {
      const exclusionReasons: string[] = [];
      if (ctx.mode === "solo") exclusionReasons.push("solo_mode");
      if (m.kind === "guest") exclusionReasons.push("guest_player");
      if (m.disabled) exclusionReasons.push("disabled_principal");
      if (!complete) exclusionReasons.push("ended_early");
      return {
        memberId: m.id,
        score: state.scores[m.id] ?? 0,
        contribution: { correctAnswers: state.scores[m.id] ?? 0 },
        win: winners.includes(m.id),
        careerEligible: exclusionReasons.length === 0,
        exclusionReasons,
      };
    }),
  };
  return transition(
    ctx,
    { ...state, dueAt: null, suspended: false, suspendedRemainingMs: null },
    "finished",
    final,
  );
}

export const server: GameServer<TriviaState, TriviaView> = defineGameServer<
  TriviaState,
  TriviaView
>({
  importResource: parseTriviaImport,
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
      const content = bank(ctx);
      if (!content || content.format !== "next-round.trivia/1")
        return failure("RESOURCE_REQUIRED", "Choose a trivia question bank.");
      if (
        !s ||
        !Number.isInteger(s.rounds) ||
        s.rounds < 1 ||
        s.rounds > Math.min(20, content.questions.length) ||
        !Number.isInteger(s.secondsPerRound) ||
        s.secondsPerRound < 1 ||
        s.secondsPerRound > 300
      ) {
        return failure(
          "INVALID_SETTINGS",
          "Choose available rounds and a round duration from 1 to 300 seconds.",
        );
      }
      return transition(
        ctx,
        {
          roundIndex: 0,
          answers: {},
          roundMemberIds: [],
          scores: Object.fromEntries(ctx.members.map((m) => [m.id, 0])),
          reveals: [],
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
      // The current roster is fixed at round start, including for a rejoin.
      return transition(
        ctx,
        membership(ctx, {
          ...state,
          scores: {
            ...state.scores,
            [event.memberId]: state.scores[event.memberId] ?? 0,
          },
        }),
      );
    }
    if (event.kind === "leave") {
      return transition(
        ctx,
        membership(ctx, {
          ...state,
          roundMemberIds: state.roundMemberIds.filter(
            (id) => id !== event.memberId,
          ),
        }),
      );
    }
    if (event.kind === "principal_status")
      return transition(ctx, membership(ctx, state));
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
      return transition(
        ctx,
        {
          ...state,
          roundMemberIds: enabled(ctx).map((m) => m.id),
          generation: 1,
          dueAt: new Date(
            Date.parse(ctx.now) + settings(ctx).secondsPerRound * 1000,
          ).toISOString(),
        },
        "active",
      );
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
      // Do not score or reveal a still-private unfinished round.
      return finish(ctx, state, false);
    }
    if (event.kind === "action") {
      const payload = event.payload as {
        roundIndex?: number;
        choice?: number;
      } | null;
      const actor =
        ctx.actor && enabled(ctx).find((m) => m.id === ctx.actor!.memberId);
      if (
        event.type !== "submit" ||
        !payload ||
        payload.roundIndex !== state.roundIndex
      )
        return failure(
          "WRONG_ROUND",
          "Review the current question before submitting.",
        );
      if (!actor || state.suspended || !state.roundMemberIds.includes(actor.id))
        return failure(
          "NOT_ELIGIBLE",
          "You can answer starting with your next eligible round.",
        );
      if (state.answers[actor.id] !== undefined)
        return failure(
          "ALREADY_SUBMITTED",
          "Your answer for this round is already recorded.",
        );
      if (Date.parse(ctx.now) >= Date.parse(state.dueAt!))
        return failure("ROUND_CLOSED", "The round deadline has passed.");
      const q = bank(ctx)!.questions[state.roundIndex];
      if (
        !Number.isInteger(payload.choice) ||
        payload.choice! < 0 ||
        payload.choice! >= q.choices.length
      )
        return failure(
          "INVALID_CHOICE",
          "Choose one of the available answers.",
        );
      return transition(ctx, {
        ...state,
        answers: { ...state.answers, [actor.id]: payload.choice! },
      });
    }
    if (event.kind === "deadline") {
      const d = event.deadline;
      if (
        state.suspended ||
        d.key !== "round" ||
        d.generation !== state.generation ||
        Date.parse(ctx.now) < Date.parse(d.dueAt)
      ) {
        return failure(
          "INVALID_DEADLINE",
          "The deadline is not active or due.",
        );
      }
      const q = bank(ctx)!.questions[state.roundIndex];
      const scores = { ...state.scores };
      for (const [id, answer] of Object.entries(state.answers))
        if (answer === q.correctChoice) scores[id] = (scores[id] ?? 0) + 1;
      const next: TriviaState = {
        ...state,
        scores,
        reveals: [
          ...state.reveals,
          {
            roundIndex: state.roundIndex,
            questionId: q.id,
            prompt: q.prompt,
            choices: [...q.choices],
            correctChoice: q.correctChoice,
            explanation: q.explanation,
            answers: { ...state.answers },
          },
        ],
        roundIndex: state.roundIndex + 1,
        answers: {},
        roundMemberIds: enabled(ctx).map((m) => m.id),
        generation: state.generation + 1,
        dueAt: new Date(
          Date.parse(ctx.now) + settings(ctx).secondsPerRound * 1000,
        ).toISOString(),
      };
      if (next.roundIndex >= settings(ctx).rounds)
        return finish(ctx, next, true);
      return transition(ctx, membership(ctx, next));
    }
    return failure("UNSUPPORTED_EVENT", "This event is not supported.");
  },
  view(ctx, state, viewer) {
    const q =
      ctx.phase === "active"
        ? bank(ctx)?.questions[state.roundIndex]
        : undefined;
    return {
      phase: ctx.phase ?? "lobby",
      roundIndex: state.roundIndex,
      totalRounds: settings(ctx).rounds,
      question: q
        ? { id: q.id, prompt: q.prompt, choices: [...q.choices] }
        : null,
      myMemberId: viewer.memberId,
      myChoice: viewer.memberId
        ? (state.answers[viewer.memberId] ?? null)
        : null,
      canSubmit:
        viewer.access === "active" &&
        viewer.memberId !== null &&
        obligations(ctx, state).includes(viewer.memberId),
      scores: { ...state.scores },
      reveals: state.reveals,
      dueAt: state.dueAt,
      suspended: state.suspended,
      attribution: bank(ctx)?.attribution ?? null,
    };
  },
  summary(ctx, state, principalId) {
    const member = ctx.members.find((m) => m.principalId === principalId);
    return {
      label: `Trivia · ${state.reveals.length}/${settings(ctx).rounds} rounds`,
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
