// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parsePositiveIntegerInterval } from "./config.js";

describe("live reconciliation interval boundaries (BL-005)", () => {
  it.each([1, 10000, 86_400_000])("accepts representable interval %i as number or environment string", value => {
    expect(parsePositiveIntegerInterval(value)).toBe(value);
    expect(parsePositiveIntegerInterval(String(value))).toBe(value);
  });

  it("uses the configured default only for absent values", () => {
    for (const value of [undefined, null, ""]) {
      expect(parsePositiveIntegerInterval(value, "INTERVAL", 10000)).toBe(10000);
    }
    expect(() => parsePositiveIntegerInterval(undefined)).toThrow(Error);
  });

  it.each([0, "0", -1, "-100", 0.5, "1.5", NaN, Infinity, "NaN", "invalid", true, 86_400_001])(
    "rejects unsafe timer value %s rather than spinning or silently falling back",
    value => {
      expect(() => parsePositiveIntegerInterval(value, "INTERVAL", 10000)).toThrow(Error);
    },
  );
});
