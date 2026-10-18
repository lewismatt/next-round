import { Type, type Static, type TSchema } from "@sinclair/typebox";
import semver from "semver";

export const SDK_IDENTIFIER = "next-round-game/0.1" as const;
export type SdkIdentifier = typeof SDK_IDENTIFIER;

export const MODULE_ID_PATTERN = "^[a-z][a-z0-9-]{1,62}$";
export const ACTION_TYPE_PATTERN = "^[a-z][a-z0-9_.-]{0,63}$";
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export const JsonSchema: TSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ])
);

export type Schema = Record<string, Json>;

export const SchemaSchema: TSchema = Type.Record(Type.String(), JsonSchema);

export const GameModeSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 63,
      pattern: "^[a-z][a-z0-9-]{0,62}$",
    }),
    label: Type.String({ minLength: 1, maxLength: 40 }),
    minPlayersToStart: Type.Integer({
      minimum: MIN_PLAYERS,
      maximum: MAX_PLAYERS,
    }),
    maxPlayers: Type.Integer({
      minimum: MIN_PLAYERS,
      maximum: MAX_PLAYERS,
    }),
    lateJoin: Type.Boolean(),
    rejoin: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type GameMode = Static<typeof GameModeSchema>;

export const GameCapabilitiesSchema = Type.Object(
  {
    chat: Type.Boolean(),
    deadlines: Type.Boolean(),
    solo: Type.Boolean(),
    resources: Type.Boolean(),
    careerStats: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type GameCapabilities = Static<typeof GameCapabilitiesSchema>;

export const ResourceSchemasSchema = Type.Object(
  {
    import: SchemaSchema,
    metadata: SchemaSchema,
    data: SchemaSchema,
    facts: SchemaSchema,
  },
  { additionalProperties: false }
);
export type ResourceSchemas = Static<typeof ResourceSchemasSchema>;

export const GameClientConfigSchema = Type.Object(
  {
    entry: Type.String({ minLength: 1 }),
    css: Type.Array(Type.String()),
  },
  { additionalProperties: false }
);
export type GameClientConfig = Static<typeof GameClientConfigSchema>;

export const GameManifestSchema = Type.Object(
  {
    id: Type.String({
      minLength: 2,
      maxLength: 63,
      pattern: MODULE_ID_PATTERN,
    }),
    name: Type.String({ minLength: 1, maxLength: 40 }),
    version: Type.String(),
    sdk: Type.Literal(SDK_IDENTIFIER),
    platformRange: Type.String(),
    stateVersion: Type.Integer({ minimum: 1 }),
    resultVersion: Type.Integer({ minimum: 1 }),
    description: Type.String({ maxLength: 500 }),
    modes: Type.Array(GameModeSchema, { minItems: 1 }),
    capabilities: GameCapabilitiesSchema,
    settingsSchema: SchemaSchema,
    resourceSchemas: Type.Optional(ResourceSchemasSchema),
    actionSchemas: Type.Record(
      Type.String({ pattern: ACTION_TYPE_PATTERN }),
      SchemaSchema
    ),
    stateSchema: SchemaSchema,
    viewSchema: SchemaSchema,
    resultSchema: SchemaSchema,
    client: GameClientConfigSchema,
    setupEntry: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);
export type GameManifest = Static<typeof GameManifestSchema>;

export type ManifestValidationResult =
  | { ok: true; value: GameManifest }
  | { ok: false; errors: string[] };

const moduleIdRegex = new RegExp(`^${MODULE_ID_PATTERN}$`);
const actionTypeRegex = new RegExp(`^${ACTION_TYPE_PATTERN}$`);

export function validateGameManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // id
  if (typeof m.id !== "string" || !moduleIdRegex.test(m.id)) {
    errors.push(
      `Invalid manifest id: must match pattern ${MODULE_ID_PATTERN}`
    );
  }

  // name
  if (
    typeof m.name !== "string" ||
    m.name.trim().length === 0 ||
    m.name.length > 40
  ) {
    errors.push("Invalid manifest name: must be 1 to 40 characters");
  }

  // version
  if (typeof m.version !== "string") {
    errors.push("Manifest version must be a string");
  } else {
    if (m.version.includes("+")) {
      errors.push("Manifest version must not contain build metadata (+)");
    } else if (!semver.valid(m.version)) {
      errors.push(`Manifest version '${m.version}' is not valid SemVer`);
    }
  }

  // sdk
  if (m.sdk !== SDK_IDENTIFIER) {
    errors.push(`Manifest sdk must be exactly '${SDK_IDENTIFIER}'`);
  }

  // platformRange
  if (typeof m.platformRange !== "string") {
    errors.push("Manifest platformRange must be a string");
  } else if (!semver.validRange(m.platformRange)) {
    errors.push(`Manifest platformRange '${m.platformRange}' is not a valid SemVer range`);
  }

  // stateVersion & resultVersion
  if (
    typeof m.stateVersion !== "number" ||
    !Number.isInteger(m.stateVersion) ||
    m.stateVersion < 1
  ) {
    errors.push("Manifest stateVersion must be a positive integer");
  }

  if (
    typeof m.resultVersion !== "number" ||
    !Number.isInteger(m.resultVersion) ||
    m.resultVersion < 1
  ) {
    errors.push("Manifest resultVersion must be a positive integer");
  }

  // description
  if (typeof m.description !== "string" || m.description.length > 500) {
    errors.push("Manifest description must be a string of at most 500 characters");
  }

  // modes
  if (!Array.isArray(m.modes) || m.modes.length === 0) {
    errors.push("Manifest must declare at least one mode");
  } else {
    const seenModeIds = new Set<string>();
    for (let i = 0; i < m.modes.length; i++) {
      const mode = m.modes[i];
      if (typeof mode !== "object" || mode === null) {
        errors.push(`Mode at index ${i} must be an object`);
        continue;
      }
      const modeObj = mode as Record<string, unknown>;
      if (typeof modeObj.id !== "string" || modeObj.id.length === 0) {
        errors.push(`Mode at index ${i} has invalid id`);
      } else if (seenModeIds.has(modeObj.id)) {
        errors.push(`Duplicate mode id '${modeObj.id}'`);
      } else {
        seenModeIds.add(modeObj.id);
      }

      if (
        typeof modeObj.minPlayersToStart !== "number" ||
        modeObj.minPlayersToStart < MIN_PLAYERS ||
        modeObj.minPlayersToStart > MAX_PLAYERS
      ) {
        errors.push(
          `Mode '${modeObj.id}' minPlayersToStart must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`
        );
      }

      if (
        typeof modeObj.maxPlayers !== "number" ||
        modeObj.maxPlayers < MIN_PLAYERS ||
        modeObj.maxPlayers > MAX_PLAYERS
      ) {
        errors.push(
          `Mode '${modeObj.id}' maxPlayers must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`
        );
      }

      if (
        typeof modeObj.minPlayersToStart === "number" &&
        typeof modeObj.maxPlayers === "number" &&
        modeObj.minPlayersToStart > modeObj.maxPlayers
      ) {
        errors.push(
          `Mode '${modeObj.id}' minPlayersToStart cannot exceed maxPlayers`
        );
      }

      if (typeof modeObj.lateJoin !== "boolean") {
        errors.push(`Mode '${modeObj.id}' lateJoin must be a boolean`);
      }
      if (typeof modeObj.rejoin !== "boolean") {
        errors.push(`Mode '${modeObj.id}' rejoin must be a boolean`);
      }
    }
  }

  // capabilities
  if (typeof m.capabilities !== "object" || m.capabilities === null) {
    errors.push("Manifest capabilities must be an object");
  } else {
    const caps = m.capabilities as Record<string, unknown>;
    const requiredCaps = ["chat", "deadlines", "solo", "resources", "careerStats"] as const;
    for (const cap of requiredCaps) {
      if (typeof caps[cap] !== "boolean") {
        errors.push(`Capability '${cap}' must be a boolean`);
      }
    }
  }

  // schemas
  if (typeof m.settingsSchema !== "object" || m.settingsSchema === null) {
    errors.push("Manifest settingsSchema must be an object");
  }
  if (typeof m.stateSchema !== "object" || m.stateSchema === null) {
    errors.push("Manifest stateSchema must be an object");
  }
  if (typeof m.viewSchema !== "object" || m.viewSchema === null) {
    errors.push("Manifest viewSchema must be an object");
  }
  if (typeof m.resultSchema !== "object" || m.resultSchema === null) {
    errors.push("Manifest resultSchema must be an object");
  }

  // actionSchemas
  if (typeof m.actionSchemas !== "object" || m.actionSchemas === null) {
    errors.push("Manifest actionSchemas must be a record");
  } else {
    for (const [actionName, actionSchema] of Object.entries(m.actionSchemas)) {
      if (!actionTypeRegex.test(actionName)) {
        errors.push(
          `Action type name '${actionName}' does not match pattern ${ACTION_TYPE_PATTERN}`
        );
      }
      if (typeof actionSchema !== "object" || actionSchema === null) {
        errors.push(`Action schema for '${actionName}' must be an object`);
      }
    }
  }

  // client
  if (typeof m.client !== "object" || m.client === null) {
    errors.push("Manifest client configuration must be an object");
  } else {
    const client = m.client as Record<string, unknown>;
    if (typeof client.entry !== "string" || client.entry.length === 0) {
      errors.push("Manifest client.entry must be a non-empty string");
    }
    if (!Array.isArray(client.css) || !client.css.every((c) => typeof c === "string")) {
      errors.push("Manifest client.css must be an array of strings");
    }
  }

  if (m.setupEntry !== undefined && (typeof m.setupEntry !== "string" || m.setupEntry.length === 0)) {
    errors.push("Manifest setupEntry must be a non-empty string if provided");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: manifest as GameManifest };
}

export function isGameManifest(manifest: unknown): manifest is GameManifest {
  return validateGameManifest(manifest).ok;
}
