// SPDX-License-Identifier: Apache-2.0
import type { Json } from "@next-round/contracts";

/**
 * Crossword setup helpers (Master Spec §9 C2).
 *
 * Pure functions shared by the create-match dialog and its tests. The
 * settings contract is pinned by the module: quick is exactly
 * {preset:quick, wrongGuessesPerTurn:3, correctWordsPerTurn:1,
 * turnSeconds:null}, solo casual is all null, and any adjustment is a
 * custom preset — a custom object that happens to equal the quick values
 * stays custom, and therefore career-ineligible, because the preset is
 * part of the object the server pins at creation.
 */

export interface CrosswordSettings {
  preset: "solo_casual" | "quick" | "custom";
  wrongGuessesPerTurn: number | null;
  correctWordsPerTurn: number | null;
  turnSeconds: number | null;
}

/** Raw custom-limit inputs; an empty string means unlimited (null). */
export interface CrosswordCustomInput {
  wrongGuessesPerTurn: string;
  correctWordsPerTurn: string;
  turnSeconds: string;
}

export const EMPTY_CUSTOM_INPUT: CrosswordCustomInput = {
  wrongGuessesPerTurn: "",
  correctWordsPerTurn: "",
  turnSeconds: "",
};

export type SettingsResult =
  | { ok: true; settings: CrosswordSettings }
  | { ok: false; error: string };

function parseLimit(
  raw: string,
  label: string,
  min: number,
  max: number,
): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) {
    return {
      error: `${label} must be a whole number from ${min} to ${max}, or left empty for no limit.`,
    };
  }
  return { value };
}

/**
 * Builds the exact settings object for one crossword mode. The mode ids
 * are the module's manifest modes: solo, quick and custom.
 */
export function buildCrosswordSettings(
  mode: string,
  custom: CrosswordCustomInput,
): SettingsResult {
  if (mode === "solo") {
    return {
      ok: true,
      settings: {
        preset: "solo_casual",
        wrongGuessesPerTurn: null,
        correctWordsPerTurn: null,
        turnSeconds: null,
      },
    };
  }
  if (mode === "quick") {
    return {
      ok: true,
      settings: {
        preset: "quick",
        wrongGuessesPerTurn: 3,
        correctWordsPerTurn: 1,
        turnSeconds: null,
      },
    };
  }
  if (mode === "custom") {
    const wrong = parseLimit(
      custom.wrongGuessesPerTurn,
      "Wrong guesses per turn",
      1,
      100,
    );
    if ("error" in wrong) return { ok: false, error: wrong.error };
    const correct = parseLimit(
      custom.correctWordsPerTurn,
      "Correct words per turn",
      1,
      100,
    );
    if ("error" in correct) return { ok: false, error: correct.error };
    const seconds = parseLimit(custom.turnSeconds, "Turn timer (seconds)", 10, 86_400);
    if ("error" in seconds) return { ok: false, error: seconds.error };
    return {
      ok: true,
      settings: {
        preset: "custom",
        wrongGuessesPerTurn: wrong.value,
        correctWordsPerTurn: correct.value,
        turnSeconds: seconds.value,
      },
    };
  }
  return { ok: false, error: `Unknown crossword mode '${mode}'.` };
}

/** The settings object as the JSON body the create-match API expects. */
export function settingsToJson(settings: CrosswordSettings): Json {
  return { ...settings };
}

export interface CrosswordCatalogMetadata {
  title: string;
  author: string;
  language: string;
  difficulty: string;
  rows: number;
  cols: number;
  rights: {
    license: string;
    sourceUrl: string | null;
    attribution: string;
    permissionNote: string | null;
  };
}

export interface TriviaCatalogMetadata {
  title: string;
  questionCount: number;
  rights: CrosswordCatalogMetadata["rights"];
}

/** Public content summary; never reads private resource data. */
export function catalogSummary(metadata: CrosswordCatalogMetadata | TriviaCatalogMetadata): string {
  if ("questionCount" in metadata) {
    return `${metadata.questionCount} questions · ${metadata.rights.license}`;
  }
  return `${metadata.rows} × ${metadata.cols} · ${metadata.difficulty} · by ${metadata.author} · ${metadata.rights.license}`;
}
