// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@next-round/game-crossword/manifest";
import { server } from "@next-round/game-crossword/server";
import type { GameRegistry } from "@next-round/platform";

const bundledClientRoot = fileURLToPath(
  new URL("../../../apps/web/dist/games/crossword/0.1.0/", import.meta.url),
);

/**
 * Registers the crossword module in the server registry.
 *
 * The module ships with the product, so it is registered whenever its browser
 * client is present in the build. A missing client leaves the module out of
 * the registry, and the readiness check then reports the module as
 * unavailable instead of serving a broken client.
 */
export function registerCrosswordModule(
  registry: GameRegistry,
  clientRoot = bundledClientRoot,
): void {
  if (registry.has(manifest.id, manifest.version)) return;
  if (!fs.existsSync(path.join(clientRoot, "client.js"))) return;
  registry.register(manifest, server, { clientRoot, isDefault: true });
}
