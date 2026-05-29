import type { HealthResponse, ReadinessResponse } from "@finance-planner/contracts";
import { type AccountInput, computeAccountPlan, toISODate } from "@finance-planner/domain";
import Fastify, { type FastifyInstance } from "fastify";

const SERVICE = "calc";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();

interface AccountPlanBody {
  account: AccountInput;
  asOfDate?: string;
}

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

  // Synchronous plan computation. Phase 1 adds validation + persistence.
  app.post<{ Body: AccountPlanBody }>("/internal/calc/account-plan", async (req) => {
    const asOf = req.body.asOfDate ?? toISODate(new Date());
    return computeAccountPlan(req.body.account, asOf);
  });

  return app;
}
