// SPDX-License-Identifier: Apache-2.0
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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
    name: Type.String({ minLength: 1, maxLength: 40, pattern: "\\S" }),
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
      SchemaSchema,
      { additionalProperties: false }
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

export function validateGameManifest(
  manifest: unknown,
  platformVersion?: string
): ManifestValidationResult {
  if (!Value.Check(GameManifestSchema, manifest)) {
    return {
      ok: false,
      errors: Array.from(Value.Errors(GameManifestSchema, manifest), (error) =>
        `${error.path || "/"}: ${error.message}`
      ),
    };
  }

  const errors: string[] = [];
  if (manifest.version.includes("+") || semver.valid(manifest.version) !== manifest.version) {
    errors.push("Manifest version must be exact SemVer without build metadata");
  }
  if (!semver.validRange(manifest.platformRange)) {
    errors.push("Manifest platformRange must be a valid SemVer range");
  } else if (platformVersion !== undefined && !semver.satisfies(platformVersion, manifest.platformRange)) {
    errors.push(`Module ${manifest.id}@${manifest.version} requires platform ${manifest.platformRange}; running ${platformVersion}`);
  }

  // Cross-field invariants are not expressible in the structural schema.
  const modeIds = new Set<string>();
  for (const mode of manifest.modes) {
    if (modeIds.has(mode.id)) {
      errors.push(`Duplicate mode id '${mode.id}'`);
    }
    modeIds.add(mode.id);
    if (mode.minPlayersToStart > mode.maxPlayers) {
      errors.push(`Mode '${mode.id}' minPlayersToStart cannot exceed maxPlayers`);
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: manifest };
}

export function isGameManifest(manifest: unknown): manifest is GameManifest {
  return validateGameManifest(manifest).ok;
}
