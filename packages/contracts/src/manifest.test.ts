import { describe, it, expect } from "vitest";
import { validateGameManifest, SDK_IDENTIFIER } from "./manifest.js";

describe("validateGameManifest", () => {
  it("validates a compliant game manifest", () => {
    const manifest = {
      id: "test-counter",
      name: "Test Counter",
      version: "0.1.0",
      sdk: SDK_IDENTIFIER,
      platformRange: ">=0.1.0 <0.2.0",
      stateVersion: 1,
      resultVersion: 1,
      description: "Minimal SDK test game",
      modes: [
        {
          id: "solo",
          label: "Solo Practice",
          minPlayersToStart: 1,
          maxPlayers: 1,
          lateJoin: false,
          rejoin: false,
        },
        {
          id: "group",
          label: "Group Counter",
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
      settingsSchema: {
        type: "object",
        properties: { target: { type: "integer" } },
        required: ["target"],
        additionalProperties: false,
      },
      actionSchemas: {
        add: {
          type: "object",
          properties: { amount: { type: "integer", const: 1 } },
          required: ["amount"],
          additionalProperties: false,
        },
      },
      stateSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      viewSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      client: {
        entry: "./client.js",
        css: [],
      },
    };

    const result = validateGameManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("test-counter");
    }
  });

  it("rejects invalid SDK identifier", () => {
    const invalidManifest = {
      id: "test-counter",
      name: "Test Counter",
      version: "0.1.0",
      sdk: "unknown-sdk/1.0",
      modes: [],
    };

    const result = validateGameManifest(invalidManifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
