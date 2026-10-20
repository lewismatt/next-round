// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "node:crypto";
import type { Json } from "@next-round/contracts";

/**
 * Canonical JSON encoding for request hashes: object keys sorted, no
 * whitespace between tokens, strings JSON-escaped.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

/**
 * Compares a stored request hash with the expected one in constant time.
 * Stored hashes may be raw bytes or their hex text.
 */
export function sameRequestHash(
  expected: Buffer,
  stored: Buffer | Uint8Array | string,
): boolean {
  const actual =
    typeof stored === "string"
      ? Buffer.from(stored.startsWith("\\x") ? stored.slice(2) : stored, "hex")
      : Buffer.isBuffer(stored)
        ? stored
        : Buffer.from(stored);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
