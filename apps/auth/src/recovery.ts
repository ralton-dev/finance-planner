import { randomInt } from "node:crypto";

/**
 * Recovery codes: the way back in when the authenticator app is gone.
 *
 * Alphabet drops the characters people mis-transcribe (0/O, 1/I/L, U/V, S/5,
 * B/8, Z/2) so a code read off paper lands first time. 8 characters from 23
 * symbols ≈ 36 bits — plenty against an online, rate-limited endpoint.
 */
const ALPHABET = "ACDEFGHJKMNPQRTWXY346789";

export const RECOVERY_CODE_COUNT = 8;

/** A code in `xxxx-xxxx` form, e.g. `H7QK-3M9T`. */
export function generateRecoveryCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** Fold a user-typed code back to canonical form before hashing/comparing. */
export function normaliseRecoveryCode(code: string): string {
  const bare = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}
