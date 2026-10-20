// SPDX-License-Identifier: Apache-2.0
// Runs focused real-PostgreSQL pg-boss transaction evidence and generates the
// selected shadcn preset in a disposable directory without touching the checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const mode = process.argv[2] ?? "all";
assert.ok(
  ["all", "database-only", "preset-only"].includes(mode),
  "Usage: node scripts/f0-acceptance.mjs [all|database-only|preset-only]",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}

if (mode !== "preset-only") {
  assert.ok(
    process.env.TEST_DATABASE_URL,
    "Set TEST_DATABASE_URL to a PostgreSQL 17 or 18 database with CREATE DATABASE privilege",
  );
  run("pnpm", [
    "exec",
    "vitest",
    "run",
    "packages/db/src/migrations.integration.test.ts",
  ]);
}

if (mode !== "database-only") {
  const directory = await mkdtemp(join(tmpdir(), "next-round-shadcn-f0-"));
  try {
    // `--name` makes init create a new project; `--yes` suppresses prompts.
    run(
      "pnpm",
      [
        "dlx",
        "shadcn@4.22.0",
        "init",
        "--preset",
        "b7kBs9lVB5",
        "--base",
        "radix",
        "--template",
        "vite",
        "--monorepo",
        "--name",
        "next-round-f0-probe",
        "--yes",
      ],
      { cwd: directory },
    );

    const files = [];
    async function collect(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = join(path, entry.name);
        if (entry.isDirectory()) await collect(fullPath);
        else files.push(fullPath);
      }
    }
    await collect(directory);
    const componentFiles = files.filter((path) =>
      path.endsWith("components.json"),
    );
    assert.ok(
      componentFiles.length > 0,
      "pinned CLI produced no components.json",
    );
    for (const path of componentFiles) {
      const config = JSON.parse(await readFile(path, "utf8"));
      console.log(
        `Generated ${path.slice(directory.length + 1)} components.json: ${JSON.stringify(config)}`,
      );
    }
    const packageFiles = files.filter((path) => path.endsWith("package.json"));
    assert.ok(
      packageFiles.length > 0,
      "pinned CLI produced no package.json for peer/dependency inspection",
    );
    for (const path of packageFiles) {
      const pkg = JSON.parse(await readFile(path, "utf8"));
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      console.log(
        `Generated ${path.slice(directory.length + 1)}: ${JSON.stringify({
          name: pkg.name,
          dependencies: Object.fromEntries(
            Object.entries(dependencies).filter(
              ([name]) =>
                name === "react" ||
                name === "react-dom" ||
                name === "vite" ||
                name === "@vitejs/plugin-react" ||
                name === "tailwindcss" ||
                name === "@tailwindcss/vite" ||
                name === "radix-ui" ||
                name === "lucide-react" ||
                name.startsWith("@types/react"),
            ),
          ),
          peerDependencies: pkg.peerDependencies ?? {},
          engines: pkg.engines ?? {},
        })}`,
      );
    }
    for (const path of files.filter((item) =>
      /(?:\.css|components\.json)$/.test(item),
    )) {
      if (path.endsWith("components.json")) continue;
      const contents = await readFile(path, "utf8");
      if (/font|@theme|--radius|--background|--primary/i.test(contents)) {
        console.log(
          `Generated theme/font source ${path.slice(directory.length + 1)}:\n${contents}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
