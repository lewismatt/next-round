// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SDK_IDENTIFIER, type GameManifest } from "@next-round/contracts";
import { GameRegistry } from "./registry.js";

let clientRoot: string;

beforeEach(() => {
  clientRoot = mkdtempSync(path.join(tmpdir(), "next-round-registry-"));
  writeFileSync(path.join(clientRoot, "client.js"), "export const fixture = true;\n");
});

afterEach(() => {
  rmSync(clientRoot, { recursive: true, force: true });
});

function manifest(version = "0.1.0", platformRange = ">=0.1.0 <0.2.0"): GameManifest {
  return {
    id: "test-counter", name: "Test Counter", version, sdk: SDK_IDENTIFIER, platformRange,
    stateVersion: 1, resultVersion: 1, description: "Registry fixture",
    modes: [
      { id: "solo", label: "Solo", minPlayersToStart: 1, maxPlayers: 1, lateJoin: false, rejoin: false },
      { id: "group", label: "Group", minPlayersToStart: 2, maxPlayers: 8, lateJoin: true, rejoin: true },
    ],
    capabilities: { chat: false, deadlines: false, solo: true, resources: false, careerStats: false },
    settingsSchema: {}, actionSchemas: {}, stateSchema: {}, viewSchema: {}, resultSchema: {},
    client: { entry: "./client.js", css: [] },
  };
}

function register(registry: GameRegistry, input: unknown, options: { isDefault?: boolean; serverHash?: string; clientHash?: string } = {}) {
  return registry.register(input, undefined, { clientRoot, ...options });
}

describe("GameRegistry", () => {
  it("loads valid one-player and two-to-eight-player modes with their client asset", () => {
    const registry = new GameRegistry();
    const loaded = register(registry, manifest());
    expect(loaded.modes).toEqual([
      expect.objectContaining({ id: "solo", minPlayersToStart: 1, maxPlayers: 1 }),
      expect.objectContaining({ id: "group", minPlayersToStart: 2, maxPlayers: 8 }),
    ]);
    expect(registry.getClientAsset("test-counter", "0.1.0", "client.js")).toBe(
      path.join(clientRoot, "client.js"),
    );
  });

  it("rejects duplicate installation without replacing assets or changing the default", () => {
    const registry = new GameRegistry();
    const first = manifest();
    register(registry, first, { serverHash: "original-server", clientHash: "original-client" });
    const original = registry.getVersion(first.id, first.version);
    register(registry, manifest("0.1.1"), { isDefault: true });
    const replacement = { ...first, description: "Replacement" };
    expect(() => register(registry, replacement, { serverHash: "replacement", isDefault: true })).toThrow();
    expect(registry.getVersion(first.id, first.version)).toBe(original);
    expect(registry.getVersion(first.id)?.manifest.version).toBe("0.1.1");
    expect(registry.listVersions(first.id).map((item) => item.version)).toEqual(["0.1.0", "0.1.1"]);
    expect(() => register(registry, first)).toThrow();
  });

  it("rejects unsupported SDK and platform versions without creating a registry entry", () => {
    for (const incompatible of [
      { ...manifest(), sdk: "next-round-game/9.0" },
      manifest("0.1.0", ">=1.0.0"),
    ]) {
      const registry = new GameRegistry();
      expect(() => register(registry, incompatible)).toThrow();
      expect(registry.has("test-counter")).toBe(false);
      expect(registry.list()).toEqual([]);
    }
  });

  it("leaves existing versions and default intact when a new version is incompatible", () => {
    const registry = new GameRegistry();
    register(registry, manifest());
    expect(() => register(registry, manifest("0.2.0", "<0.1.0"), { isDefault: true })).toThrow();
    expect(registry.getVersion("test-counter")?.manifest.version).toBe("0.1.0");
    expect(registry.has("test-counter", "0.2.0")).toBe(false);
  });

  it("rejects a missing client asset before making the module available", () => {
    const registry = new GameRegistry();
    const input = manifest();
    input.client.entry = "./missing.js";
    expect(() => register(registry, input)).toThrow("does not exist");
    expect(registry.has(input.id, input.version)).toBe(false);
    expect(registry.getClientAsset(input.id, input.version, "missing.js")).toBeUndefined();
  });
});
