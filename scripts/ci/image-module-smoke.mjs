// SPDX-License-Identifier: Apache-2.0
// Run inside a fresh deployment image, from /app, via node --input-type=module.
import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve the same production dependency closure as each executable. No test
// dependencies, source checkout, database, volumes, or filesystem repairs.
for (const executable of ["api", "worker"]) {
  const root = `/app/apps/${executable}`;
  const require = createRequire(`${root}/package.json`);
  const { GameRegistry } = await import(pathToFileURL(require.resolve("@next-round/platform")));
  const { registerCrosswordModule } = await import(`${root}/dist/crossword-fixture.js`);
  const { registerTriviaModule } = await import(`${root}/dist/trivia-module.js`);
  const { registerCipherModule } = await import(`${root}/dist/cipher-module.js`);
  const { loadTestCounterFixtureIfEnabled } = await import(`${root}/dist/test-counter-fixture.js`);
  const registry = new GameRegistry();
  registerCrosswordModule(registry);
  assert.ok(registry.has("crossword", "0.1.0"), `${executable}: crossword skipped`);
  registerTriviaModule(registry);
  assert.ok(registry.has("trivia", "0.2.0"), `${executable}: trivia skipped`);
  registerCipherModule(registry);
  assert.ok(registry.has("cipher", "0.1.0"), `${executable}: cipher skipped`);
  assert.equal((await lstat("/app/apps/web/dist")).isDirectory(), true,
    "The image must contain the web build, not a runtime workaround symlink");
  loadTestCounterFixtureIfEnabled(registry, true);
  assert.ok(registry.has("test-counter", "0.1.0"), `${executable}: counter missing`);
  for (const [game, version] of [
    ["crossword", "0.1.0"],
    ["trivia", "0.2.0"],
    ["cipher", "0.1.0"],
    ["test-counter", "0.1.0"],
  ]) {
    const relative = `games/${game}/${version}/client.js`;
    const client = `/app/apps/web/dist/${relative}`;
    assert.equal((await lstat(client)).isFile(), true);
    assert.deepEqual(await readFile(client), await readFile(`/app/public/${relative}`));
  }
  console.log(`${executable}: crossword, trivia, cipher and opt-in counter registered from the stock image`);
}
