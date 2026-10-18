import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { JsonSchema, type Json } from "./manifest.js";

export const LIVE_SUBPROTOCOL = "next-round.live.v1" as const;
export type LiveSubprotocol = typeof LIVE_SUBPROTOCOL;

export interface ApiResponse<T> {
  data: T;
  serverNow: string;
}

export function ApiResponseSchema<T extends TSchema>(dataSchema: T) {
  return Type.Object(
    {
      data: dataSchema,
      serverNow: Type.String(),
    },
    { additionalProperties: false }
  );
}

export interface ApiListResponse<T> {
  data: T[];
  nextCursor: string | null;
  serverNow: string;
}

export function ApiListResponseSchema<T extends TSchema>(itemSchema: T) {
  return Type.Object(
    {
      data: Type.Array(itemSchema),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
      serverNow: Type.String(),
    },
    { additionalProperties: false }
  );
}

export const CommandReceiptSchema = Type.Object(
  {
    commandId: Type.String(),
    matchId: Type.String(),
    committedRevision: Type.Integer({ minimum: 0 }),
    replayed: Type.Boolean(),
    outcome: Type.Literal("accepted"),
  },
  { additionalProperties: false }
);
export type CommandReceipt = Static<typeof CommandReceiptSchema>;

export const CreateMatchResponseSchema = Type.Object(
  {
    matchId: Type.String(),
    revision: Type.Literal(0),
    commandId: Type.String(),
  },
  { additionalProperties: false }
);
export type CreateMatchResponse = Static<typeof CreateMatchResponseSchema>;

export const MatchCommandEnvelopeSchema = Type.Object(
  {
    commandId: Type.String(),
    expectedRevision: Type.Integer({ minimum: 0 }),
    type: Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,63}$" }),
    payload: JsonSchema,
  },
  { additionalProperties: false }
);
export type MatchCommandEnvelope = Static<typeof MatchCommandEnvelopeSchema>;

// Live / WebSocket frames (Master Spec §6)
export const LiveScopeMatchSchema = Type.Object(
  {
    kind: Type.Literal("match"),
    id: Type.String(),
  },
  { additionalProperties: false }
);

export const LiveScopeChatSchema = Type.Object(
  {
    kind: Type.Literal("chat"),
    id: Type.String(),
  },
  { additionalProperties: false }
);

export const LiveScopeNotificationsSchema = Type.Object(
  {
    kind: Type.Literal("notifications"),
  },
  { additionalProperties: false }
);

export const LiveScopeHomeSchema = Type.Object(
  {
    kind: Type.Literal("home"),
  },
  { additionalProperties: false }
);

export const LiveScopeSchema = Type.Union([
  LiveScopeMatchSchema,
  LiveScopeChatSchema,
  LiveScopeNotificationsSchema,
  LiveScopeHomeSchema,
]);
export type LiveScope = Static<typeof LiveScopeSchema>;

export const ClientLiveFrameSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("subscribe"),
      requestId: Type.String(),
      scope: LiveScopeSchema,
      knownRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("unsubscribe"),
      requestId: Type.String(),
      scope: LiveScopeSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("ping"),
      requestId: Type.String(),
    },
    { additionalProperties: false }
  ),
]);
export type ClientLiveFrame = Static<typeof ClientLiveFrameSchema>;

export const ServerLiveFrameSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("hello"),
      connectionId: Type.String(),
      serverNow: Type.String(),
      heartbeatSeconds: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("subscribed"),
      requestId: Type.String(),
      scope: LiveScopeSchema,
      revision: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("invalidate"),
      scope: LiveScopeSchema,
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("access_revoked"),
      scope: LiveScopeSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("pong"),
      requestId: Type.String(),
      serverNow: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("error"),
      requestId: Type.String(),
      code: Type.String(),
    },
    { additionalProperties: false }
  ),
]);
export type ServerLiveFrame = Static<typeof ServerLiveFrameSchema>;
