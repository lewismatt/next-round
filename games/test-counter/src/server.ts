import type {
  AuthorityResult,
  CareerMetric,
  FinalParticipant,
  FinalResult,
  GameEvent,
  GameServer,
  Json,
  MatchSummary,
  Member,
  RuleContext,
  RuleError,
  Transition,
  TransitionResult,
  ViewerContext,
} from "@next-round/game-sdk";
import { defineGameServer } from "@next-round/game-sdk";

export interface CounterSettings {
  target: number;
  turnSeconds: number | null;
}

export type CounterState = {
  count: number;
  target: number;
  turnSeconds: number | null;
  scores: Record<string, number>;
  notes: Record<string, string>;
  markers: Record<string, string>;
  turnOrder: string[];
  currentActorMemberId: string | null;
  deadlineGeneration: number;
  [key: string]: Json;
};

export type CounterView = {
  count: number;
  target: number;
  turnSeconds: number | null;
  scores: Record<string, number>;
  turnOrder: string[];
  currentActorMemberId: string | null;
  myMarker: string | null;
  myNote: string | null;
  myScore: number | null;
  [key: string]: Json;
};


function computeDeadline(nowIso: string, seconds: number | null, generation: number) {
  if (seconds === null || seconds <= 0) return [];
  const nowMs = Date.parse(nowIso);
  const dueAt = new Date(nowMs + seconds * 1000).toISOString();
  return [{ key: "turn", generation, dueAt }];
}

function buildParticipants(
  members: readonly Member[],
  scores: Record<string, number>,
  mode: string,
  winners: string[]
): FinalParticipant[] {
  return members.map((member) => {
    const score = scores[member.id] ?? 0;
    const isWinner = winners.includes(member.id);
    const isSolo = mode === "solo";
    const isGuest = member.kind === "guest";
    const exclusionReasons: string[] = [];
    if (isSolo) exclusionReasons.push("solo_mode");
    if (isGuest) exclusionReasons.push("guest_player");
    if (member.disabled) exclusionReasons.push("disabled_principal");

    const careerEligible = exclusionReasons.length === 0;

    return {
      memberId: member.id,
      score,
      contribution: {
        actionsTaken: score,
        mode,
      },
      win: isWinner,
      careerEligible,
      exclusionReasons,
    };
  });
}

function rotateActor(
  turnOrder: string[],
  currentActor: string | null,
  members: readonly Member[]
): string | null {
  const activeEnabledIds = new Set(
    members.filter((m) => m.status === "active" && !m.disabled).map((m) => m.id)
  );
  const eligibleOrder = turnOrder.filter((id) => activeEnabledIds.has(id));
  if (eligibleOrder.length === 0) return null;

  if (!currentActor) return eligibleOrder[0];
  const currentIndex = eligibleOrder.indexOf(currentActor);
  if (currentIndex === -1) return eligibleOrder[0];
  return eligibleOrder[(currentIndex + 1) % eligibleOrder.length];
}

export const server: GameServer<CounterState, CounterView> = defineGameServer<
  CounterState,
  CounterView
>({
  authority(ctx: RuleContext, state: CounterState, memberId: string): AuthorityResult {
    const isHost = ctx.hostMemberId === memberId;
    const activeMembers = ctx.members.filter((m) => m.status === "active" && !m.disabled);
    const minPlayers = ctx.mode === "solo" ? 1 : 2;

    const canStart = ctx.phase === "lobby" && isHost && activeMembers.length >= minPlayers;
    const canFinish = ctx.phase === "active" && isHost;
    const removableMemberIds = isHost
      ? ctx.members
          .filter((m) => m.id !== memberId && (m.status !== "active" || m.disabled))
          .map((m) => m.id)
      : [];

    return {
      canStart,
      canFinish,
      removableMemberIds,
    };
  },

  transition(
    ctx: RuleContext,
    state: CounterState | null,
    event: GameEvent
  ): TransitionResult<CounterState> {
    if (event.kind === "create") {
      const raw = typeof ctx.settings === "object" && ctx.settings !== null ? (ctx.settings as Record<string, unknown>) : {};
      const target = typeof raw.target === "number" && Number.isInteger(raw.target) && raw.target >= 1 && raw.target <= 20
        ? raw.target
        : 10;
      const turnSeconds = typeof raw.turnSeconds === "number" && Number.isInteger(raw.turnSeconds) && raw.turnSeconds >= 1 && raw.turnSeconds <= 60
        ? raw.turnSeconds
        : null;
      const initialState: CounterState = {
        count: 0,
        target,
        turnSeconds,
        scores: {},
        notes: {},
        markers: {},
        turnOrder: [],
        currentActorMemberId: null,
        deadlineGeneration: 0,
      };

      return {
        ok: true,
        value: {
          state: initialState,
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
      return {
        ok: false,
        error: { code: "INVALID_STATE", message: "Game state is not initialized." },
      };
    }

    if (event.kind === "join") {
      const { memberId, rejoin } = event;
      const turnOrder = state.turnOrder.includes(memberId)
        ? state.turnOrder
        : [...state.turnOrder, memberId];

      const scores = { ...state.scores };
      const notes = { ...state.notes };
      const markers = { ...state.markers };

      if (!rejoin && scores[memberId] === undefined) {
        scores[memberId] = 0;
        notes[memberId] = "";
        markers[memberId] = `P${turnOrder.length}`;
      }

      const currentActorMemberId =
        state.currentActorMemberId ?? (ctx.phase === "active" ? turnOrder[0] : null);

      const nextState: CounterState = {
        ...state,
        turnOrder,
        scores,
        notes,
        markers,
        currentActorMemberId,
      };

      return {
        ok: true,
        value: {
          state: nextState,
          phase: ctx.phase ?? "lobby",
          hostMemberId: ctx.hostMemberId,
          deadlines:
            ctx.phase === "active"
              ? computeDeadline(ctx.now, state.turnSeconds, state.deadlineGeneration)
              : [],
          needsActionFrom:
            ctx.phase === "active" && currentActorMemberId ? [currentActorMemberId] : [],
          facts: [],
          final: null,
        },
      };
    }

    if (event.kind === "start") {
      if (ctx.phase !== "lobby") {
        return {
          ok: false,
          error: { code: "ALREADY_STARTED", message: "Match has already started." },
        };
      }

      const activeMembers = ctx.members.filter((m) => m.status === "active" && !m.disabled);
      const minPlayers = ctx.mode === "solo" ? 1 : 2;
      if (activeMembers.length < minPlayers) {
        return {
          ok: false,
          error: {
            code: "INSUFFICIENT_PLAYERS",
            message: `Mode ${ctx.mode} requires at least ${minPlayers} active players.`,
          },
        };
      }

      const turnOrder = activeMembers.map((m) => m.id);
      const currentActorMemberId = turnOrder[0] ?? null;
      const deadlineGeneration = 1;

      const nextState: CounterState = {
        ...state,
        turnOrder,
        currentActorMemberId,
        deadlineGeneration,
      };

      const deadlines = computeDeadline(ctx.now, state.turnSeconds, deadlineGeneration);

      return {
        ok: true,
        value: {
          state: nextState,
          phase: "active",
          hostMemberId: ctx.hostMemberId,
          deadlines,
          needsActionFrom: currentActorMemberId ? [currentActorMemberId] : [],
          facts: [],
          final: null,
        },
      };
    }

    if (event.kind === "action") {
      if (ctx.phase !== "active") {
        return {
          ok: false,
          error: { code: "NOT_ACTIVE", message: "Cannot perform action in non-active phase." },
        };
      }

      if (event.type === "add") {
        const payload = event.payload as Record<string, unknown>;
        if (payload?.amount !== 1) {
          return {
            ok: false,
            error: { code: "INVALID_AMOUNT", message: "Amount must be exactly 1." },
          };
        }

        const actorMemberId = ctx.actor?.memberId;
        if (!actorMemberId || actorMemberId !== state.currentActorMemberId) {
          return {
            ok: false,
            error: { code: "NOT_CURRENT_ACTOR", message: "Only current actor can advance count." },
          };
        }

        const newCount = state.count + 1;
        const newScore = (state.scores[actorMemberId] ?? 0) + 1;
        const nextScores = { ...state.scores, [actorMemberId]: newScore };

        // Check target condition
        if (newCount >= state.target) {
          const maxScore = Math.max(...Object.values(nextScores));
          const winners = Object.entries(nextScores)
            .filter(([_, score]) => score === maxScore)
            .map(([id]) => id);

          const final: FinalResult = {
            outcome: "completed",
            data: {
              count: newCount,
              target: state.target,
              winners,
            },
            participants: buildParticipants(ctx.members, nextScores, ctx.mode, winners),
          };

          const finishedState: CounterState = {
            ...state,
            count: newCount,
            scores: nextScores,
            currentActorMemberId: null,
          };

          return {
            ok: true,
            value: {
              state: finishedState,
              phase: "finished",
              hostMemberId: ctx.hostMemberId,
              deadlines: [],
              needsActionFrom: [],
              facts: [],
              final,
            },
          };
        }

        // Target not reached: rotate actor and emit next deadline
        const nextActor = rotateActor(state.turnOrder, state.currentActorMemberId, ctx.members);
        const nextGen = state.deadlineGeneration + 1;
        const deadlines = computeDeadline(ctx.now, state.turnSeconds, nextGen);

        const nextState: CounterState = {
          ...state,
          count: newCount,
          scores: nextScores,
          currentActorMemberId: nextActor,
          deadlineGeneration: nextGen,
        };

        return {
          ok: true,
          value: {
            state: nextState,
            phase: "active",
            hostMemberId: ctx.hostMemberId,
            deadlines,
            needsActionFrom: nextActor ? [nextActor] : [],
            facts: [],
            final: null,
          },
        };
      }

      if (event.type === "note") {
        const payload = event.payload as Record<string, unknown>;
        const text = typeof payload?.text === "string" ? payload.text : null;
        if (text === null || text.length > 80) {
          return {
            ok: false,
            error: {
              code: "INVALID_NOTE",
              message: "Note must be a string up to 80 characters.",
            },
          };
        }

        const actorMemberId = ctx.actor?.memberId;
        const isMemberActive =
          actorMemberId &&
          ctx.members.some((m) => m.id === actorMemberId && m.status === "active" && !m.disabled);
        if (!isMemberActive) {
          return {
            ok: false,
            error: {
              code: "NOT_ACTIVE_MEMBER",
              message: "Only active members may update their private note.",
            },
          };
        }

        const nextNotes = { ...state.notes, [actorMemberId]: text };
        const nextState: CounterState = { ...state, notes: nextNotes };

        return {
          ok: true,
          value: {
            state: nextState,
            phase: "active",
            hostMemberId: ctx.hostMemberId,
            deadlines: computeDeadline(ctx.now, state.turnSeconds, state.deadlineGeneration),
            needsActionFrom: state.currentActorMemberId ? [state.currentActorMemberId] : [],
            facts: [],
            final: null,
          },
        };
      }

      return {
        ok: false,
        error: { code: "UNKNOWN_ACTION", message: `Unsupported action type '${event.type}'.` },
      };
    }

    if (event.kind === "deadline") {
      if (ctx.phase !== "active") {
        return {
          ok: false,
          error: { code: "NOT_ACTIVE", message: "Deadline fired in inactive phase." },
        };
      }

      // Rotate actor without awarding points
      const nextActor = rotateActor(state.turnOrder, state.currentActorMemberId, ctx.members);
      const nextGen = state.deadlineGeneration + 1;
      const deadlines = computeDeadline(ctx.now, state.turnSeconds, nextGen);

      const nextState: CounterState = {
        ...state,
        currentActorMemberId: nextActor,
        deadlineGeneration: nextGen,
      };

      return {
        ok: true,
        value: {
          state: nextState,
          phase: "active",
          hostMemberId: ctx.hostMemberId,
          deadlines,
          needsActionFrom: nextActor ? [nextActor] : [],
          facts: [],
          final: null,
        },
      };
    }

    if (event.kind === "leave") {
      const remainingOrder = state.turnOrder.filter((id) => id !== event.memberId);
      const activeMembers = ctx.members.filter(
        (m) => m.id !== event.memberId && m.status === "active" && !m.disabled
      );

      if (activeMembers.length === 0) {
        const final: FinalResult = {
          outcome: "abandoned",
          data: {
            count: state.count,
            target: state.target,
            winners: [],
          },
          participants: buildParticipants(ctx.members, state.scores, ctx.mode, []),
        };

        const nextState: CounterState = {
          ...state,
          turnOrder: remainingOrder,
          currentActorMemberId: null,
        };

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

      let nextActor = state.currentActorMemberId;
      let nextGen = state.deadlineGeneration;
      if (state.currentActorMemberId === event.memberId) {
        nextActor = rotateActor(remainingOrder, state.currentActorMemberId, ctx.members);
        nextGen += 1;
      }

      const nextState: CounterState = {
        ...state,
        turnOrder: remainingOrder,
        currentActorMemberId: nextActor,
        deadlineGeneration: nextGen,
      };

      return {
        ok: true,
        value: {
          state: nextState,
          phase: ctx.phase ?? "lobby",
          hostMemberId: ctx.hostMemberId,
          deadlines:
            ctx.phase === "active"
              ? computeDeadline(ctx.now, state.turnSeconds, nextGen)
              : [],
          needsActionFrom: ctx.phase === "active" && nextActor ? [nextActor] : [],
          facts: [],
          final: null,
        },
      };
    }

    if (event.kind === "principal_status") {
      const { memberId, disabled } = event;
      if (disabled && state.currentActorMemberId === memberId && ctx.phase === "active") {
        const nextActor = rotateActor(state.turnOrder, memberId, ctx.members);
        const nextGen = state.deadlineGeneration + 1;
        const nextState: CounterState = {
          ...state,
          currentActorMemberId: nextActor,
          deadlineGeneration: nextGen,
        };

        return {
          ok: true,
          value: {
            state: nextState,
            phase: "active",
            hostMemberId: ctx.hostMemberId,
            deadlines: computeDeadline(ctx.now, state.turnSeconds, nextGen),
            needsActionFrom: nextActor ? [nextActor] : [],
            facts: [],
            final: null,
          },
        };
      }

      return {
        ok: true,
        value: {
          state,
          phase: ctx.phase ?? "lobby",
          hostMemberId: ctx.hostMemberId,
          deadlines:
            ctx.phase === "active"
              ? computeDeadline(ctx.now, state.turnSeconds, state.deadlineGeneration)
              : [],
          needsActionFrom:
            ctx.phase === "active" && state.currentActorMemberId
              ? [state.currentActorMemberId]
              : [],
          facts: [],
          final: null,
        },
      };
    }

    if (event.kind === "finish") {
      const maxScore = Object.values(state.scores).length > 0
        ? Math.max(...Object.values(state.scores))
        : 0;
      const winners = Object.entries(state.scores)
        .filter(([_, score]) => score > 0 && score === maxScore)
        .map(([id]) => id);

      const final: FinalResult = {
        outcome: "ended_early",
        data: {
          count: state.count,
          target: state.target,
          winners,
        },
        participants: buildParticipants(ctx.members, state.scores, ctx.mode, winners),
      };

      const finishedState: CounterState = {
        ...state,
        currentActorMemberId: null,
      };

      return {
        ok: true,
        value: {
          state: finishedState,
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
      ok: false,
      error: { code: "UNHANDLED_EVENT", message: `Event kind not supported.` },
    };
  },

  view(ctx: RuleContext, state: CounterState, viewer: ViewerContext): CounterView {
    const memberId = viewer.memberId;
    return {
      count: state.count,
      target: state.target,
      turnSeconds: state.turnSeconds,
      scores: { ...state.scores },
      turnOrder: [...state.turnOrder],
      currentActorMemberId: state.currentActorMemberId,
      myMarker: memberId ? state.markers[memberId] ?? null : null,
      myNote: memberId ? state.notes[memberId] ?? "" : null,
      myScore: memberId ? state.scores[memberId] ?? 0 : null,
    };
  },

  summary(ctx: RuleContext, state: CounterState, viewerPrincipalId: string): MatchSummary {
    const viewerMember = ctx.members.find((m) => m.principalId === viewerPrincipalId);
    const isActor =
      viewerMember &&
      state.currentActorMemberId !== null &&
      state.currentActorMemberId === viewerMember.id;

    return {
      label: `Count: ${state.count}/${state.target}`,
      needsAction: Boolean(isActor && ctx.phase === "active"),
      detail: `${state.turnOrder.length} player(s) · Mode: ${ctx.mode}`,
    };
  },

  resultView(
    _ctx: RuleContext,
    result: FinalResult,
    _viewerPrincipalId: string
  ): Json {
    return {
      outcome: result.outcome,
      data: result.data,
      participants: result.participants.map((p) => ({
        memberId: p.memberId,
        score: p.score,
        win: p.win,
        careerEligible: p.careerEligible,
      })),
    };
  },

  career(result: FinalResult): CareerMetric[] {
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
