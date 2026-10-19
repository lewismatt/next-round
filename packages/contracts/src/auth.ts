// SPDX-License-Identifier: Apache-2.0
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ApiError, ERROR_CODES } from "./errors.js";

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const UuidSchema = Type.String({ pattern: UUID_PATTERN });

const RetentionDays = Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()]);

/** Instance policy (Master Spec P2). Finite retention days are integers 1–3650; null retains. */
export const PolicyV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    historyVisibility: Type.Union([Type.Literal("participants"), Type.Literal("instance")]),
    statsVisibility: Type.Union([Type.Literal("owner"), Type.Literal("instance")]),
    rejoinChat: Type.Union([Type.Literal("full"), Type.Literal("since_rejoin")]),
    retention: Type.Object(
      {
        chatDaysAfterFinish: RetentionDays,
        privateStateDaysAfterFinish: RetentionDays,
        resultDaysAfterFinish: RetentionDays,
        notificationDays: RetentionDays,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type PolicyV1 = Static<typeof PolicyV1Schema>;

/** POST /setup request body. Username/password rules are enforced by the platform. */
export const SetupRequestSchema = Type.Object(
  {
    setupToken: Type.String({ maxLength: 1024 }),
    commandId: UuidSchema,
    instanceName: Type.String({ maxLength: 256 }),
    username: Type.String({ maxLength: 256 }),
    password: Type.String({ maxLength: 2048 }),
    displayName: Type.String({ maxLength: 256 }),
    policy: PolicyV1Schema,
  },
  { additionalProperties: false }
);
export type SetupRequest = Static<typeof SetupRequestSchema>;

/** POST /auth/login request body. */
export const LoginRequestSchema = Type.Object(
  {
    username: Type.String({ maxLength: 256 }),
    password: Type.String({ maxLength: 2048 }),
  },
  { additionalProperties: false }
);
export type LoginRequest = Static<typeof LoginRequestSchema>;
/** POST /auth/logout request body. */
export const LogoutRequestSchema = Type.Object({}, { additionalProperties: false });
export type LogoutRequest = Static<typeof LogoutRequestSchema>;


/** PATCH /admin/users/:id request body (only `disabled` is implemented). */
export const AdminUserPatchRequestSchema = Type.Object(
  { disabled: Type.Boolean() },
  { additionalProperties: false }
);
export type AdminUserPatchRequest = Static<typeof AdminUserPatchRequestSchema>;
/** PATCH /admin/users/:id path parameters. */
export const AdminUserParamsSchema = Type.Object(
  { id: UuidSchema },
  { additionalProperties: false }
);
export type AdminUserParams = Static<typeof AdminUserParamsSchema>;


/** Principal response shape: `{id,kind,displayName,username}`. */
export interface PrincipalView {
  id: string;
  kind: "registered" | "guest";
  displayName: string;
  username: string | null;
}

export interface Permissions {
  isAdmin: boolean;
  canInviteRegistrations: boolean;
  canInviteGuests: boolean;
}

/**
 * Validates a request body against a schema. The error names offending JSON
 * paths only; submitted values (passwords, tokens) are never echoed.
 */
export function parseRequestBody<T extends TSchema>(schema: T, body: unknown): Static<T> {
  if (Value.Check(schema, body)) {
    return body;
  }
  const fields = [...new Set(Array.from(Value.Errors(schema, body), (error) => error.path || "/"))];
  throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Request body is invalid.", {
    details: { fields },
  });
}
