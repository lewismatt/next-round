#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Copied preset/component sources retain upstream terms, not project ownership.
const upstream = new Set([
  "packages/ui/src/components/button.tsx",
  "packages/ui/src/lib/utils.ts",
  "packages/ui/src/styles/globals.css",
]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"]);
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(file => file && !file.startsWith("third_party/") && extensions.has(path.extname(file)));
let failed = false;
for (const file of files) {
  const license = upstream.has(file) ? "MIT" : "Apache-2.0";
  const expected = path.extname(file) === ".css"
    ? `/* SPDX-License-Identifier: ${license} */`
    : `// SPDX-License-Identifier: ${license}`;
  const content = readFileSync(path.join(root, file), "utf8").replace(/^#![^\n]*\n/, "");
  if (content.split(/\r?\n/, 1)[0] !== expected) {
    console.error(`${file}: expected first comment ${expected}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`SPDX headers verified in ${files.length} tracked source files.`);
