#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

assert.ok(
  process.env.TEST_DATABASE_URL,
  "TEST_DATABASE_URL must name a PostgreSQL 18 or 17 database whose role can CREATE DATABASE/ROLE (each component uses disposable databases)",
);
const root = new URL("../", import.meta.url);
const components = [
  {
    args: ["scripts/sprint2-acceptance.mjs"],
    scope:
      "F1-09/10 real two-process listener/fanout missed-wakeup recovery measurements, pinned versions, disable and retained-code/assets startup checks",
  },
  {
    args: ["scripts/sprint3-evidence.mjs"],
    scope:
      "H1-H6 platform scenarios: token races/expiry, guest lifetimes/identity, chat/rejoin/access, notifications/result eligibility, migrations/restore/worker retry, retention/admin; deliberately broken private-view negative control must fail",
  },
  {
    args: ["scripts/sprint4-cli.mjs", "--scenario"],
    scope:
      "Real developer CLI, Test Counter solo/group/private notes/late join/rejoin/deadline identity/post-commit retry/restart/completed and ended-early results; finished registration issue denial, closed-destination registration, admin nonmember link revocation and rolling/concurrent token budget",
  },
];
const evidence = [];
for (const component of components) {
  console.log(
    `\nSprint 4 component: node ${component.args.join(" ")}\n${component.scope}`,
  );
  const result = spawnSync(process.execPath, component.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `${component.args[0]} terminated by signal`,
  );
  assert.equal(result.status, 0, `${component.args[0]} failed`);
  evidence.push({
    command: `node ${component.args.join(" ")}`,
    scope: component.scope,
    exit: result.status,
  });
}
console.log(
  JSON.stringify(
    {
      scenario: "Sprint 4 composed server/CLI evidence",
      components: evidence,
      acceptanceBoundary:
        "This command composes platform and CLI/game predicates without renaming Sprint 3 into full F2. The F1 browser-shell journey, browser non-resend behavior and login-budget regression suite require separate evidence. No browser journey or unexecuted requirement is claimed by this command.",
    },
    null,
    2,
  ),
);
