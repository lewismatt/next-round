// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DatabasePool } from "@next-round/db";
import { installGameVersion, type GameRegistry } from "@next-round/platform";

/** Only shipped code is installed here. Test Counter remains opt-in because
 * its loader omits it from this registry unless the operator enables it. */
export async function installBundledGames(pool: DatabasePool, registry: GameRegistry): Promise<void> {
  const serverEntries: Record<string, () => string> = {
    crossword: () => import.meta.resolve("@next-round/game-crossword/server"),
    trivia: () => import.meta.resolve("@next-round/game-trivia/server"),
    cipher: () => import.meta.resolve("@next-round/game-cipher/server"),
    "test-counter": () => import.meta.resolve("@next-round/game-test-counter/server"),
  };
  for (const manifest of registry.list()) {
    const resolveServer = serverEntries[manifest.id];
    if (!resolveServer) continue;
    const version = registry.getVersion(manifest.id, manifest.version);
    if (!version?.server) continue;
    const serverHash = createHash("sha256").update(await readFile(fileURLToPath(resolveServer()))).digest("hex");
    const clientDigest = createHash("sha256");
    for (const [name, file] of [...version.clientAssets].sort(([a], [b]) => a.localeCompare(b))) {
      clientDigest.update(name).update("\0").update(await readFile(file));
    }
    await installGameVersion(pool, manifest, { serverHash, clientHash: clientDigest.digest("hex") });
  }
}
