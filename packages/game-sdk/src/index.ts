import type { GameServer, Json } from "./types.js";

export * from "./types.js";

/**
 * Type-safe helper to define a GameServer implementation matching Master Spec §2.
 */
export function defineGameServer<S extends Json = Json, V extends Json = Json>(
  server: GameServer<S, V>
): GameServer<S, V> {
  return server;
}
