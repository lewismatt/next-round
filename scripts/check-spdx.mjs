#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST_PATH = "third_party/provenance.json";
export const DEFAULT_LICENSE = "Apache-2.0";
const MANIFEST_VERSION = 1;
const ENTRY_KEYS = ["path", "license", "source", "attribution"];
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
]);
const headerPattern =
  /^(?:\/\/|\/\*) SPDX-License-Identifier: (\S+?)(?: \*\/)?$/;

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "";
const isRepoRelative = (value) =>
  isNonEmptyString(value) &&
  value === path.posix.normalize(value) &&
  !value.includes("\\") &&
  !path.posix.isAbsolute(value) &&
  value !== ".." &&
  !value.startsWith("../");

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function expectedHeader(file, license) {
  return path.extname(file) === ".css"
    ? `/* SPDX-License-Identifier: ${license} */`
    : `// SPDX-License-Identifier: ${license}`;
}

// Copied preset/component sources retain upstream terms, not project ownership.
// Each is declared in the provenance manifest; returns the validated entries
// by path plus every problem found.
export function loadManifest(root, tracked) {
  const errors = [];
  const entries = new Map();
  const fail = (message) => errors.push(`${MANIFEST_PATH}: ${message}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
  } catch (error) {
    fail(`cannot read manifest as JSON (${error.message})`);
    return { entries, errors };
  }
  if (!isObject(manifest)) {
    fail("malformed manifest: top level must be an object");
    return { entries, errors };
  }
  for (const key of Object.keys(manifest)) {
    if (key !== "version" && key !== "entries")
      fail(`malformed manifest: unknown top-level field "${key}"`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    fail(
      `malformed manifest: "version" must be ${MANIFEST_VERSION}, found ${JSON.stringify(manifest.version)}`,
    );
  }
  if (!Array.isArray(manifest.entries)) {
    fail('malformed manifest: "entries" must be an array');
    return { entries, errors };
  }
  manifest.entries.forEach((entry, index) => {
    const label =
      isObject(entry) && isNonEmptyString(entry.path)
        ? entry.path
        : `entries[${index}]`;
    const bad = (message) => fail(`${label}: ${message}`);
    if (!isObject(entry)) return bad("malformed entry: must be an object");
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key))
        bad(`malformed entry: unknown field "${key}"`);
    }
    let valid = true;
    for (const key of ENTRY_KEYS) {
      if (!isNonEmptyString(entry[key])) {
        bad(`malformed entry: "${key}" must be a non-empty string`);
        valid = false;
      }
    }
    if (!valid) return;
    if (!isRepoRelative(entry.path))
      return bad('"path" must be a normalized repo-relative POSIX path');
    if (entry.path.startsWith("third_party/"))
      return bad(
        '"path" must not be under third_party/, which is excluded from the check',
      );
    if (!extensions.has(path.extname(entry.path)))
      return bad(
        `"path" has an extension the check does not cover (${[...extensions].join(", ")})`,
      );
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(entry.license))
      return bad('"license" must be a single SPDX license identifier');
    if (!isHttpsUrl(entry.source))
      return bad('"source" must be an https URL of the upstream project');
    if (!isRepoRelative(entry.attribution))
      return bad('"attribution" must be a normalized repo-relative POSIX path');
    if (entries.has(entry.path))
      return bad("duplicate path: declared more than once in the manifest");
    entries.set(entry.path, entry);
    if (!tracked.has(entry.path))
      bad("declared path is not a tracked source file");
    if (
      !tracked.has(entry.attribution) ||
      !isFile(path.join(root, entry.attribution))
    ) {
      bad(
        `attribution reference ${entry.attribution} does not exist as a tracked file in the repo`,
      );
    }
  });
  return { entries, errors };
}

// `tracked` is every tracked repo path (POSIX, repo-relative). Returns the
// diagnostics and the number of source files checked.
export function checkSpdx(root, tracked) {
  const trackedSet = new Set(tracked);
  const { entries, errors } = loadManifest(root, trackedSet);
  const files = tracked.filter(
    (file) =>
      !file.startsWith("third_party/") && extensions.has(path.extname(file)),
  );
  if (errors.length > 0) return { errors, count: files.length };
  for (const file of files) {
    const entry = entries.get(file);
    const license = entry ? entry.license : DEFAULT_LICENSE;
    const expected = expectedHeader(file, license);
    const content = readFileSync(path.join(root, file), "utf8").replace(
      /^#![^\n]*\n/,
      "",
    );
    const first = content.split(/\r?\n/, 1)[0];
    if (first === expected) continue;
    const declared = headerPattern.exec(first)?.[1];
    if (!entry && declared && declared !== DEFAULT_LICENSE) {
      errors.push(
        `${file}: declares ${declared} but is not registered in ${MANIFEST_PATH}; ` +
          `add an entry (path, license, source, attribution) or use ${DEFAULT_LICENSE} for project-owned code`,
      );
    } else {
      errors.push(`${file}: expected first comment ${expected}`);
    }
  }
  return { errors, count: files.length };
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const { errors, count } = checkSpdx(root, tracked);
  for (const message of errors) console.error(message);
  if (errors.length > 0) process.exitCode = 1;
  else console.log(`SPDX headers verified in ${count} tracked source files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
