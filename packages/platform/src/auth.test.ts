// SPDX-License-Identifier: Apache-2.0
import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword, initializeDummyPasswordHash, verifyDummyPassword,
  needsPasswordRehash } from "./auth.js";

describe("GH-1 M-1: real password work for unknown users", () => {
  it("shares initialization and verifies a valid PHC hash with the approved cost", async () => {
    const first = initializeDummyPasswordHash();
    expect(initializeDummyPasswordHash()).toBe(first);
    const hash = await first;
    expect(hash.startsWith("$argon2id$v=19$")).toBe(true);
    expect(hash.split("$")[3].split(",").sort()).toEqual(["m=65536", "p=1", "t=3"]);
    expect(needsPasswordRehash(hash)).toBe(false);
    // A real parse/verification call must resolve false, not throw and be ignored.
    await expect(argon2.verify(hash, "unknown-user-password")).resolves.toBe(false);
    const verify = vi.spyOn(argon2, "verify");
    try {
      await expect(verifyDummyPassword("unknown-user-password")).resolves.toBe(false);
      expect(verify).toHaveBeenCalledWith(hash, "unknown-user-password");
      verify.mockRejectedValueOnce(new Error("hashing unavailable"));
      await expect(verifyDummyPassword("unknown-user-password")).rejects.toThrow("hashing unavailable");
    } finally {
      verify.mockRestore();
    }
  });

  it("hashes/verifies a real password and rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "incorrect password")).toBe(false);
  });
});
