// SPDX-License-Identifier: Apache-2.0
import crypto from "node:crypto";
import argon2 from "argon2";
import QRCode from "qrcode";

/**
 * Argon2id parameters per Master Spec §3:
 * 64 MiB memory (65536 KiB), 3 iterations (timeCost 3), parallelism 1.
 */
export const ARGON2_OPTIONS: argon2.HashOptions & { type: 2 } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

/**
 * Cache one real hash at the same cost as registered passwords. Share the
 * initialization promise across concurrent unknown-user requests. Login startup
 * should warm this before accepting credentials to avoid a cold-request penalty.
 */
let dummyHash: Promise<string> | undefined;

export function initializeDummyPasswordHash(): Promise<string> {
  return dummyHash ??= hashPassword(crypto.randomBytes(32).toString("hex"));
}

/**
 * Cookie and expiry constants per Master Spec §3.
 */
export const SESSION_COOKIE_NAME = "__Host-next-round-session";
export const SESSION_DEV_COOKIE_NAME = "next-round-session";

export const SESSION_ABSOLUTE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_IDLE_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const USERNAME_REGEX = /^[a-z0-9_][a-z0-9_.-]{2,31}$/;

/**
 * Normalizes username to lowercase ASCII.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Validates username per Master Spec §3:
 * 3–32 characters, lowercase ASCII matching `^[a-z0-9_][a-z0-9_.-]{2,31}$`.
 */
export function validateUsername(username: string): {
  valid: boolean;
  normalized?: string;
  error?: string;
} {
  const normalized = normalizeUsername(username);
  if (!USERNAME_REGEX.test(normalized)) {
    return {
      valid: false,
      error:
        "Username must be 3-32 characters, start with a lowercase alphanumeric or underscore, and contain only [a-z0-9_.-].",
    };
  }
  return { valid: true, normalized };
}

/**
 * Validates password per Master Spec §3:
 * 12–128 Unicode code points, maximum 512 UTF-8 bytes.
 * Never silently truncates or normalizes.
 */
export function validatePassword(password: string): {
  valid: boolean;
  error?: string;
} {
  const codePoints = Array.from(password);
  if (codePoints.length < 12 || codePoints.length > 128) {
    return {
      valid: false,
      error: "Password must be 12 to 128 Unicode code points.",
    };
  }
  const utf8Bytes = Buffer.byteLength(password, "utf-8");
  if (utf8Bytes > 512) {
    return {
      valid: false,
      error: "Password exceeds maximum UTF-8 size of 512 bytes.",
    };
  }
  return { valid: true };
}

/**
 * Hashes a plaintext password with Argon2id using the approved parameters.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against an Argon2 hash.
 */
export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Checks if a stored password hash needs rehashing due to parameter updates.
 */
export function needsPasswordRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

/**
 * Executes a dummy password verification against an arbitrary password
 * to equalize response timing when a username does not exist.
 */
export async function verifyDummyPassword(password: string): Promise<boolean> {
  // Propagate hashing/verification failures instead of silently skipping work.
  await argon2.verify(await initializeDummyPasswordHash(), password);
  return false;
}

/**
 * Constant-time comparison for binary buffers of arbitrary length.
 */
export function timingSafeEqualBuffers(
  a: Buffer | Uint8Array,
  b: Buffer | Uint8Array
): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time comparison for UTF-8 strings.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generates a 256-bit cryptographically secure random opaque session token
 * along with its SHA-256 digest buffer.
 */
export function generateOpaqueSessionToken(): {
  rawToken: string;
  tokenHash: Buffer;
} {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken, "utf-8").digest();
  return { rawToken, tokenHash };
}

/**
 * Computes the 32-byte SHA-256 digest of an opaque session token.
 */
export function hashSessionToken(rawToken: string): Buffer {
  return crypto.createHash("sha256").update(rawToken, "utf-8").digest();
}

/**
 * Generates a 256-bit cryptographically secure random CSRF token
 * along with its SHA-256 digest buffer.
 */
export function generateCsrfToken(): {
  rawToken: string;
  csrfHash: Buffer;
} {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrfHash = crypto.createHash("sha256").update(rawToken, "utf-8").digest();
  return { rawToken, csrfHash };
}

/**
 * Computes the 32-byte SHA-256 digest of a CSRF token.
 */
export function hashCsrfToken(rawToken: string): Buffer {
  return crypto.createHash("sha256").update(rawToken, "utf-8").digest();
}

/**
 * Renders a URL or token as a QR code Data URL (PNG) for mobile handoff / invitation links.
 */
export async function generateQrCodeDataUrl(data: string): Promise<string> {
  return QRCode.toDataURL(data, {
    errorCorrectionLevel: "M",
    margin: 2,
  });
}

/**
 * Renders a URL or token as a QR code SVG string.
 */
export async function generateQrCodeSvg(data: string): Promise<string> {
  const result = await QRCode.toString(data, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  });
  return result as unknown as string;
}
