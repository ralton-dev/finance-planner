import { verifyJwtWithJwks } from "@finance-planner/security";
import type { OidcEnv } from "./env.js";

/** The slice of the provider's discovery document we actually use. */
export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** The claims we care about from a verified id_token. */
export interface OidcIdTokenClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

/**
 * Everything the callback route needs from an identity provider. Narrow on
 * purpose: tests inject a fake instead of standing up a provider.
 */
export interface OidcClient {
  discover(): Promise<OidcDiscovery>;
  exchangeCode(code: string, verifier: string): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string): Promise<OidcIdTokenClaims>;
}

interface RawDiscovery {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
}

export class OidcError extends Error {}

/**
 * Real provider over `fetch` + `jose`. Discovery and the JWKS are fetched once
 * and cached for the process lifetime (jose refreshes the key set itself when
 * it sees an unknown `kid`).
 *
 * Nothing here logs a code, token or secret — the whole exchange is quiet.
 */
export class HttpOidcClient implements OidcClient {
  private discovery?: Promise<OidcDiscovery>;

  constructor(private readonly config: OidcEnv) {}

  async discover(): Promise<OidcDiscovery> {
    this.discovery ??= this.fetchDiscovery();
    try {
      return await this.discovery;
    } catch (err) {
      this.discovery = undefined; // don't cache a failure
      throw err;
    }
  }

  private async fetchDiscovery(): Promise<OidcDiscovery> {
    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new OidcError(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json()) as RawDiscovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new OidcError("OIDC discovery document is missing required endpoints");
    }
    return {
      issuer: doc.issuer ?? this.config.issuer,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
    };
  }

  async exchangeCode(code: string, verifier: string): Promise<{ idToken: string }> {
    const { tokenEndpoint } = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: verifier,
    });
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!res.ok) throw new OidcError(`OIDC token exchange failed (${res.status})`);
    const payload = (await res.json()) as { id_token?: string };
    if (!payload.id_token) throw new OidcError("OIDC token response carried no id_token");
    return { idToken: payload.id_token };
  }

  async verifyIdToken(idToken: string): Promise<OidcIdTokenClaims> {
    const discovery = await this.discover();
    const payload = await verifyJwtWithJwks(idToken, discovery.jwksUri, {
      issuer: discovery.issuer,
      audience: this.config.clientId,
    });
    return {
      sub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : undefined,
      emailVerified:
        typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
    };
  }
}
