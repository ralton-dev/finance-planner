import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238) over HMAC-SHA1 counters (RFC 4226),
 * plus the RFC 4648 base32 alphabet authenticator apps expect. Built on
 * node:crypto only — no runtime dependency to install or audit.
 */

/** RFC 4648 base32 alphabet. Padding is never emitted (otpauth URIs omit it). */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode bytes as unpadded base32. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Flush the trailing partial group, left-aligned like the RFC requires.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 (padding, whitespace and lower case all tolerated). */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit shared secret, base32-encoded for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  /** Seconds per time step (RFC 6238 default: 30). */
  step?: number;
  /** Digits in the generated code (6 is universal). */
  digits?: number;
}

export interface VerifyTotpOptions extends TotpOptions {
  /** How many steps either side of "now" are accepted (clock drift). */
  window?: number;
}

/**
 * HOTP (RFC 4226): HMAC-SHA1 over a big-endian 64-bit counter, dynamically
 * truncated to `digits`. The TOTP core — exposed so the RFC's published test
 * vectors can be driven straight through it.
 */
export function hotpCode(secret: string, counter: number | bigint, digits = 6): string {
  const counterValue = BigInt(counter);
  if (counterValue < 0n) throw new Error("counter must be non-negative");
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counterValue);

  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code valid at `timeMs` (epoch milliseconds). */
export function totpCode(secret: string, timeMs: number, options: TotpOptions = {}): string {
  const { step = 30, digits = 6 } = options;
  return hotpCode(secret, Math.floor(timeMs / 1000 / step), digits);
}

/** Constant-time string compare that tolerates length mismatches. */
function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Accept a code from the ±`window` steps around `timeMs`. Every candidate is
 * compared even after a match so verification time doesn't leak which step hit.
 */
export function verifyTotp(
  secret: string,
  code: string,
  timeMs: number,
  options: VerifyTotpOptions = {},
): boolean {
  const { step = 30, digits = 6, window = 1 } = options;
  const candidate = code.replace(/[\s-]/g, "");
  if (candidate.length !== digits || !/^\d+$/.test(candidate)) return false;

  const counter = Math.floor(timeMs / 1000 / step);
  let matched = false;
  for (let drift = -window; drift <= window; drift++) {
    const at = counter + drift;
    if (at < 0) continue;
    if (sameCode(hotpCode(secret, at, digits), candidate)) matched = true;
  }
  return matched;
}

/**
 * otpauth:// URI for QR enrolment. Both the label and the issuer parameter are
 * set — apps key off the parameter, but the label prefix keeps older ones happy.
 */
export function buildOtpauthUri(
  secret: string,
  accountEmail: string,
  issuer = "Finance Planner",
  options: TotpOptions = {},
): string {
  const { step = 30, digits = 6 } = options;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(issuer)}`,
    "algorithm=SHA1",
    `digits=${digits}`,
    `period=${step}`,
  ].join("&");
  return `otpauth://totp/${label}?${params}`;
}
