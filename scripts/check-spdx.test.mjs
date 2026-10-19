// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, checkSpdx } from "./check-spdx.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const entry = (overrides = {}) => ({
  path: "src/copied.ts",
  license: "MIT",
  source: "https://example.com/upstream",
  attribution: "third_party/upstream-LICENSE.txt",
  ...overrides,
});

// Builds a throwaway repo tree; `files` maps repo paths to contents and every
// key counts as tracked. `manifest` is serialised unless it is a string.
function fixture(files, manifest = { version: 1, entries: [entry()] }) {
  const root = mkdtempSync(path.join(tmpdir(), "check-spdx-"));
  roots.push(root);
  const all = {
    "third_party/upstream-LICENSE.txt": "MIT License\n",
    "src/copied.ts": "// SPDX-License-Identifier: MIT\nexport {};\n",
    "src/own.ts": "// SPDX-License-Identifier: Apache-2.0\nexport {};\n",
    ...files,
  };
  if (manifest !== null)
    all[MANIFEST_PATH] =
      typeof manifest === "string" ? manifest : JSON.stringify(manifest);
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return { root, tracked: Object.keys(all) };
}

const run = ({ root, tracked }) => checkSpdx(root, tracked).errors;

describe("check-spdx provenance manifest", () => {
  it("passes a registered MIT source and an Apache-2.0 project source", () => {
    expect(run(fixture({}))).toEqual([]);
  });

  it("registers a newly copied component through the manifest alone", () => {
    const files = {
      "src/new-widget.tsx": "// SPDX-License-Identifier: MIT\nexport {};\n",
    };
    const manifest = {
      version: 1,
      entries: [entry(), entry({ path: "src/new-widget.tsx" })],
    };
    expect(run(fixture(files, manifest))).toEqual([]);
  });

  it("keeps shebang, CSS comment form, missing-header and third_party handling", () => {
    const files = {
      "bin/tool.mjs":
        "#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\n",
      "src/own.css": "/* SPDX-License-Identifier: Apache-2.0 */\n",
      "src/headless.ts": "export {};\n",
      "third_party/vendored.js": "module.exports = {};\n",
    };
    expect(run(fixture(files))).toEqual([
      "src/headless.ts: expected first comment // SPDX-License-Identifier: Apache-2.0",
    ]);
  });

  it("uses the CSS comment form for registered CSS", () => {
    const files = { "src/copied.css": "// SPDX-License-Identifier: MIT\n" };
    const manifest = {
      version: 1,
      entries: [entry(), entry({ path: "src/copied.css" })],
    };
    expect(run(fixture(files, manifest))).toEqual([
      "src/copied.css: expected first comment /* SPDX-License-Identifier: MIT */",
    ]);
  });

  it("rejects an undeclared MIT source", () => {
    const files = {
      "src/stray.ts": "// SPDX-License-Identifier: MIT\nexport {};\n",
    };
    const errors = run(fixture(files));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^src\/stray\.ts: declares MIT but is not registered in third_party\/provenance\.json/,
    );
  });

  it("rejects a registered file whose header does not match its declared license", () => {
    const files = {
      "src/copied.ts": "// SPDX-License-Identifier: Apache-2.0\n",
    };
    expect(run(fixture(files))).toEqual([
      "src/copied.ts: expected first comment // SPDX-License-Identifier: MIT",
    ]);
  });

  it("rejects a missing attribution reference", () => {
    const manifest = {
      version: 1,
      entries: [entry({ attribution: "third_party/absent.txt" })],
    };
    expect(run(fixture({}, manifest))).toEqual([
      "third_party/provenance.json: src/copied.ts: attribution reference third_party/absent.txt does not exist as a tracked file in the repo",
    ]);
  });

  it("rejects a duplicate path", () => {
    const manifest = {
      version: 1,
      entries: [entry(), entry({ source: "https://example.com/other" })],
    };
    expect(run(fixture({}, manifest))).toEqual([
      "third_party/provenance.json: src/copied.ts: duplicate path: declared more than once in the manifest",
    ]);
  });

  it("rejects a manifest that is missing, not JSON, or the wrong shape", () => {
    expect(run(fixture({}, null))[0]).toMatch(
      /^third_party\/provenance\.json: cannot read manifest as JSON/,
    );
    expect(run(fixture({}, "{ not json"))[0]).toMatch(
      /cannot read manifest as JSON/,
    );
    expect(run(fixture({}, []))).toEqual([
      "third_party/provenance.json: malformed manifest: top level must be an object",
    ]);
    expect(run(fixture({}, { version: 2, entries: [] }))[0]).toMatch(
      /"version" must be 1/,
    );
    expect(run(fixture({}, { version: 1 }))).toEqual([
      'third_party/provenance.json: malformed manifest: "entries" must be an array',
    ]);
  });

  it("rejects malformed entries", () => {
    const bad = (overrides) =>
      run(fixture({}, { version: 1, entries: [entry(overrides)] }));
    expect(bad({ license: "" })[0]).toMatch(
      /"license" must be a non-empty string/,
    );
    expect(bad({ license: "MIT OR Apache-2.0" })[0]).toMatch(
      /single SPDX license identifier/,
    );
    expect(bad({ source: "not a url" })[0]).toMatch(
      /"source" must be an https URL/,
    );
    expect(bad({ path: "../escape.ts" })[0]).toMatch(
      /normalized repo-relative POSIX path/,
    );
    expect(bad({ path: "third_party/x.js" })[0]).toMatch(
      /must not be under third_party/,
    );
    expect(bad({ path: "src/data.json" })[0]).toMatch(
      /extension the check does not cover/,
    );
    expect(bad({ path: "src/missing.ts" })[0]).toMatch(
      /not a tracked source file/,
    );
    expect(bad({ extra: true })[0]).toMatch(/unknown field "extra"/);
    expect(
      run(fixture({}, { version: 1, entries: ["src/copied.ts"] }))[0],
    ).toMatch(/entries\[0\]: malformed entry/);
  });
});
