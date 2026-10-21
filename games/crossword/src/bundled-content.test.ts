// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCrosswordImport } from "./content.js";

/**
 * The three bundled launch puzzles (Master Spec §9 C1, D54).
 *
 * These are the exact import documents attested by the author of record
 * (Matthew Lewis) in the authoring kit on 2026-10-21: editorial review,
 * correctness review, clean cold playtest and the written CC0-1.0
 * attestation are all recorded there. The identity digests below are the
 * kit validator's, so any drift between the bundled files and the
 * attested puzzles fails this test.
 */
const BUNDLED = [
  {
    file: "warm-up.json",
    title: "Warm Up",
    difficulty: "easy",
    identity: "012b04f75fc188d6553809581784c8bdd40200cf5c8f9a78a065c204d1f9a4ba",
  },
  {
    file: "game-night.json",
    title: "Game Night",
    difficulty: "easy",
    identity: "676d7d8434586b3aaece4723fc67e4c401eed8bb5ea5e42d1c003c26cc201d9b",
  },
  {
    file: "rural-route.json",
    title: "Rural Route",
    difficulty: "medium",
    identity: "56e971e524c52eed8b37b897353dee333744cb8700564d5c79367c191192d3a3",
  },
] as const;

describe("bundled launch puzzles (C1/D54)", () => {
  for (const puzzle of BUNDLED) {
    it(`${puzzle.title} parses through the import contract with its attested identity and rights`, () => {
      const raw = readFileSync(new URL(`../content/${puzzle.file}`, import.meta.url), "utf8");
      const result = parseCrosswordImport(JSON.parse(raw));
      if (!result.ok) throw new Error(`bundled puzzle rejected: ${JSON.stringify(result)}`);
      expect(result.identity).toBe(puzzle.identity);
      expect(result.content.title).toBe(puzzle.title);
      expect(result.content.difficulty).toBe(puzzle.difficulty);
      expect(result.content.author).toBe("Matthew Lewis");
      expect(result.content.rights.license).toBe("CC0-1.0");
      expect(result.content.rights.attribution).toBe("Matthew Lewis");
      expect(result.content.rights.permissionNote).toContain("attested");
    });
  }

  it("bundles exactly the three launch puzzles, each with a distinct identity", () => {
    expect(BUNDLED).toHaveLength(3);
    expect(new Set(BUNDLED.map((p) => p.identity)).size).toBe(3);
  });
});
