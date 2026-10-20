// SPDX-License-Identifier: Apache-2.0
import type { Json } from "@next-round/contracts";
import type { CrosswordDifficulty, CrosswordDirection } from "./content.js";

/**
 * Master Spec §9 C2 — locked crossword settings.
 *
 * `null` means unlimited / no timer, never zero. The preset is fixed when the
 * match starts; any deviation from the preset values is a custom match.
 */
export type CrosswordPreset = "solo_casual" | "quick" | "custom";

export interface CrosswordSettingsV1 {
  preset: CrosswordPreset;
  wrongGuessesPerTurn: number | null;
  correctWordsPerTurn: number | null;
  turnSeconds: number | null;
}

export const CROSSWORD_QUICK_SETTINGS: CrosswordSettingsV1 = {
  preset: "quick",
  wrongGuessesPerTurn: 3,
  correctWordsPerTurn: 1,
  turnSeconds: null,
};

export const CROSSWORD_SOLO_CASUAL_SETTINGS: CrosswordSettingsV1 = {
  preset: "solo_casual",
  wrongGuessesPerTurn: null,
  correctWordsPerTurn: null,
  turnSeconds: null,
};

/** Per-word status tracked in the authoritative state. */
export interface CrosswordWordState {
  completed: boolean;
  explicitSolver: string | null;
  assisted: boolean;
  [key: string]: Json;
}

/** Whole-turn counters. A correct word does not reset the wrong count or timer. */
export interface CrosswordTurn {
  generation: number;
  wrong: number;
  correct: number;
  startedAt: string;
  dueAt: string | null;
  [key: string]: Json;
}

/** Private per-member feedback. Only the owner's copy ever reaches that member. */
export interface CrosswordPrivateFeedback {
  turnGeneration: number;
  lastWrongGuess: string | null;
  remainingWrong: number | null;
  [key: string]: Json;
}

/** Authoritative match-wide state (Master Spec §9 C2). */
export interface CrosswordStateV1 {
  /** Row-major accepted letters; blocked cells stay null. */
  board: Array<string | null>;
  words: Record<string, CrosswordWordState>;
  scores: Record<string, number>;
  rotation: string[];
  currentMemberId: string | null;
  turn: CrosswordTurn | null;
  soloAwaitingContinue: boolean;
  suspended: boolean;
  suspendedRemainingMs: number | null;
  timeoutRemovalEligible: string[];
  privateFeedback: Record<string, CrosswordPrivateFeedback>;
  /** Monotonic match-wide career exclusion reasons. Never cleared. */
  exclusionReasons: string[];
  [key: string]: Json;
}

export type CrosswordClueView = {
  id: string;
  number: number;
  direction: CrosswordDirection;
  row: number;
  col: number;
  length: number;
  cells: Array<{ row: number; col: number }>;
  text: string;
}

/**
 * Per-viewer authorized view. It never carries the solution, another
 * member's guesses or another member's remaining budget.
 */
export type CrosswordView = {
  phase: "lobby" | "active" | "finished";
  mode: string;
  preset: CrosswordPreset;
  title: string | null;
  author: string | null;
  difficulty: CrosswordDifficulty | null;
  attribution: string | null;
  license: string | null;
  rows: number | null;
  cols: number | null;
  /** Row-major clue numbers; null until the grid shape is published. */
  numbers: Array<number | null> | null;
  /** Row-major blocked mask; null until the grid shape is published. */
  blocked: boolean[] | null;
  /** Published clues; null until the match starts. */
  clues: CrosswordClueView[] | null;
  /** Accepted shared letters; null until the match starts. */
  board: Array<string | null> | null;
  completedWordIds: string[];
  assistedWordIds: string[];
  scores: Record<string, number>;
  rotation: string[];
  currentMemberId: string | null;
  actingHostMemberId: string | null;
  /** The viewer's own member id; null for result-only readers. */
  myMemberId: string | null;
  myScore: number | null;
  privateFeedback: CrosswordPrivateFeedback | null;
  turnGeneration: number | null;
  turnDueAt: string | null;
  soloAwaitingContinue: boolean;
  suspended: boolean;
  suspendedRemainingMs: number | null;
  timeoutRemovalEligible: string[];
  exclusionReasons: string[];
  canReveal: boolean;
  canDeclareExposure: boolean;
  /** True when the viewer may submit a word right now. */
  canSubmitWord: boolean;
  /** True when the viewer may pass right now. */
  canPass: boolean;
}
