// SPDX-License-Identifier: Apache-2.0
import {
  SDK_IDENTIFIER,
  type GameManifest,
  type Schema,
} from "@next-round/contracts";

const settingsSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    target: {
      type: "integer",
      minimum: 1,
      maximum: 20,
    },
    turnSeconds: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 60,
    },
  },
  required: ["target"],
  additionalProperties: false,
};

const addActionSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    amount: {
      type: "integer",
      const: 1,
    },
  },
  required: ["amount"],
  additionalProperties: false,
};

const noteActionSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    text: {
      type: "string",
      maxLength: 80,
    },
  },
  required: ["text"],
  additionalProperties: false,
};

const stateSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    target: { type: "integer", minimum: 1, maximum: 20 },
    turnSeconds: { type: ["integer", "null"] },
    scores: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
    notes: {
      type: "object",
      additionalProperties: { type: "string", maxLength: 80 },
    },
    markers: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    turnOrder: {
      type: "array",
      items: { type: "string" },
    },
    currentActorMemberId: { type: ["string", "null"] },
    deadlineGeneration: { type: "integer", minimum: 0 },
  },
  required: [
    "count",
    "target",
    "scores",
    "notes",
    "markers",
    "turnOrder",
    "deadlineGeneration",
  ],
  additionalProperties: false,
};

const viewSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    target: { type: "integer", minimum: 1, maximum: 20 },
    turnSeconds: { type: ["integer", "null"] },
    scores: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
    turnOrder: {
      type: "array",
      items: { type: "string" },
    },
    currentActorMemberId: { type: ["string", "null"] },
    myMarker: { type: ["string", "null"] },
    myNote: { type: ["string", "null"] },
    myScore: { type: ["integer", "null"], minimum: 0 },
  },
  required: [
    "count",
    "target",
    "scores",
    "turnOrder",
    "currentActorMemberId",
    "myMarker",
    "myNote",
    "myScore",
  ],
  additionalProperties: false,
};

const resultSchema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    target: { type: "integer", minimum: 1, maximum: 20 },
    winners: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["count", "target", "winners"],
  additionalProperties: false,
};

export const manifest: GameManifest = {
  id: "test-counter",
  name: "Test Counter",
  version: "0.1.0",
  sdk: SDK_IDENTIFIER,
  platformRange: ">=0.1.0 <1.0.0",
  stateVersion: 1,
  resultVersion: 1,
  description:
    "Minimal internal SDK test counter game for harness validation and integration checks.",
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
      lateJoin: true,
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
  settingsSchema,
  actionSchemas: {
    add: addActionSchema,
    note: noteActionSchema,
  },
  stateSchema,
  viewSchema,
  resultSchema,
  client: {
    entry: "./client.js",
    css: [],
  },
};
