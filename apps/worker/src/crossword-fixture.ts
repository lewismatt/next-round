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
 * Registers the crossword module with the worker registry.
 *
 * The worker verifies module retention readiness, so a database that declares
 * the crossword needs the same module version here. A missing browser client
 * leaves the module out of the registry and the readiness check reports it.
 */
export function registerCrosswordModule(
  registry: GameRegistry,
  clientRoot = bundledClientRoot,
): void {
  if (registry.has(manifest.id, manifest.version)) return;
  if (!fs.existsSync(path.join(clientRoot, "client.js"))) {
    // BL-045: same structured diagnostic the API emits (BL-028), so a log
    // search for MODULE_CLIENT_MISSING finds worker skips too.
    console.warn(JSON.stringify({
      level: "warn",
      code: "MODULE_CLIENT_MISSING",
      moduleId: manifest.id,
      moduleVersion: manifest.version,
      message: "Crossword registration skipped: bundled client.js unavailable.",
    }));
    return;
  }
  registry.register(manifest, server, { clientRoot, isDefault: true });
}
