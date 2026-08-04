import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Verification against a remote JWKS (an OIDC provider's `jwks_uri`). Lives
 * here so `jose` stays a dependency of exactly one package.
 */

/** Key sets are fetched once per URI and refreshed by jose on unknown `kid`s. */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface JwksVerifyOptions {
  issuer?: string;
  audience?: string;
}

/** Verify a third-party JWT (e.g. an OIDC id_token). Throws when invalid. */
export async function verifyJwtWithJwks(
  token: string,
  jwksUri: string,
  options: JwksVerifyOptions = {},
): Promise<Record<string, unknown>> {
  let keySet = keySets.get(jwksUri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUri));
    keySets.set(jwksUri, keySet);
  }
  const { payload } = await jwtVerify(token, keySet, options);
  return payload;
}
