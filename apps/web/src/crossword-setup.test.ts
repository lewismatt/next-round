// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildCrosswordSettings,
  EMPTY_CUSTOM_INPUT,
} from "./crossword-setup.js";

describe("crossword setup settings (Master Spec §9 C2)", () => {
  it("pins solo to the all-unlimited casual preset", () => {
    const result = buildCrosswordSettings("solo", EMPTY_CUSTOM_INPUT);
    expect(result).toEqual({
      ok: true,
      settings: {
        preset: "solo_casual",
        wrongGuessesPerTurn: null,
        correctWordsPerTurn: null,
        turnSeconds: null,
      },
    });
  });

  it("pins quick to exactly {3, 1, null}", () => {
    const result = buildCrosswordSettings("quick", EMPTY_CUSTOM_INPUT);
    expect(result).toEqual({
      ok: true,
      settings: {
        preset: "quick",
        wrongGuessesPerTurn: 3,
        correctWordsPerTurn: 1,
        turnSeconds: null,
      },
    });
  });

  it("keeps a custom object equal to the quick values custom (career-ineligible)", () => {
    const result = buildCrosswordSettings("custom", {
      wrongGuessesPerTurn: "3",
      correctWordsPerTurn: "1",
      turnSeconds: "",
    });
    expect(result).toEqual({
      ok: true,
      settings: {
        preset: "custom",
        wrongGuessesPerTurn: 3,
        correctWordsPerTurn: 1,
        turnSeconds: null,
      },
    });
  });

  it("treats empty custom fields as unlimited and parses bounded values", () => {
    const result = buildCrosswordSettings("custom", {
      wrongGuessesPerTurn: "",
      correctWordsPerTurn: "5",
      turnSeconds: "600",
    });
    expect(result).toEqual({
      ok: true,
      settings: {
        preset: "custom",
        wrongGuessesPerTurn: null,
        correctWordsPerTurn: 5,
        turnSeconds: 600,
      },
    });
  });

  it("rejects out-of-range and non-integer custom values", () => {
    for (const custom of [
      { wrongGuessesPerTurn: "0", correctWordsPerTurn: "", turnSeconds: "" },
      { wrongGuessesPerTurn: "101", correctWordsPerTurn: "", turnSeconds: "" },
      { wrongGuessesPerTurn: "", correctWordsPerTurn: "2.5", turnSeconds: "" },
      { wrongGuessesPerTurn: "", correctWordsPerTurn: "", turnSeconds: "9" },
      { wrongGuessesPerTurn: "", correctWordsPerTurn: "", turnSeconds: "86401" },
      { wrongGuessesPerTurn: "abc", correctWordsPerTurn: "", turnSeconds: "" },
    ]) {
      const result = buildCrosswordSettings("custom", custom);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unknown modes", () => {
    expect(buildCrosswordSettings("group", EMPTY_CUSTOM_INPUT).ok).toBe(false);
  });
});

