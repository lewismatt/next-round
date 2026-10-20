// SPDX-License-Identifier: Apache-2.0
import {
  SDK_IDENTIFIER,
  type GameManifest,
  type Schema,
} from "@next-round/contracts";

/**
 * Master Spec §9 C1-C5 — crossword module manifest.
 *
 * The manifest declares the locked settings contract, the action payloads,
 * the authorized view and the resource schemas (import, catalog metadata,
 * server-private data and principal facts).
 */

const settingsSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    preset: { enum: ["solo_casual", "quick", "custom"] },
    wrongGuessesPerTurn: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 100,
    },
    correctWordsPerTurn: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 100,
    },
    turnSeconds: {
      type: ["integer", "null"],
      minimum: 10,
      maximum: 86400,
    },
  },
  required: [
    "preset",
    "wrongGuessesPerTurn",
    "correctWordsPerTurn",
    "turnSeconds",
  ],
  additionalProperties: false,
};

const submitWordActionSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    wordId: { type: "string", minLength: 1, maxLength: 8 },
    answer: { type: "string", minLength: 1, maxLength: 64 },
  },
  required: ["wordId", "answer"],
  additionalProperties: false,
};

const passActionSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const revealLetterActionSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    row: { type: "integer", minimum: 0, maximum: 24 },
    col: { type: "integer", minimum: 0, maximum: 24 },
  },
  required: ["row", "col"],
  additionalProperties: false,
};

const revealWordActionSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    wordId: { type: "string", minLength: 1, maxLength: 8 },
  },
  required: ["wordId"],
  additionalProperties: false,
};

const stateSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    board: {
      type: "array",
      maxItems: 625,
      items: { type: ["string", "null"], maxLength: 1 },
    },
    words: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          completed: { type: "boolean" },
          explicitSolver: { type: ["string", "null"] },
          assisted: { type: "boolean" },
        },
        required: ["completed", "explicitSolver", "assisted"],
        additionalProperties: false,
      },
    },
    scores: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
    rotation: { type: "array", items: { type: "string" } },
    currentMemberId: { type: ["string", "null"] },
    turn: {
      type: ["object", "null"],
      properties: {
        generation: { type: "integer", minimum: 0 },
        wrong: { type: "integer", minimum: 0 },
        correct: { type: "integer", minimum: 0 },
        startedAt: { type: "string" },
        dueAt: { type: ["string", "null"] },
      },
      required: ["generation", "wrong", "correct", "startedAt", "dueAt"],
      additionalProperties: false,
    },
    soloAwaitingContinue: { type: "boolean" },
    suspended: { type: "boolean" },
    suspendedRemainingMs: { type: ["integer", "null"], minimum: 0 },
    timeoutRemovalEligible: { type: "array", items: { type: "string" } },
    privateFeedback: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          turnGeneration: { type: "integer", minimum: 0 },
          lastWrongGuess: { type: ["string", "null"] },
          remainingWrong: { type: ["integer", "null"], minimum: 0 },
        },
        required: ["turnGeneration", "lastWrongGuess", "remainingWrong"],
        additionalProperties: false,
      },
    },
    exclusionReasons: { type: "array", items: { type: "string" } },
  },
  required: [
    "board",
    "words",
    "scores",
    "rotation",
    "currentMemberId",
    "turn",
    "soloAwaitingContinue",
    "suspended",
    "suspendedRemainingMs",
    "timeoutRemovalEligible",
    "privateFeedback",
    "exclusionReasons",
  ],
  additionalProperties: false,
};

const clueViewSchema: Schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    number: { type: "integer", minimum: 1 },
    direction: { enum: ["across", "down"] },
    row: { type: "integer", minimum: 0 },
    col: { type: "integer", minimum: 0 },
    length: { type: "integer", minimum: 2 },
    cells: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row: { type: "integer", minimum: 0 },
          col: { type: "integer", minimum: 0 },
        },
        required: ["row", "col"],
        additionalProperties: false,
      },
    },
    text: { type: "string", maxLength: 500 },
  },
  required: ["id", "number", "direction", "row", "col", "length", "cells", "text"],
  additionalProperties: false,
};

const viewSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    phase: { enum: ["lobby", "active", "finished"] },
    mode: { type: "string" },
    preset: { enum: ["solo_casual", "quick", "custom"] },
    title: { type: ["string", "null"] },
    author: { type: ["string", "null"] },
    difficulty: { type: ["string", "null"] },
    attribution: { type: ["string", "null"] },
    license: { type: ["string", "null"] },
    rows: { type: ["integer", "null"], minimum: 3, maximum: 25 },
    cols: { type: ["integer", "null"], minimum: 3, maximum: 25 },
    numbers: {
      type: ["array", "null"],
      maxItems: 625,
      items: { type: ["integer", "null"], minimum: 1 },
    },
    blocked: {
      type: ["array", "null"],
      maxItems: 625,
      items: { type: "boolean" },
    },
    clues: { type: ["array", "null"], items: clueViewSchema },
    board: {
      type: ["array", "null"],
      maxItems: 625,
      items: { type: ["string", "null"], maxLength: 1 },
    },
    completedWordIds: { type: "array", items: { type: "string" } },
    assistedWordIds: { type: "array", items: { type: "string" } },
    scores: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
    rotation: { type: "array", items: { type: "string" } },
    currentMemberId: { type: ["string", "null"] },
    actingHostMemberId: { type: ["string", "null"] },
    myMemberId: { type: ["string", "null"] },
    myScore: { type: ["integer", "null"], minimum: 0 },
    privateFeedback: {
      type: ["object", "null"],
      properties: {
        turnGeneration: { type: "integer", minimum: 0 },
        lastWrongGuess: { type: ["string", "null"] },
        remainingWrong: { type: ["integer", "null"], minimum: 0 },
      },
      required: ["turnGeneration", "lastWrongGuess", "remainingWrong"],
      additionalProperties: false,
    },
    turnGeneration: { type: ["integer", "null"], minimum: 0 },
    turnDueAt: { type: ["string", "null"] },
    soloAwaitingContinue: { type: "boolean" },
    suspended: { type: "boolean" },
    suspendedRemainingMs: { type: ["integer", "null"], minimum: 0 },
    timeoutRemovalEligible: { type: "array", items: { type: "string" } },
    exclusionReasons: { type: "array", items: { type: "string" } },
    canReveal: { type: "boolean" },
    canDeclareExposure: { type: "boolean" },
    canSubmitWord: { type: "boolean" },
    canPass: { type: "boolean" },
  },
  required: [
    "phase",
    "mode",
    "preset",
    "title",
    "author",
    "difficulty",
    "attribution",
    "license",
    "rows",
    "cols",
    "numbers",
    "blocked",
    "clues",
    "board",
    "completedWordIds",
    "assistedWordIds",
    "scores",
    "rotation",
    "currentMemberId",
    "actingHostMemberId",
    "myMemberId",
    "myScore",
    "privateFeedback",
    "turnGeneration",
    "turnDueAt",
    "soloAwaitingContinue",
    "suspended",
    "suspendedRemainingMs",
    "timeoutRemovalEligible",
    "exclusionReasons",
    "canReveal",
    "canDeclareExposure",
    "canSubmitWord",
    "canPass",
  ],
  additionalProperties: false,
};

const rightsSchema: Schema = {
  type: "object",
  properties: {
    license: { type: "string", minLength: 1, maxLength: 64 },
    sourceUrl: { type: ["string", "null"], maxLength: 2048 },
    attribution: { type: "string", minLength: 1, maxLength: 500 },
    permissionNote: { type: ["string", "null"], maxLength: 1000 },
  },
  required: ["license", "sourceUrl", "attribution", "permissionNote"],
  additionalProperties: false,
};

const resultSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    mode: { type: "string" },
    preset: { enum: ["solo_casual", "quick", "custom"] },
    completedWords: { type: "integer", minimum: 0 },
    totalWords: { type: "integer", minimum: 0 },
    winners: { type: "array", items: { type: "string" } },
    attribution: {
      type: "object",
      properties: {
        title: { type: "string" },
        author: { type: "string" },
        difficulty: { type: "string" },
        rows: { type: "integer" },
        cols: { type: "integer" },
        rights: rightsSchema,
      },
      required: ["title", "author", "difficulty", "rows", "cols", "rights"],
      additionalProperties: false,
    },
  },
  required: [
    "mode",
    "preset",
    "completedWords",
    "totalWords",
    "winners",
    "attribution",
  ],
  additionalProperties: false,
};

const importSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    format: { const: "next-round.crossword/1" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    author: { type: "string", minLength: 1, maxLength: 120 },
    language: { const: "en" },
    difficulty: { enum: ["easy", "medium", "hard", "unspecified"] },
    rights: rightsSchema,
    rows: {
      type: "array",
      minItems: 3,
      maxItems: 25,
      items: { type: "string", minLength: 3, maxLength: 25 },
    },
    clues: {
      type: "array",
      maxItems: 625,
      items: {
        type: "object",
        properties: {
          direction: { enum: ["across", "down"] },
          row: { type: "integer", minimum: 0, maximum: 24 },
          col: { type: "integer", minimum: 0, maximum: 24 },
          text: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["direction", "row", "col", "text"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "format",
    "title",
    "author",
    "language",
    "difficulty",
    "rights",
    "rows",
    "clues",
  ],
  additionalProperties: false,
};

const metadataSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    author: { type: "string", minLength: 1, maxLength: 120 },
    difficulty: { enum: ["easy", "medium", "hard", "unspecified"] },
    rows: { type: "integer", minimum: 3, maximum: 25 },
    cols: { type: "integer", minimum: 3, maximum: 25 },
    rights: rightsSchema,
  },
  required: ["title", "author", "difficulty", "rows", "cols", "rights"],
  additionalProperties: false,
};

const dataSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    format: { const: "next-round.crossword/1" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    author: { type: "string", minLength: 1, maxLength: 120 },
    language: { const: "en" },
    difficulty: { enum: ["easy", "medium", "hard", "unspecified"] },
    rights: rightsSchema,
    rows: {
      type: "array",
      minItems: 3,
      maxItems: 25,
      items: { type: "string", minLength: 3, maxLength: 25 },
    },
    numbers: {
      type: "array",
      maxItems: 625,
      items: { type: ["integer", "null"], minimum: 1 },
    },
    entries: {
      type: "array",
      maxItems: 625,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          number: { type: "integer", minimum: 1 },
          direction: { enum: ["across", "down"] },
          row: { type: "integer", minimum: 0 },
          col: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 2 },
          cells: {
            type: "array",
            items: {
              type: "object",
              properties: {
                row: { type: "integer", minimum: 0 },
                col: { type: "integer", minimum: 0 },
              },
              required: ["row", "col"],
              additionalProperties: false,
            },
          },
          answer: { type: "string", minLength: 2, maxLength: 25 },
          clue: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: [
          "id",
          "number",
          "direction",
          "row",
          "col",
          "length",
          "cells",
          "answer",
          "clue",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "format",
    "title",
    "author",
    "language",
    "difficulty",
    "rights",
    "rows",
    "numbers",
    "entries",
  ],
  additionalProperties: false,
};

const factsSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    "crossword/seen": {
      type: "object",
      properties: {
        matchId: { type: "string" },
        seenAt: { type: "string" },
      },
      required: ["matchId", "seenAt"],
      additionalProperties: false,
    },
    "crossword/imported": {
      type: "object",
      properties: {
        importedAt: { type: "string" },
        resourceIdentity: { type: "string" },
      },
      required: ["importedAt", "resourceIdentity"],
      additionalProperties: false,
    },
    "crossword/declared": {
      type: "object",
      properties: {
        matchId: { type: "string" },
        declaredAt: { type: "string" },
      },
      required: ["matchId", "declaredAt"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const manifest: GameManifest = {
  id: "crossword",
  name: "Crossword",
  version: "0.1.0",
  sdk: SDK_IDENTIFIER,
  platformRange: ">=0.1.0 <1.0.0",
  stateVersion: 1,
  resultVersion: 1,
  description:
    "Collaborative and solo crossword with turn-based solving, exposure tracking and career scoring.",
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
      id: "quick",
      label: "Quick",
      minPlayersToStart: 2,
      maxPlayers: 8,
      lateJoin: true,
      rejoin: true,
    },
    {
      id: "custom",
      label: "Custom",
      minPlayersToStart: 2,
      maxPlayers: 8,
      lateJoin: true,
      rejoin: true,
    },
  ],
  capabilities: {
    chat: true,
    deadlines: true,
    solo: true,
    resources: true,
    careerStats: true,
  },
  settingsSchema,
  resourceSchemas: {
    import: importSchema,
    metadata: metadataSchema,
    data: dataSchema,
    facts: factsSchema,
  },
  actionSchemas: {
    submit_word: submitWordActionSchema,
    pass: passActionSchema,
    continue: passActionSchema,
    reveal_letter: revealLetterActionSchema,
    reveal_word: revealWordActionSchema,
    reveal_puzzle: passActionSchema,
    declare_exposure: passActionSchema,
  },
  stateSchema,
  viewSchema,
  resultSchema,
  client: {
    entry: "./client.js",
    css: [],
  },
};
