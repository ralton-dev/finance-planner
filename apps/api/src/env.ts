export interface ApiEnv {
  port: number;
  host: string;
  jwtSecret: string;
  databaseUrl?: string;
  /** Upstream auth service the gateway forwards /api/auth/* to. */
  authUrl: string;
}

export function loadEnv(): ApiEnv {
  return {
    port: Number(process.env.API_PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    jwtSecret: process.env.JWT_SIGNING_KEY ?? "dev-insecure-secret-change-me",
    databaseUrl: process.env.DATABASE_URL,
    authUrl: process.env.AUTH_URL ?? "http://localhost:4001",
  };
}
