// SPDX-License-Identifier: Apache-2.0
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ApiError, ERROR_CODES } from "./errors.js";
import type { Json } from "./manifest.js";


const compiledGameSchemas = new WeakMap<object, TSchema>();

function compileJsonSchema(input: unknown): TSchema {
  if (input === true) {
    return Type.Any();
  }
  if (input === false) {
    return Type.Never();
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema is invalid.");
  }

  const cached = compiledGameSchemas.get(input);
  if (cached) {
    return cached;
  }

  const schema = input as Record<string, unknown>;
  let compiled: TSchema;
  if ("const" in schema) {
    const value = schema.const;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema const is invalid.");
    }
    compiled = value === null ? Type.Null() : Type.Literal(value);
  } else if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    compiled = values.length === 0
      ? Type.Never()
      : Type.Union(values.map((value) => {
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema enum is invalid.");
        }
        return value === null ? Type.Null() : Type.Literal(value);
      }));
  } else if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const alternatives = (schema.anyOf ?? schema.oneOf) as unknown[];
    compiled = alternatives.length === 0
      ? Type.Never()
      : Type.Union(alternatives.map((alternative) => compileJsonSchema(alternative)));
  } else if (Array.isArray(schema.allOf)) {
    const members = schema.allOf.map((member) => compileJsonSchema(member));
    compiled = members.length === 0 ? Type.Any() : Type.Intersect(members);
  } else if (Array.isArray(schema.type)) {
    compiled = Type.Union(
      schema.type.map((type) => compileJsonSchema({ ...schema, type })),
    );
  } else {
    switch (schema.type) {
      case "null":
        compiled = Type.Null();
        break;
      case "boolean":
        compiled = Type.Boolean();
        break;
      case "integer":
        compiled = Type.Integer({
          ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
          ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
          ...(typeof schema.exclusiveMinimum === "number"
            ? { exclusiveMinimum: schema.exclusiveMinimum }
            : {}),
          ...(typeof schema.exclusiveMaximum === "number"
            ? { exclusiveMaximum: schema.exclusiveMaximum }
            : {}),
          ...(typeof schema.multipleOf === "number" ? { multipleOf: schema.multipleOf } : {}),
        });
        break;
      case "number":
        compiled = Type.Number({
          ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
          ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
          ...(typeof schema.exclusiveMinimum === "number"
            ? { exclusiveMinimum: schema.exclusiveMinimum }
            : {}),
          ...(typeof schema.exclusiveMaximum === "number"
            ? { exclusiveMaximum: schema.exclusiveMaximum }
            : {}),
          ...(typeof schema.multipleOf === "number" ? { multipleOf: schema.multipleOf } : {}),
        });
        break;
      case "string":
        compiled = Type.String({
          ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
          ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
          ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}),
        });
        break;
      case "array":
        compiled = Type.Array(compileJsonSchema(schema.items ?? {}), {
          ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
          ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
          ...(typeof schema.uniqueItems === "boolean" ? { uniqueItems: schema.uniqueItems } : {}),
        });
        break;
      case "object": {
        const rawProperties =
          typeof schema.properties === "object" &&
          schema.properties !== null &&
          !Array.isArray(schema.properties)
            ? schema.properties as Record<string, unknown>
            : {};
        const required = new Set(
          Array.isArray(schema.required)
            ? schema.required.filter((name): name is string => typeof name === "string")
            : [],
        );
        const properties: Record<string, TSchema> = {};
        for (const [name, propertySchema] of Object.entries(rawProperties)) {
          const property = compileJsonSchema(propertySchema);
          properties[name] = required.has(name) ? property : Type.Optional(property);
        }
        let additionalProperties: boolean | TSchema | undefined;
        if (typeof schema.additionalProperties === "boolean") {
          additionalProperties = schema.additionalProperties;
        } else if (
          typeof schema.additionalProperties === "object" &&
          schema.additionalProperties !== null
        ) {
          additionalProperties = compileJsonSchema(schema.additionalProperties);
        }
        compiled = Type.Object(properties, {
          ...(additionalProperties !== undefined ? { additionalProperties } : {}),
          ...(typeof schema.minProperties === "number"
            ? { minProperties: schema.minProperties }
            : {}),
          ...(typeof schema.maxProperties === "number"
            ? { maxProperties: schema.maxProperties }
            : {}),
        });
        break;
      }
      default:
        compiled = Type.Any();
    }
  }

  compiledGameSchemas.set(input, compiled);
  return compiled;
}
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

/**
 * Validates a request value against a game-provided JSON Schema.
 */
export function parseJsonSchemaValue(schema: unknown, value: unknown): Json {
  return parseRequestBody(compileJsonSchema(schema), value) as Json;
}
