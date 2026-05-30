import { SignJWT, jwtVerify } from "jose";

const encoder = new TextEncoder();

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

/** Verify an access token; throws if invalid/expired. */
export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  return { sub: String(payload.sub), email: payload.email as string | undefined };
}
