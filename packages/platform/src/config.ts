// SPDX-License-Identifier: Apache-2.0

/**
 * Validates and parses a positive integer interval in milliseconds (BL-005).
 * Throws a clear descriptive Error if the value is not a finite positive integer.
 * Avoids silent fallthrough on 0, NaN, negatives, non-integers, or non-numeric strings.
 */
export function parsePositiveIntegerInterval(
  value: unknown,
  name = "LIVE_RECONCILE_INTERVAL_MS",
  defaultValue?: number,
  min = 1,
  max = 86_400_000,
): number {
  if (value === undefined || value === null || value === "") {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`${name} is required.`);
  }

  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`${name} must be a valid positive integer (received ${JSON.stringify(value)}).`);
    }
    num = Number(trimmed);
  } else {
    throw new Error(`${name} must be a valid positive integer (received ${typeof value}).`);
  }

  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new Error(
      `${name} must be a positive integer between ${min} and ${max} ms (received ${num}).`,
    );
  }

  return num;
}
