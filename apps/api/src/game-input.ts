// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  ERROR_CODES,
  parseJsonSchemaValue,
  type Json,
} from "@next-round/contracts";
import type { GameRegistry, RegisteredGameVersion } from "@next-round/platform";

function requireGameVersion(
  registry: GameRegistry,
  moduleId: string,
  version?: string,
): RegisteredGameVersion {
  const registered = registry.getVersion(moduleId, version);
  if (!registered) {
    throw new ApiError(ERROR_CODES.MODULE_UNAVAILABLE, "Game module is not available.");
  }
  return registered;
}

/** Validates match settings at the API boundary before any match service runs. */
export function parseGameSettings(
  registry: GameRegistry,
  moduleId: string,
  version: string | undefined,
  settings: unknown,
): Json {
  const registered = requireGameVersion(registry, moduleId, version);
  return parseJsonSchemaValue(registered.manifest.settingsSchema, settings);
}

/** Validates an action type and payload at the API boundary before any reducer runs. */
export function parseGameAction(
  registry: GameRegistry,
  moduleId: string,
  version: string | undefined,
  actionType: string,
  payload: unknown,
): Json {
  const registered = requireGameVersion(registry, moduleId, version);
  const schema = registered.manifest.actionSchemas[actionType];
  if (!schema) {
    throw new ApiError(ERROR_CODES.INVALID_REQUEST, "Action type is not defined by the game module.", {
      details: { fields: ["/type"] },
    });
  }
  return parseJsonSchemaValue(schema, payload);
}
