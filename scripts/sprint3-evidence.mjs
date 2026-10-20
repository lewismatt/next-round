#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
function run(args) {
  const result = spawnSync(
    process.execPath,
    ["scripts/sprint3-acceptance.mjs", ...args],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    "Acceptance process must finish without a signal",
  );
  return result;
}

const positive = run([]);
assert.equal(positive.status, 0, "Full production H1–H6 acceptance failed");
const negative = run(["--core", "--negative-control"]);
assert.notEqual(negative.status, 0, "Broken private-view fixture incorrectly passed");
assert.match(negative.stderr, /consumer-visible private marker must be viewer-specific/,
  "Negative control failed before reaching its behavioral assertion");
console.log(JSON.stringify({
  positiveExit: positive.status,
  negativeExit: negative.status,
  negativeAssertion: "consumer-visible private marker must be viewer-specific",
}));