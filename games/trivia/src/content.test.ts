// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ResourceImportError } from "@next-round/game-sdk";
import { parseTriviaImport } from "./content.js";
import type { TriviaBank } from "./types.js";

const bank: TriviaBank = {
  format: "next-round.trivia/1",
  title: "Private bank",
  attribution: "Original test fixture",
  license: "CC0-1.0",
  questions: [
    {
      id: "one",
      prompt: "First?",
      choices: ["A", "B"],
      correctChoice: 1,
      explanation: "Private explanation",
    },
  ],
};

describe("trivia import identity and privacy", () => {
  it("pins every content/rights field independent of JSON property ordering", () => {
    const original = parseTriviaImport(bank);
    expect(
      parseTriviaImport({
        questions: bank.questions,
        license: bank.license,
        attribution: bank.attribution,
        title: bank.title,
        format: bank.format,
      }).identity,
    ).toBe(original.identity);
    for (const change of [
      { ...bank, title: "Different title" },
      { ...bank, attribution: "Other author" },
      ...["prompt", "explanation", "id"].map((field) => ({
        ...bank,
        questions: [{ ...bank.questions[0], [field]: "Changed" }],
      })),
      { ...bank, questions: [{ ...bank.questions[0], choices: ["B", "A"] }] },
      { ...bank, questions: [{ ...bank.questions[0], correctChoice: 0 }] },
    ])
      expect(parseTriviaImport(change).identity).not.toBe(original.identity);
    expect(original.metadata).toEqual({
      title: bank.title,
      questionCount: 1,
      rights: {
        license: "CC0-1.0",
        sourceUrl: null,
        attribution: bank.attribution,
        permissionNote: null,
      },
    });
  });

  it("rejects malformed banks and unknown fields without exposing submitted secrets", () => {
    for (const invalid of [
      null,
      { ...bank, questions: [null] },
      { ...bank, questions: [bank.questions[0], bank.questions[0]] },
      { ...bank, questions: [{ ...bank.questions[0], correctChoice: 2 }] },
      { ...bank, questions: [{ ...bank.questions[0], choices: ["A", "A"] }] },
      { ...bank, license: "unreviewed-secret" },
      { ...bank, hidden: "unreviewed-secret" },
    ]) {
      expect(() => parseTriviaImport(invalid)).toThrow(ResourceImportError);
      try {
        parseTriviaImport(invalid);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain("unreviewed-secret");
        expect(JSON.stringify(error)).not.toContain("Private explanation");
      }
    }
  });
});
