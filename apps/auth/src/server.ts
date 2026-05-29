import type { HealthResponse, ReadinessResponse } from "@finance-planner/contracts";
import Fastify, { type FastifyInstance } from "fastify";

const SERVICE = "auth";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  app.get(
    "/healthz",
    async (): Promise<HealthResponse> => ({
      status: "ok",
      service: SERVICE,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get(
    "/readyz",
    async (): Promise<ReadinessResponse> => ({
      ready: true,
      checks: {},
    }),
  );

  return app;
}
