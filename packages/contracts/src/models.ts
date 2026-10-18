import { Type, type Static } from "@sinclair/typebox";
import { JsonSchema, type Json } from "./manifest.js";

export const MemberKindSchema = Type.Union([
  Type.Literal("registered"),
  Type.Literal("guest"),
]);
export type MemberKind = Static<typeof MemberKindSchema>;

export const MemberStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("left"),
  Type.Literal("removed"),
]);
export type MemberStatus = Static<typeof MemberStatusSchema>;

export const MemberSchema = Type.Object(
  {
    id: Type.String(),
    principalId: Type.String(),
    kind: MemberKindSchema,
    displayName: Type.String({ minLength: 1, maxLength: 40 }),
    status: MemberStatusSchema,
    joinOrdinal: Type.Integer({ minimum: 0 }),
    disabled: Type.Boolean(),
    accessEpoch: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);
export type Member = Static<typeof MemberSchema>;

export const DeadlineSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    generation: Type.Integer({ minimum: 0 }),
    dueAt: Type.String(),
  },
  { additionalProperties: false }
);
export type Deadline = Static<typeof DeadlineSchema>;

export const ResourceSchema = Type.Object(
  {
    id: Type.String(),
    identity: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    data: JsonSchema,
  },
  { additionalProperties: false }
);
export type Resource = Static<typeof ResourceSchema>;

export const FactSchema = Type.Object(
  {
    principalId: Type.String(),
    key: Type.String({ minLength: 1 }),
    value: JsonSchema,
  },
  { additionalProperties: false }
);
export type Fact = Static<typeof FactSchema>;

export const MatchPhaseSchema = Type.Union([
  Type.Literal("lobby"),
  Type.Literal("active"),
  Type.Literal("finished"),
]);
export type MatchPhase = Static<typeof MatchPhaseSchema>;

export const FinalOutcomeSchema = Type.Union([
  Type.Literal("solved"),
  Type.Literal("completed"),
  Type.Literal("ended_early"),
  Type.Literal("revealed"),
  Type.Literal("abandoned"),
]);
export type FinalOutcome = Static<typeof FinalOutcomeSchema>;

export const FinalParticipantSchema = Type.Object(
  {
    memberId: Type.String(),
    score: Type.Integer(),
    contribution: JsonSchema,
    win: Type.Boolean(),
    careerEligible: Type.Boolean(),
    exclusionReasons: Type.Array(Type.String()),
  },
  { additionalProperties: false }
);
export type FinalParticipant = Static<typeof FinalParticipantSchema>;

export const FinalResultSchema = Type.Object(
  {
    outcome: FinalOutcomeSchema,
    data: JsonSchema,
    participants: Type.Array(FinalParticipantSchema),
  },
  { additionalProperties: false }
);
export interface FinalResult {
  outcome: FinalOutcome;
  data: Json;
  participants: FinalParticipant[];
}
