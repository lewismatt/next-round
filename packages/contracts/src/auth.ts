// SPDX-License-Identifier: Apache-2.0
import { Kind, TypeRegistry, Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ApiError, ERROR_CODES } from "./errors.js";
import type { Json } from "./manifest.js";

if (!TypeRegistry.Has("OneOf")) {
  TypeRegistry.Set("OneOf", (schema: unknown, value: unknown) => {
    const s = schema as { oneOf: TSchema[] };
    let count = 0;
    for (const sub of s.oneOf) {
      if (Value.Errors(sub, value).First() === undefined) {
        count++;
        if (count > 1) return false;
      }
    }
    return count === 1;
  });
}

if (!TypeRegistry.Has("PrefixItems")) {
  TypeRegistry.Set("PrefixItems", (schema: unknown, value: unknown) => {
    if (!Array.isArray(value)) return false;
    const s = schema as {
      prefixItems: TSchema[];
      additionalItems?: boolean | TSchema;
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    };
    if (typeof s.minItems === "number" && value.length < s.minItems) return false;
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return false;
    if (s.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (Value.Equal(value[i], value[j])) return false;
        }
      }
    }
    for (let i = 0; i < value.length; i++) {
      if (i < s.prefixItems.length) {
        if (Value.Errors(s.prefixItems[i], value[i]).First() !== undefined) {
          return false;
        }
      } else {
        if (s.additionalItems === false) {
          return false;
        } else if (typeof s.additionalItems === "object" && s.additionalItems !== null) {
          if (Value.Errors(s.additionalItems, value[i]).First() !== undefined) {
            return false;
          }
        }
      }
    }
    return true;
  });
}
const SUPPORTED_PRIMITIVE_TYPES: Record<string, true> = Object.assign(Object.create(null), {
  null: true,
  boolean: true,
  integer: true,
  number: true,
  string: true,
  array: true,
  object: true,
});

const METADATA_KEYS: Record<string, true> = Object.assign(Object.create(null), {
  $schema: true,
  $id: true,
  title: true,
  description: true,
  default: true,
  examples: true,
});

const ALL_SUPPORTED_SCHEMA_KEYS: Record<string, true> = Object.assign(Object.create(null), {
  $schema: true,
  $id: true,
  title: true,
  description: true,
  default: true,
  examples: true,
  const: true,
  enum: true,
  oneOf: true,
  anyOf: true,
  allOf: true,
  type: true,
  properties: true,
  required: true,
  additionalProperties: true,
  minProperties: true,
  maxProperties: true,
  items: true,
  additionalItems: true,
  minItems: true,
  maxItems: true,
  uniqueItems: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  minLength: true,
  maxLength: true,
  pattern: true,
  format: true,
});
const compiledGameSchemas = new WeakMap<object, TSchema>();

function compileType(schema: Record<string, unknown>, type: string): TSchema {
  switch (type) {
    case "null":
      return Type.Null();
    case "boolean":
      return Type.Boolean();
    case "integer": {
      if (Object.hasOwn(schema, "minimum") && typeof schema.minimum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema minimum is invalid.");
      }
      if (Object.hasOwn(schema, "maximum") && typeof schema.maximum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema maximum is invalid.");
      }
      if (Object.hasOwn(schema, "exclusiveMinimum") && typeof schema.exclusiveMinimum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema exclusiveMinimum is invalid.");
      }
      if (Object.hasOwn(schema, "exclusiveMaximum") && typeof schema.exclusiveMaximum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema exclusiveMaximum is invalid.");
      }
      if (Object.hasOwn(schema, "multipleOf") && (typeof schema.multipleOf !== "number" || schema.multipleOf <= 0)) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema multipleOf is invalid.");
      }
      return Type.Integer({
        ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
        ...(typeof schema.exclusiveMinimum === "number" ? { exclusiveMinimum: schema.exclusiveMinimum } : {}),
        ...(typeof schema.exclusiveMaximum === "number" ? { exclusiveMaximum: schema.exclusiveMaximum } : {}),
        ...(typeof schema.multipleOf === "number" ? { multipleOf: schema.multipleOf } : {}),
      });
    }
    case "number": {
      if (Object.hasOwn(schema, "minimum") && typeof schema.minimum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema minimum is invalid.");
      }
      if (Object.hasOwn(schema, "maximum") && typeof schema.maximum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema maximum is invalid.");
      }
      if (Object.hasOwn(schema, "exclusiveMinimum") && typeof schema.exclusiveMinimum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema exclusiveMinimum is invalid.");
      }
      if (Object.hasOwn(schema, "exclusiveMaximum") && typeof schema.exclusiveMaximum !== "number") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema exclusiveMaximum is invalid.");
      }
      if (Object.hasOwn(schema, "multipleOf") && (typeof schema.multipleOf !== "number" || schema.multipleOf <= 0)) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema multipleOf is invalid.");
      }
      return Type.Number({
        ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
        ...(typeof schema.exclusiveMinimum === "number" ? { exclusiveMinimum: schema.exclusiveMinimum } : {}),
        ...(typeof schema.exclusiveMaximum === "number" ? { exclusiveMaximum: schema.exclusiveMaximum } : {}),
        ...(typeof schema.multipleOf === "number" ? { multipleOf: schema.multipleOf } : {}),
      });
    }
    case "string": {
      if (Object.hasOwn(schema, "minLength") && (typeof schema.minLength !== "number" || schema.minLength < 0 || !Number.isInteger(schema.minLength))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema minLength is invalid.");
      }
      if (Object.hasOwn(schema, "maxLength") && (typeof schema.maxLength !== "number" || schema.maxLength < 0 || !Number.isInteger(schema.maxLength))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema maxLength is invalid.");
      }
      if (Object.hasOwn(schema, "pattern") && typeof schema.pattern !== "string") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema pattern is invalid.");
      }
      if (Object.hasOwn(schema, "format") && typeof schema.format !== "string") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema format is invalid.");
      }
      return Type.String({
        ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
        ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
        ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}),
        ...(typeof schema.format === "string" ? { format: schema.format } : {}),
      });
    }
    case "array": {
      if (Object.hasOwn(schema, "minItems") && (typeof schema.minItems !== "number" || schema.minItems < 0 || !Number.isInteger(schema.minItems))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema minItems is invalid.");
      }
      if (Object.hasOwn(schema, "maxItems") && (typeof schema.maxItems !== "number" || schema.maxItems < 0 || !Number.isInteger(schema.maxItems))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema maxItems is invalid.");
      }
      if (Object.hasOwn(schema, "uniqueItems") && typeof schema.uniqueItems !== "boolean") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema uniqueItems is invalid.");
      }
      const arrayOptions = {
        ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
        ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
        ...(typeof schema.uniqueItems === "boolean" ? { uniqueItems: schema.uniqueItems } : {}),
      };
      if (Array.isArray(schema.items)) {
        let additionalItems: boolean | TSchema | undefined;
        if (typeof schema.additionalItems === "boolean") {
          additionalItems = schema.additionalItems;
        } else if (
          typeof schema.additionalItems === "object" &&
          schema.additionalItems !== null
        ) {
          additionalItems = compileJsonSchema(schema.additionalItems);
        } else if (Object.hasOwn(schema, "additionalItems") && schema.additionalItems !== undefined) {
          throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema additionalItems is invalid.");
        }
        return Type.Unsafe({
          [Kind]: "PrefixItems",
          prefixItems: schema.items.map((item) => compileJsonSchema(item)),
          ...(additionalItems !== undefined ? { additionalItems } : {}),
          ...arrayOptions,
        });
      }
      if (Object.hasOwn(schema, "items") && schema.items !== undefined && typeof schema.items !== "object" && typeof schema.items !== "boolean") {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema items is invalid.");
      }
      return Type.Array(compileJsonSchema(schema.items ?? {}), arrayOptions);
    }
    case "object": {
      if (Object.hasOwn(schema, "properties") && (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema properties is invalid.");
      }
      if (Object.hasOwn(schema, "required")) {
        if (
          !Array.isArray(schema.required) ||
          schema.required.some((name) => typeof name !== "string") ||
          new Set(schema.required).size !== schema.required.length
        ) {
          throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema required is invalid.");
        }
      }
      if (Object.hasOwn(schema, "minProperties") && (typeof schema.minProperties !== "number" || schema.minProperties < 0 || !Number.isInteger(schema.minProperties))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema minProperties is invalid.");
      }
      if (Object.hasOwn(schema, "maxProperties") && (typeof schema.maxProperties !== "number" || schema.maxProperties < 0 || !Number.isInteger(schema.maxProperties))) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema maxProperties is invalid.");
      }

      const rawProperties =
        typeof schema.properties === "object" &&
        schema.properties !== null &&
        !Array.isArray(schema.properties)
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((name): name is string => typeof name === "string")
          : [],
      );

      const properties: Record<string, TSchema> = Object.create(null);
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
      } else if (Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== undefined) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema additionalProperties is invalid.");
      }

      const compiled = Type.Object(properties, {
        ...(additionalProperties !== undefined ? { additionalProperties } : {}),
        ...(typeof schema.minProperties === "number" ? { minProperties: schema.minProperties } : {}),
        ...(typeof schema.maxProperties === "number" ? { maxProperties: schema.maxProperties } : {}),
      });
      if (Array.isArray(schema.required)) {
        compiled.required = schema.required.slice();
      }
      return compiled;
    }
    default:
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema type is unsupported or invalid.");
  }
}

export function compileJsonSchema(input: unknown): TSchema {
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

  for (const key of Object.keys(schema)) {
    if (!Object.hasOwn(ALL_SUPPORTED_SCHEMA_KEYS, key)) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, `Game schema keyword '${key}' is unsupported.`);
    }
  }

  // Blocker 5: Validate 'type' upfront regardless of composition
  if (Object.hasOwn(schema, "type")) {
    if (Array.isArray(schema.type)) {
      if (schema.type.length === 0) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema type is unsupported or invalid.");
      }
      for (const t of schema.type) {
        if (typeof t !== "string" || !Object.hasOwn(SUPPORTED_PRIMITIVE_TYPES, t)) {
          throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema type is unsupported or invalid.");
        }
      }
    } else if (typeof schema.type === "string") {
      if (!Object.hasOwn(SUPPORTED_PRIMITIVE_TYPES, schema.type)) {
        throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema type is unsupported or invalid.");
      }
    } else {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema type is unsupported or invalid.");
    }
  }

  const parts: TSchema[] = [];

  if (Object.hasOwn(schema, "const")) {
    const value = schema.const;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema const is invalid.");
    }
    parts.push(value === null ? Type.Null() : Type.Literal(value));
  }

  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum)) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema enum is invalid.");
    }
    const values = schema.enum;
    if (values.length === 0) {
      parts.push(Type.Never());
    } else {
      parts.push(
        Type.Union(
          values.map((value) => {
            if (
              value !== null &&
              typeof value !== "string" &&
              typeof value !== "number" &&
              typeof value !== "boolean"
            ) {
              throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema enum is invalid.");
            }
            return value === null ? Type.Null() : Type.Literal(value);
          }),
        ),
      );
    }
  }

  if (Object.hasOwn(schema, "allOf")) {
    if (!Array.isArray(schema.allOf)) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema allOf is invalid.");
    }
    const members = schema.allOf.map((member) => compileJsonSchema(member));
    parts.push(members.length === 0 ? Type.Any() : Type.Intersect(members));
  }

  if (Object.hasOwn(schema, "anyOf")) {
    if (!Array.isArray(schema.anyOf)) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema anyOf is invalid.");
    }
    const alternatives = schema.anyOf;
    parts.push(
      alternatives.length === 0
        ? Type.Never()
        : Type.Union(alternatives.map((alt) => compileJsonSchema(alt))),
    );
  }

  if (Object.hasOwn(schema, "oneOf")) {
    if (!Array.isArray(schema.oneOf)) {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema oneOf is invalid.");
    }
    const alternatives = schema.oneOf;
    parts.push(
      alternatives.length === 0
        ? Type.Never()
        : Type.Unsafe({ [Kind]: "OneOf", oneOf: alternatives.map((alt) => compileJsonSchema(alt)) }),
    );
  }

  const hasType = Object.hasOwn(schema, "type");
  if (hasType) {
    if (Array.isArray(schema.type)) {
      parts.push(
        Type.Union(schema.type.map((type) => compileType(schema, type))),
      );
    } else if (typeof schema.type === "string") {
      parts.push(compileType(schema, schema.type));
    }
  }

  const hasObjectKeywords =
    Object.hasOwn(schema, "properties") ||
    Object.hasOwn(schema, "required") ||
    Object.hasOwn(schema, "additionalProperties") ||
    Object.hasOwn(schema, "minProperties") ||
    Object.hasOwn(schema, "maxProperties");

  const hasArrayKeywords =
    Object.hasOwn(schema, "items") ||
    Object.hasOwn(schema, "additionalItems") ||
    Object.hasOwn(schema, "minItems") ||
    Object.hasOwn(schema, "maxItems") ||
    Object.hasOwn(schema, "uniqueItems");

  const hasNumericKeywords =
    Object.hasOwn(schema, "minimum") ||
    Object.hasOwn(schema, "maximum") ||
    Object.hasOwn(schema, "exclusiveMinimum") ||
    Object.hasOwn(schema, "exclusiveMaximum") ||
    Object.hasOwn(schema, "multipleOf");

  const hasStringKeywords =
    Object.hasOwn(schema, "minLength") ||
    Object.hasOwn(schema, "maxLength") ||
    Object.hasOwn(schema, "pattern") ||
    Object.hasOwn(schema, "format");

  if (!hasType) {
    if (hasObjectKeywords) {
      parts.push(compileType(schema, "object"));
    }
    if (hasArrayKeywords) {
      const arr = compileType(schema, "array");
      parts.push(
        Type.Union([
          arr,
          Type.Number(),
          Type.String(),
          Type.Boolean(),
          Type.Object({}, { additionalProperties: true }),
          Type.Null(),
        ]),
      );
    }
    if (hasNumericKeywords) {
      const num = compileType(schema, "number");
      parts.push(
        Type.Union([
          num,
          Type.String(),
          Type.Boolean(),
          Type.Array(Type.Any()),
          Type.Object({}, { additionalProperties: true }),
          Type.Null(),
        ]),
      );
    }
    if (hasStringKeywords) {
      const str = compileType(schema, "string");
      parts.push(
        Type.Union([
          str,
          Type.Number(),
          Type.Boolean(),
          Type.Array(Type.Any()),
          Type.Object({}, { additionalProperties: true }),
          Type.Null(),
        ]),
      );
    }
  }

  let compiled: TSchema;
  if (parts.length === 0) {
    if (Object.keys(schema).every((k) => Object.hasOwn(METADATA_KEYS, k))) {
      compiled = Type.Any();
    } else {
      throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Game schema is unsupported or invalid.");
    }
  } else if (parts.length === 1) {
    compiled = parts[0];
  } else {
    compiled = Type.Intersect(parts);
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
  const iterator = Value.Errors(schema, body);
  const first = iterator.First();
  if (!first) {
    return body;
  }
  const fields = [...new Set([first.path || "/", ...Array.from(iterator, (error) => error.path || "/")])];
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
