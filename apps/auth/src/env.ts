export interface AuthEnv {
  port: number;
  host: string;
  jwtSecret: string;
  databaseUrl?: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
}

export function loadEnv(): AuthEnv {
  return {
    port: Number(process.env.AUTH_PORT ?? 4001),
    host: process.env.HOST ?? "0.0.0.0",
    jwtSecret: process.env.JWT_SIGNING_KEY ?? "dev-insecure-secret-change-me",
    databaseUrl: process.env.DATABASE_URL,
    accessTtlSeconds: Number(process.env.ACCESS_TTL_SECONDS ?? 900),
    refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
    cookieSecure: process.env.COOKIE_SECURE === "true",
  };
}
