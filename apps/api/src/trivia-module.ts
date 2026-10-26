// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@next-round/game-trivia/manifest";
import { server } from "@next-round/game-trivia/server";
import type { GameRegistry } from "@next-round/platform";

const bundledClientRoot = fileURLToPath(
  new URL("../../../apps/web/dist/games/trivia/0.2.0/", import.meta.url),
);

export function registerTriviaModule(
  registry: GameRegistry,
  clientRoot = bundledClientRoot,
): void {
  if (registry.has(manifest.id, manifest.version)) return;
  if (!fs.existsSync(path.join(clientRoot, "client.js"))) {
    console.warn(
      JSON.stringify({
        level: "warn",
        code: "MODULE_CLIENT_MISSING",
        moduleId: manifest.id,
        moduleVersion: manifest.version,
        message:
          "Trivia registration skipped: build the browser client before deployment.",
      }),
    );
    return;
  }
  registry.register(manifest, server, { clientRoot, isDefault: true });
}
