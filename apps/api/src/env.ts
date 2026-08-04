export interface ApiEnv {
  port: number;
  host: string;
  jwtSecret: string;
  databaseUrl?: string;
  /** Upstream auth service the gateway forwards /api/auth/* to. */
  authUrl: string;
  /** nodemailer transport URL for the digest. Unset → digests are logged. */
  smtpUrl?: string;
  /** From: header for outbound mail. */
  mailFrom: string;
  /**
   * Run the daily digest notifier in-process. Off by default: it is a
   * background sender, and a deployment that scales the api horizontally should
   * turn it on for exactly one replica (the notification log makes a double-send
   * harmless, but there is no reason to do the work twice).
   */
  notifyEnabled: boolean;
  /** Local hour (0–23) from which the day's digests may go out. */
  notifyHour: number;
  /** Expose POST /api/demo/seed. Off by default; see the route comment. */
  enableDemoSeed: boolean;
}

/** Parse an hour-of-day env var, falling back on anything unusable. */
function hour(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return fallback;
  return parsed;
}

/** Treat an empty string as absent: `FOO: ${FOO:-}` in compose sets "" for an
 *  unset variable, which `??` would happily pass through as configuration. */
const text = (value: string | undefined): string | undefined => (value ? value : undefined);

export function loadEnv(): ApiEnv {
  return {
    port: Number(process.env.API_PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    jwtSecret: process.env.JWT_SIGNING_KEY ?? "dev-insecure-secret-change-me",
    databaseUrl: process.env.DATABASE_URL,
    authUrl: process.env.AUTH_URL ?? "http://localhost:4001",
    smtpUrl: text(process.env.SMTP_URL),
    mailFrom: text(process.env.MAIL_FROM) ?? "Finance Planner <no-reply@finance-planner.local>",
    notifyEnabled: process.env.NOTIFY_ENABLED === "true",
    notifyHour: hour(process.env.NOTIFY_HOUR, 8),
    enableDemoSeed: process.env.ENABLE_DEMO_SEED === "true",
  };
}
