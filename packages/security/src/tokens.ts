import { SignJWT, jwtVerify } from "jose";

const encoder = new TextEncoder();

/**
 * Purpose claim carried by every non-session token. Access tokens deliberately
 * carry *no* purpose, and `verifyAccessToken` rejects anything that does — so a
 * step-up ticket can never be replayed as a bearer token.
 */
export const TOTP_PENDING_PURPOSE = "totp_pending";

export interface AccessClaims {
  sub: string;
  email?: string;
}

/** Sign a short-lived access token (HS256) with the shared secret. */
export async function signAccessToken(
  secret: string,
  claims: AccessClaims,
  ttlSeconds = 900,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
}

/** Verify an access token; throws if invalid/expired/not a session token. */
export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  if (payload.purpose !== undefined) {
    throw new Error("token is not an access token");
  }
  return { sub: String(payload.sub), email: payload.email as string | undefined };
}

/**
 * Mint the ticket handed out when a password check succeeds but two-factor is
 * still owed. Same secret, different shape: it proves "this password was just
 * verified" and nothing more.
 */
export async function signPendingTotpToken(
  secret: string,
  claims: AccessClaims,
  ttlSeconds = 300,
): Promise<string> {
  return new SignJWT({ email: claims.email, purpose: TOTP_PENDING_PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
}

/** Verify a step-up ticket; throws unless it is a live pending-TOTP token. */
export async function verifyPendingTotpToken(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  if (payload.purpose !== TOTP_PENDING_PURPOSE) {
    throw new Error("token is not a pending two-factor token");
  }
  return { sub: String(payload.sub), email: payload.email as string | undefined };
}
