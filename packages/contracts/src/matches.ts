// SPDX-License-Identifier: Apache-2.0
import { Type, type Static } from "@sinclair/typebox";
import { JsonSchema } from "./manifest.js";

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const MatchParamsSchema = Type.Object(
  {
    id: Type.String({ pattern: UUID_PATTERN }),
  },
  { additionalProperties: false },
);
export type MatchParams = Static<typeof MatchParamsSchema>;

export const CreateMatchRequestSchema = Type.Object(
  {
    commandId: Type.String({ pattern: UUID_PATTERN }),
    moduleId: Type.String({ pattern: "^[a-z][a-z0-9-]{1,62}$" }),
    mode: Type.String({ minLength: 1, maxLength: 64 }),
    settings: JsonSchema,
    resourceId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    visibility: Type.Union([Type.Literal("invite"), Type.Literal("instance")]),
  },
  { additionalProperties: false },
);
export type CreateMatchRequest = Static<typeof CreateMatchRequestSchema>;

export const MatchLifecycleCommandSchema = Type.Object(
  {
    commandId: Type.String({ pattern: UUID_PATTERN }),
    expectedRevision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type MatchLifecycleCommand = Static<typeof MatchLifecycleCommandSchema>;

export const MatchActionRequestSchema = Type.Object(
  {
    commandId: Type.String({ pattern: UUID_PATTERN }),
    expectedRevision: Type.Integer({ minimum: 0 }),
    type: Type.String({ minLength: 1 }),
    payload: JsonSchema,
  },
  { additionalProperties: false },
);
export type MatchActionRequest = Static<typeof MatchActionRequestSchema>;
