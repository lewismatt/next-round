// SPDX-License-Identifier: Apache-2.0
import type { Json } from "@next-round/contracts";

export type CipherPresetId = "cadet" | "standard" | "expert";

export interface CipherPreset {
  codeLength: number;
  alphabetSize: number;
  repeats: boolean;
  guessCap: number;
}

export const CIPHER_PRESETS: Record<CipherPresetId, CipherPreset> = {
  cadet: { codeLength: 4, alphabetSize: 6, repeats: false, guessCap: 12 },
  standard: { codeLength: 4, alphabetSize: 6, repeats: true, guessCap: 10 },
  expert: { codeLength: 5, alphabetSize: 8, repeats: true, guessCap: 12 },
};

export interface CipherSettings {
  preset: CipherPresetId;
  turnSeconds: number | null;
}

export interface GuessRecord {
  guess: number[];
  exact: number;
  misplaced: number;
  [key: string]: Json;
}

export interface CipherState {
  /** The secret code. Server state only; never projected into a client view
   * before the match finishes. */
  code: number[];
  boards: Record<string, GuessRecord[]>;
  playerOrder: string[];
  currentMemberId: string | null;
  generation: number;
  dueAt: string | null;
  suspended: boolean;
  suspendedRemainingMs: number | null;
  [key: string]: Json;
}

export interface CipherPlayerProgress {
  memberId: string;
  guessesUsed: number;
  done: boolean;
  cracked: boolean;
  [key: string]: Json;
}

export interface CipherReveal {
  code: number[];
  boards: Record<string, GuessRecord[]>;
  [key: string]: Json;
}

export interface CipherView {
  phase: "lobby" | "active" | "finished";
  preset: CipherPresetId;
  codeLength: number;
  alphabetSize: number;
  repeats: boolean;
  guessCap: number;
  myMemberId: string | null;
  myBoard: GuessRecord[];
  players: CipherPlayerProgress[];
  currentMemberId: string | null;
  canGuess: boolean;
  guessesRemaining: number | null;
  dueAt: string | null;
  suspended: boolean;
  reveal: CipherReveal | null;
  [key: string]: Json;
}
