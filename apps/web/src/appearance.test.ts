// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const boot = readFileSync(
  new URL("../public/appearance.js", import.meta.url),
  "utf8",
);

function firstPaint(
  saved: string | null,
  systemDark: boolean,
  blocked = false,
) {
  const root = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: {
      toggle: (_name: string, enabled: boolean) => {
        dark = enabled;
      },
    },
  };
  let dark = false;
  runInNewContext(boot, {
    document: { documentElement: root },
    localStorage: {
      getItem: () => {
        if (blocked) throw new Error("Storage blocked");
        return saved;
      },
    },
    matchMedia: () => ({ matches: systemDark }),
  });
  return { theme: root.dataset.theme, scheme: root.style.colorScheme, dark };
}

describe("Appearance before first paint", () => {
  it("uses an explicit preference rather than the system theme", () => {
    expect(firstPaint("light", true)).toEqual({
      theme: "light",
      scheme: "light",
      dark: false,
    });
    expect(firstPaint("dark", false)).toEqual({
      theme: "dark",
      scheme: "dark",
      dark: true,
    });
  });
  it("ignores invalid saved values and safely falls back when storage is unavailable", () => {
    expect(firstPaint("unexpected", true).theme).toBe("dark");
    expect(firstPaint(null, false, true)).toEqual({
      theme: "light",
      scheme: "light",
      dark: false,
    });
    expect(firstPaint(null, true, true)).toEqual({
      theme: "dark",
      scheme: "dark",
      dark: true,
    });
  });
});
