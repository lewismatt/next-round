// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserRoot = path.join(repositoryRoot, "apps/web/dist");
const counterClient = path.join(
  browserRoot,
  "games/test-counter/0.1.0/client.js",
);
const forbidden = [
  "next-round-test-counter-server-fixture-secret-v1",
];

if (!fs.existsSync(counterClient)) {
  throw new Error(`Counter browser artifact is missing: ${counterClient}`);
}
for (const [game, version] of [
  ["crossword", "0.1.0"],
  ["trivia", "0.2.0"],
]) {
  if (!fs.existsSync(path.join(browserRoot, `games/${game}/${version}/client.js`))) {
    throw new Error(`${game} browser artifact is missing`);
  }
}

const pending = [browserRoot];
const files = [];
while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      pending.push(entryPath);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
}

for (const file of files) {
  const contents = fs.readFileSync(file);
  for (const secret of forbidden) {
    if (contents.includes(Buffer.from(secret))) {
      throw new Error(`Server fixture secret found in browser artifact: ${file}`);
    }
  }
}

process.stdout.write(`Scanned ${files.length} browser artifacts; no server fixture secret found.\n`);
