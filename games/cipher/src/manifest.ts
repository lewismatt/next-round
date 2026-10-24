// SPDX-License-Identifier: Apache-2.0
import {
  SDK_IDENTIFIER,
  type GameManifest,
  type Schema,
} from "@next-round/contracts";

function object(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const text = (maxLength: number): Schema => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const ids: Schema = {
  type: "array",
  items: { type: "string" },
  uniqueItems: true,
  maxItems: 8,
};
const codeArray: Schema = {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 7 },
  minItems: 4,
  maxItems: 5,
};
const guessRecord = object({
  guess: codeArray,
  exact: { type: "integer", minimum: 0, maximum: 5 },
  misplaced: { type: "integer", minimum: 0, maximum: 5 },
});
const boards: Schema = {
  type: "object",
  additionalProperties: {
    type: "array",
    items: guessRecord,
    maxItems: 12,
  },
};
const nullableTime: Schema = { type: ["string", "null"] };
const preset: Schema = { enum: ["cadet", "standard", "expert"] };
const progress = object({
  memberId: text(80),
  guessesUsed: { type: "integer", minimum: 0, maximum: 12 },
  done: { type: "boolean" },
  cracked: { type: "boolean" },
});

export const manifest: GameManifest = {
  id: "cipher",
  name: "Cipher",
  version: "0.1.0",
  sdk: SDK_IDENTIFIER,
  platformRange: ">=0.1.0 <1.0.0",
  stateVersion: 1,
  resultVersion: 1,
  description:
    "A deduction race: one secret code, private guesses, first to crack it wins.",
  modes: [
    {
      id: "solo",
      label: "Solo",
      minPlayersToStart: 1,
      maxPlayers: 1,
      lateJoin: false,
      rejoin: true,
    },
    {
      id: "group",
      label: "Group",
      minPlayersToStart: 2,
      maxPlayers: 8,
      lateJoin: false,
      rejoin: true,
    },
  ],
  capabilities: {
    chat: true,
    deadlines: true,
    solo: true,
    resources: false,
    careerStats: true,
  },
  settingsSchema: object({
    preset,
    turnSeconds: {
      type: ["integer", "null"],
      minimum: 30,
      maximum: 604800,
    },
  }),
  actionSchemas: {
    guess: object({ guess: codeArray }),
  },
  stateSchema: object({
    code: codeArray,
    boards,
    playerOrder: ids,
    currentMemberId: { type: ["string", "null"] },
    generation: { type: "integer", minimum: 0 },
    dueAt: nullableTime,
    suspended: { type: "boolean" },
    suspendedRemainingMs: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 604800000,
    },
  }),
  viewSchema: object({
    phase: { enum: ["lobby", "active", "finished"] },
    preset,
    codeLength: { type: "integer", minimum: 4, maximum: 5 },
    alphabetSize: { type: "integer", minimum: 6, maximum: 8 },
    repeats: { type: "boolean" },
    guessCap: { type: "integer", minimum: 10, maximum: 12 },
    myMemberId: { type: ["string", "null"] },
    myBoard: { type: "array", items: guessRecord, maxItems: 12 },
    players: { type: "array", items: progress, maxItems: 8 },
    currentMemberId: { type: ["string", "null"] },
    canGuess: { type: "boolean" },
    guessesRemaining: { type: ["integer", "null"], minimum: 0, maximum: 12 },
    dueAt: nullableTime,
    suspended: { type: "boolean" },
    reveal: {
      anyOf: [object({ code: codeArray, boards }), { type: "null" }],
    },
  }),
  resultSchema: object({
    preset,
    winners: ids,
    draw: { type: "boolean" },
    code: codeArray,
    guessesUsed: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0, maximum: 12 },
    },
  }),
  client: { entry: "./client.js", css: [] },
};
