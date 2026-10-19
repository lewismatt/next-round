// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateGameManifest, SDK_IDENTIFIER, type GameManifest } from "./manifest.js";

function manifest(): GameManifest {
  return {
    id: "test-counter", name: "Test Counter", version: "0.1.0",
    sdk: SDK_IDENTIFIER, platformRange: ">=0.1.0 <0.2.0",
    stateVersion: 1, resultVersion: 1, description: "Minimal SDK test game",
    modes: [{ id: "solo", label: "Solo", minPlayersToStart: 1, maxPlayers: 1, lateJoin: false, rejoin: false }],
    capabilities: { chat: true, deadlines: true, solo: true, resources: false, careerStats: true },
    settingsSchema: { type: "object", properties: { target: { type: "integer" } } },
    actionSchemas: { add: { type: "object" } },
    stateSchema: {}, viewSchema: {}, resultSchema: {},
    client: { entry: "./client.js", css: [] },
  };
}

describe("validateGameManifest", () => {
  it("accepts a complete manifest with nested JSON schemas", () => {
    const input = manifest();
    expect(validateGameManifest(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    ["mode identifier", (m: GameManifest) => { m.modes[0].id = "Invalid Mode"; }],
    ["mode label", (m: GameManifest) => { m.modes[0].label = ""; }],
    ["fractional players", (m: GameManifest) => { m.modes[0].maxPlayers = 1.5; }],
    ["player bounds", (m: GameManifest) => { m.modes[0].maxPlayers = 9; }],
    ["mode ordering", (m: GameManifest) => { m.modes[0].minPlayersToStart = 2; }],
    ["duplicate modes", (m: GameManifest) => { m.modes.push({ ...m.modes[0] }); }],
    ["SDK identifier", (m: GameManifest) => { Object.assign(m, { sdk: "unknown/1" }); }],
    ["unknown property", (m: GameManifest) => { Object.assign(m, { extra: true }); }],
    ["unknown nested property", (m: GameManifest) => { Object.assign(m.client, { extra: true }); }],
    ["schema array", (m: GameManifest) => { Object.assign(m, { stateSchema: [] }); }],
    ["invalid resource schemas", (m: GameManifest) => { Object.assign(m, { resourceSchemas: { import: {} } }); }],
    ["invalid action identifier", (m: GameManifest) => { m.actionSchemas = { "Bad Action": {} }; }],
    ["non-JSON schema value", (m: GameManifest) => { m.settingsSchema = { default: NaN }; }],
    ["build metadata", (m: GameManifest) => { m.version = "0.1.0+build"; }],
    ["noncanonical version", (m: GameManifest) => { m.version = "v0.1.0"; }],
    ["invalid range", (m: GameManifest) => { m.platformRange = "not a range"; }],
    ["blank name", (m: GameManifest) => { m.name = "   "; }],
  ])("rejects %s", (_label, change) => {
    const input = manifest();
    change(input);
    expect(validateGameManifest(input).ok).toBe(false);
  });

  it.each([null, [], "manifest", { id: "test-counter" }])("rejects incomplete or non-object input %j", (input) => {
    expect(validateGameManifest(input).ok).toBe(false);
  });

  it.each([
    [">=0.1.0 <0.2.0", "0.1.0", true],
    [">=0.1.0 <0.2.0", "0.2.0", false],
    ["^0.1.0 || ^1.0.0", "1.2.0", true],
    [">=0.1.0 <1.0.0", "0.2.0-beta.1", false],
    [">=0.2.0-beta.1 <0.2.0", "0.2.0-beta.2", true],
  ])("checks range %s against platform %s", (range, version, compatible) => {
    const input = manifest();
    input.platformRange = range;
    expect(validateGameManifest(input, version).ok).toBe(compatible);
  });
});
