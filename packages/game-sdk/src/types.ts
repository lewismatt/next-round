import type {
  Json,
  Member,
  Deadline,
  Resource,
  Fact,
  FinalResult,
  FinalParticipant,
  RuleError,
} from "@next-round/contracts";

export type {
  Json,
  Member,
  Deadline,
  Resource,
  Fact,
  FinalResult,
  FinalParticipant,
  RuleError,
};

export interface RuleContext {
  matchId: string;
  moduleVersion: string;
  mode: string;
  phase: "lobby" | "active" | "finished" | null;
  revision: number;
  now: string;
  eventId: string; // server-provided; hooks must not read wall clock
  actor: { principalId: string; memberId: string } | null;
  members: readonly Member[];
  hostMemberId: string | null;
  settings: Json;
  resource: Resource | null;
  facts: readonly Fact[];
}

export type GameEvent =
  | { kind: "create" }
  | { kind: "join"; memberId: string; rejoin: boolean }
  | { kind: "start" }
  | { kind: "action"; type: string; payload: Json }
  | { kind: "leave"; memberId: string; reason: "left" | "removed" }
  | { kind: "principal_status"; memberId: string; disabled: boolean }
  | { kind: "deadline"; deadline: Deadline }
  | { kind: "finish"; reason: "host_ended" };

export interface Transition<S extends Json = Json> {
  state: S;
  phase: "lobby" | "active" | "finished";
  hostMemberId: string | null;
  deadlines: Deadline[]; // complete replacement set; [] cancels all
  needsActionFrom: string[]; // member IDs; not necessarily a single turn
  facts: Array<{ principalId: string; key: string; value: Json }>;
  final: FinalResult | null;
}

export type TransitionResult<S extends Json = Json> =
  | { ok: true; value: Transition<S> }
  | { ok: false; error: RuleError };

export interface AuthorityResult {
  canStart: boolean;
  canFinish: boolean;
  removableMemberIds: string[];
}

export interface ImportResourceResult {
  identity: string;
  metadata: Json;
  data: Json;
  importerFacts: Array<{ key: string; value: Json }>;
}

export interface ViewerContext {
  principalId: string;
  memberId: string | null;
  access: "active" | "result_only";
}

export interface MatchSummary {
  label: string;
  needsAction: boolean;
  detail: string | null;
}

export interface CareerMetric {
  memberId: string;
  points: number;
  played: number;
  wins: number;
}

export interface MigrationInput {
  fromVersion: string;
  fromStateVersion: number;
  toStateVersion: number;
  state: Json;
  settings: Json;
  result: FinalResult | null;
}

export interface MigrationOutput<S extends Json = Json> {
  state: S;
  settings: Json;
  result: FinalResult | null;
}

export interface GameServer<S extends Json = Json, V extends Json = Json> {
  authority(ctx: RuleContext, state: S, memberId: string): AuthorityResult;
  importResource?(
    input: Json,
    ctx: { principalId: string; now: string }
  ): ImportResourceResult;
  transition(
    ctx: RuleContext,
    state: S | null,
    event: GameEvent
  ): TransitionResult<S>;
  view(ctx: RuleContext, state: S, viewer: ViewerContext): V;
  summary(
    ctx: RuleContext,
    state: S,
    viewerPrincipalId: string
  ): MatchSummary;
  resultView(
    ctx: RuleContext,
    result: FinalResult,
    viewerPrincipalId: string
  ): Json;
  career(result: FinalResult): CareerMetric[];
  migrate?(input: MigrationInput): MigrationOutput<S>;
}
