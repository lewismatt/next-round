// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCrosswordImport } from "./content.js";

/**
 * The three bundled launch puzzles (Master Spec §9 C1, D54).
 *
 * The human review and CC0 attestation are reported in the authoring kit.
 * Grid identity covers only rows, so separate raw-file digests pin every byte
 * of the bundle independently reviewed at c3676e97, including clues and rights.
 * These file pins prevent subsequent drift; independent comparison with the
 * external kit originals remains outstanding and is not proved by these pins.
 */
const BUNDLED = [
  {
    file: "warm-up.json",
    title: "Warm Up",
    difficulty: "easy",
    identity: "012b04f75fc188d6553809581784c8bdd40200cf5c8f9a78a065c204d1f9a4ba",
    fileSha256: "8d4a737adf19a149fc22ec219fc5ffd6355948f977c306f7f63a468d6d03c7bd",
  },
  {
    file: "game-night.json",
    title: "Game Night",
    difficulty: "easy",
    identity: "676d7d8434586b3aaece4723fc67e4c401eed8bb5ea5e42d1c003c26cc201d9b",
    fileSha256: "0eb27a38b248734d4d6f972c314a1ae25b3593d09fe1cb5f50cb2f572ceb688e",
  },
  {
    file: "rural-route.json",
    title: "Rural Route",
    difficulty: "medium",
    identity: "56e971e524c52eed8b37b897353dee333744cb8700564d5c79367c191192d3a3",
    fileSha256: "fdadbec2cef51469857b1e1bd3c3f621ab010736623dfda5efb7ffc3787b790e",
  },
] as const;

describe("bundled launch puzzles (C1/D54)", () => {
  for (const puzzle of BUNDLED) {
    it(`${puzzle.title} preserves its reviewed file bytes, grid identity and rights`, () => {
      const raw = readFileSync(new URL(`../content/${puzzle.file}`, import.meta.url));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(puzzle.fileSha256);
      const result = parseCrosswordImport(JSON.parse(raw.toString("utf8")));
      if (!result.ok) throw new Error(`bundled puzzle rejected: ${JSON.stringify(result)}`);
      expect(result.identity).toBe(puzzle.identity);
      expect(result.content.title).toBe(puzzle.title);
      expect(result.content.difficulty).toBe(puzzle.difficulty);
      expect(result.content.author).toBe("Matthew Lewis");
      expect(result.content.rights).toEqual({
        license: "CC0-1.0",
        sourceUrl: null,
        attribution: "Matthew Lewis",
        permissionNote: "Original work by Matthew Lewis, released under CC0-1.0 (attested in the authoring kit).",
      });
    });
  }

  it("ships exactly the three launch import documents", () => {
    expect(readdirSync(new URL("../content/", import.meta.url)).sort()).toEqual(
      BUNDLED.map((puzzle) => puzzle.file).sort(),
    );
  });
});
