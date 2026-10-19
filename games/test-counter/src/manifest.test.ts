// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { validateGameManifest } from "@next-round/contracts";
import { manifest } from "./manifest.js";

describe("test-counter manifest", () => {
  it("defines valid solo and group player bounds", () => {
    expect(validateGameManifest(manifest, "0.1.0")).toEqual({
      ok: true,
      value: manifest,
    });
    expect(manifest.modes).toEqual([
      expect.objectContaining({ id: "solo", minPlayersToStart: 1, maxPlayers: 1 }),
      expect.objectContaining({ id: "group", minPlayersToStart: 2, maxPlayers: 8 }),
    ]);
  });
});
