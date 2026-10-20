// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { validateGameManifest } from "@next-round/contracts";
import { manifest } from "./manifest.js";

describe("crossword manifest", () => {
  it("validates against the approved SDK contract", () => {
    expect(validateGameManifest(manifest, "0.1.0")).toEqual({
      ok: true,
      value: manifest,
    });
  });

  it("declares the approved modes and player bounds", () => {
    expect(manifest.modes).toEqual([
      expect.objectContaining({ id: "solo", minPlayersToStart: 1, maxPlayers: 1 }),
      expect.objectContaining({ id: "quick", minPlayersToStart: 2, maxPlayers: 8 }),
      expect.objectContaining({ id: "custom", minPlayersToStart: 2, maxPlayers: 8 }),
    ]);
    expect(manifest.capabilities.resources).toBe(true);
  });

  it("declares every approved action payload", () => {
    expect(Object.keys(manifest.actionSchemas).sort()).toEqual([
      "continue",
      "declare_exposure",
      "pass",
      "reveal_letter",
      "reveal_puzzle",
      "reveal_word",
      "submit_word",
    ]);
    for (const schema of Object.values(manifest.actionSchemas)) {
      expect((schema as Record<string, unknown>).additionalProperties).toBe(
        false,
      );
    }
  });
});
