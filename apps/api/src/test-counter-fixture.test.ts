// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GameRegistry } from "@next-round/platform";
import { loadTestCounterFixtureIfEnabled } from "./test-counter-fixture.js";

describe("internal Test Counter fixture loader", () => {
  it("registers its pinned server hooks and declared browser bundle", async () => {
    const clientRoot = await mkdtemp(path.join(tmpdir(), "next-round-counter-bundle-"));
    try {
      await writeFile(path.join(clientRoot, "client.js"), "export const fixture = true;\n");
      const registry = new GameRegistry();
      loadTestCounterFixtureIfEnabled(registry, false, clientRoot);
      expect(registry.has("test-counter")).toBe(false);
      loadTestCounterFixtureIfEnabled(registry, true, clientRoot);
      loadTestCounterFixtureIfEnabled(registry, true, clientRoot);

      expect(registry.getVersion("test-counter", "0.1.0")?.server).toBeDefined();
      expect(registry.getClientAsset("test-counter", "0.1.0", "client.js")).toBe(
        path.join(clientRoot, "client.js"),
      );
    } finally {
      await rm(clientRoot, { recursive: true, force: true });
    }
  });
});
