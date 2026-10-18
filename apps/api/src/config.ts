// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";

export type TrustedProxies = false | string | string[];

/** Trust only operator-selected IP addresses/CIDRs, never arbitrary callers. */
export function parseTrustedProxies(
  value: TrustedProxies | undefined = process.env.TRUST_PROXY
): false | string[] {
  if (value === undefined || value === false || value === "" || value === "false") {
    return false;
  }
  const entries = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("TRUST_PROXY must contain explicit proxy IP addresses or CIDRs");
  }
  return entries.map((entry) => {
    const proxy = entry.trim();
    const parts = proxy.split("/");
    const family = isIP(parts[0]);
    const prefix = parts[1];
    if (
      !family || parts.length > 2 ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) < 1 ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    ) {
      throw new Error("TRUST_PROXY must contain explicit proxy IP addresses or CIDRs");
    }
    return proxy;
  });
}

/** Validate before allocating a server or writing static directories. */
export function requireSessionSecret(value = process.env.SESSION_SECRET): string {
  if (!value || value.trim() !== value || value.length < 64) {
    throw new Error("SESSION_SECRET is required (at least 64 characters, generated locally)");
  }
  return value;
}

// The scaffold requires provisioning configuration at startup. F1 will allow
// removing this token once database-backed bootstrap is complete.
export function validateSetupToken(value = process.env.SETUP_TOKEN): void {
  if (!value || value.trim() !== value || value.length < 64) {
    throw new Error("SETUP_TOKEN is required (at least 64 characters, generated locally)");
  }
}
