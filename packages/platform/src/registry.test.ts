// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SDK_IDENTIFIER, type GameManifest } from "@next-round/contracts";
import { GameRegistry } from "./registry.js";

function manifest(version = "0.1.0", platformRange = ">=0.1.0 <0.2.0"): GameManifest {
  return {
    id: "test-counter", name: "Test Counter", version, sdk: SDK_IDENTIFIER, platformRange,
    stateVersion: 1, resultVersion: 1, description: "Registry fixture",
    modes: [{ id: "solo", label: "Solo", minPlayersToStart: 1, maxPlayers: 1, lateJoin: false, rejoin: false }],
    capabilities: { chat: false, deadlines: false, solo: true, resources: false, careerStats: false },
    settingsSchema: {}, actionSchemas: {}, stateSchema: {}, viewSchema: {}, resultSchema: {},
    client: { entry: "./client.js", css: [] },
  };
}

describe("GameRegistry", () => {
  it("rejects duplicate installation without replacing assets or changing the default", () => {
    const registry = new GameRegistry();
    const first = manifest();
    registry.register(first, undefined, { serverHash: "original-server", clientHash: "original-client" });
    const original = registry.getVersion(first.id, first.version);
    registry.register(manifest("0.1.1"), undefined, { isDefault: true });
    const replacement = { ...first, description: "Replacement" };
    expect(() => registry.register(replacement, undefined, { serverHash: "replacement", isDefault: true })).toThrow();
    expect(registry.getVersion(first.id, first.version)).toBe(original);
    expect(registry.getVersion(first.id, first.version)).toEqual({ manifest: first, server: undefined, serverHash: "original-server", clientHash: "original-client" });
    expect(registry.getVersion(first.id)?.manifest.version).toBe("0.1.1");
    expect(registry.listVersions(first.id).map(m => m.version)).toEqual(["0.1.0", "0.1.1"]);
    expect(() => registry.register(first)).toThrow();
  });

  it("rejects an incompatible module without creating a registry entry", () => {
    const registry = new GameRegistry();
    expect(() => registry.register(manifest("0.1.0", ">=1.0.0"))).toThrow();
    expect(registry.has("test-counter")).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("leaves existing versions and default intact when a new version is incompatible", () => {
    const registry = new GameRegistry();
    registry.register(manifest());
    expect(() => registry.register(manifest("0.2.0", "<0.1.0"), undefined, { isDefault: true })).toThrow();
    expect(registry.getVersion("test-counter")?.manifest.version).toBe("0.1.0");
    expect(registry.has("test-counter", "0.2.0")).toBe(false);
  });
});
