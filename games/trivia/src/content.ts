// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { parseJsonSchemaValue, type Json } from "@next-round/contracts";
import {
  ResourceImportError,
  type ImportResourceResult,
} from "@next-round/game-sdk";
import { triviaBankSchema } from "./manifest.js";
import type { TriviaBank } from "./types.js";

/** Server-only import. Canonical field order pins every question and its rights. */
export function parseTriviaImport(input: Json): ImportResourceResult {
  try {
    parseJsonSchemaValue(triviaBankSchema, input);
  } catch {
    throw new ResourceImportError([
      "Use a next-round.trivia/1 CC0 bank with complete questions and 2–8 distinct choices.",
    ]);
  }
  const bank = input as TriviaBank;
  const ids = new Set<string>();
  for (const question of bank.questions) {
    if (
      ids.has(question.id) ||
      question.correctChoice >= question.choices.length
    ) {
      throw new ResourceImportError([
        "Question IDs must be unique and correct choices must name an available choice.",
      ]);
    }
    ids.add(question.id);
  }
  const canonical: TriviaBank = {
    format: bank.format,
    title: bank.title,
    attribution: bank.attribution,
    license: bank.license,
    questions: bank.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      choices: [...q.choices],
      correctChoice: q.correctChoice,
      explanation: q.explanation,
    })),
  };
  return {
    identity: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
    data: canonical,
    metadata: {
      title: bank.title,
      questionCount: bank.questions.length,
      rights: {
        license: bank.license,
        sourceUrl: null,
        attribution: bank.attribution,
        permissionNote: null,
      },
    },
    importerFacts: [],
  };
}
