// SPDX-License-Identifier: Apache-2.0
import type { Json } from "@next-round/contracts";

export interface TriviaSettings {
  rounds: number;
  secondsPerRound: number;
}

export interface TriviaQuestion {
  id: string;
  prompt: string;
  choices: string[];
  correctChoice: number;
  explanation: string;
  [key: string]: Json;
}

export interface TriviaBank {
  format: "next-round.trivia/1";
  title: string;
  attribution: string;
  license: "CC0-1.0";
  questions: TriviaQuestion[];
  [key: string]: Json;
}

export interface TriviaReveal {
  roundIndex: number;
  questionId: string;
  prompt: string;
  choices: string[];
  correctChoice: number;
  explanation: string;
  answers: Record<string, number>;
  [key: string]: Json;
}

export interface TriviaState {
  roundIndex: number;
  answers: Record<string, number>;
  roundMemberIds: string[];
  scores: Record<string, number>;
  reveals: TriviaReveal[];
  generation: number;
  dueAt: string | null;
  suspended: boolean;
  suspendedRemainingMs: number | null;
  [key: string]: Json;
}

export interface TriviaView {
  phase: "lobby" | "active" | "finished";
  roundIndex: number;
  totalRounds: number;
  question: { id: string; prompt: string; choices: string[] } | null;
  myMemberId: string | null;
  myChoice: number | null;
  canSubmit: boolean;
  scores: Record<string, number>;
  reveals: TriviaReveal[];
  dueAt: string | null;
  suspended: boolean;
  attribution: string | null;
  [key: string]: Json;
}
