// SPDX-License-Identifier: Apache-2.0
import { Type, type Static } from "@sinclair/typebox";
import { JsonSchema, type Json } from "./manifest.js";

export const ERROR_CODES = {
  // 400
  INVALID_REQUEST: "INVALID_REQUEST",
  // 401
  AUTH_REQUIRED: "AUTH_REQUIRED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  // 403
  FORBIDDEN: "FORBIDDEN",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  // 404
  NOT_FOUND: "NOT_FOUND",
  // 409
  STALE_REVISION: "STALE_REVISION",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  MATCH_CLOSED: "MATCH_CLOSED",
  MODULE_DISABLED: "MODULE_DISABLED",
  CAPACITY_REACHED: "CAPACITY_REACHED",
  // 410
  TOKEN_INVALID: "TOKEN_INVALID",
  // 422
  RULE_REJECTED: "RULE_REJECTED",
  INCOMPATIBLE_MODULE: "INCOMPATIBLE_MODULE",
  // 429
  RATE_LIMITED: "RATE_LIMITED",
  // 500
  MODULE_FAILURE: "MODULE_FAILURE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // 503
  MODULE_UNAVAILABLE: "MODULE_UNAVAILABLE",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  AUTH_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,
  NOT_FOUND: 404,
  STALE_REVISION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  MATCH_CLOSED: 409,
  MODULE_DISABLED: 409,
  CAPACITY_REACHED: 409,
  TOKEN_INVALID: 410,
  RULE_REJECTED: 422,
  INCOMPATIBLE_MODULE: 422,
  RATE_LIMITED: 429,
  MODULE_FAILURE: 500,
  INTERNAL_ERROR: 500,
  MODULE_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
};

export const ErrorPayloadSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), JsonSchema)),
  },
  { additionalProperties: false }
);
export type ErrorPayload = Static<typeof ErrorPayloadSchema>;

export const ErrorResponseSchema = Type.Object(
  {
    error: ErrorPayloadSchema,
  },
  { additionalProperties: false }
);
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export interface RuleError {
  code: string;
  message: string;
  field?: string;
  ruleCode?: string;
}

export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, Json>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      details?: Record<string, Json>;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiError";
    this.code = code;
    this.statusCode = options?.statusCode ?? ERROR_STATUS_MAP[code] ?? 500;
    this.details = options?.details;
  }

  toResponse(requestId: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
