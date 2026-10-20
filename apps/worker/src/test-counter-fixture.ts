// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { manifest } from "@next-round/game-test-counter/manifest";
import { server } from "@next-round/game-test-counter/server";
import type { GameRegistry } from "@next-round/platform";

const bundledClientRoot = fileURLToPath(
  new URL("../../../apps/web/dist/games/test-counter/0.1.0/", import.meta.url),
);

/** Load the internal fixture only when the operator explicitly opts in. */
export function registerTestCounterFixture(
  registry: GameRegistry,
  clientRoot = bundledClientRoot,
): void {
  if (registry.has(manifest.id, manifest.version)) return;
  registry.register(manifest, server, { clientRoot, isDefault: true });
}

export function loadTestCounterFixtureIfEnabled(
  registry: GameRegistry,
  enabled: boolean,
  clientRoot = bundledClientRoot,
): void {
  if (enabled) registerTestCounterFixture(registry, clientRoot);
}
