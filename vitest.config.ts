// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "games/*/src/**/*.test.ts"] },
});
