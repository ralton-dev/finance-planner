/** OIDC single sign-on. Present only when every one of the four settings is
 *  configured — a half-configured provider stays off rather than half-on. */
export interface OidcEnv {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthEnv {
  port: number;
  host: string;
  jwtSecret: string;
  databaseUrl?: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
  /** Path the refresh cookie is scoped to (matches the gateway prefix). */
  cookiePath: string;
  /** Where the SPA lives. Used to build emailed links and the post-SSO redirect. */
  publicWebUrl: string;
  /** nodemailer transport URL. Unset → mail is logged instead of sent. */
  smtpUrl?: string;
  /** From: header for outbound mail. */
  mailFrom: string;
  oidc?: OidcEnv;
}

/** Treat an empty string as absent: `FOO: ${FOO:-}` in compose sets "" for an
 *  unset variable, which `??` would happily pass through as configuration. */
const text = (value: string | undefined): string | undefined => (value ? value : undefined);

export function loadEnv(): AuthEnv {
  const oidcIssuer = process.env.OIDC_ISSUER;
  const oidcClientId = process.env.OIDC_CLIENT_ID;
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;
  const oidcRedirectUri = process.env.OIDC_REDIRECT_URI;

  return {
    port: Number(process.env.AUTH_PORT ?? 4001),
    host: process.env.HOST ?? "0.0.0.0",
    jwtSecret: process.env.JWT_SIGNING_KEY ?? "dev-insecure-secret-change-me",
    databaseUrl: process.env.DATABASE_URL,
    accessTtlSeconds: Number(process.env.ACCESS_TTL_SECONDS ?? 900),
    refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    cookiePath: process.env.COOKIE_PATH ?? "/api/auth",
    publicWebUrl: (process.env.PUBLIC_WEB_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    smtpUrl: text(process.env.SMTP_URL),
    mailFrom: text(process.env.MAIL_FROM) ?? "Finance Planner <no-reply@finance-planner.local>",
    oidc:
      oidcIssuer && oidcClientId && oidcClientSecret && oidcRedirectUri
        ? {
            issuer: oidcIssuer.replace(/\/+$/, ""),
            clientId: oidcClientId,
            clientSecret: oidcClientSecret,
            redirectUri: oidcRedirectUri,
          }
        : undefined,
  };
}
