import type { HealthResponse, ReadinessResponse } from "@finance-planner/contracts";
import {
  accountPlanFromScope,
  computeScopePlan,
  type ScopeInput,
  toISODate,
} from "@finance-planner/domain";
import Fastify, { type FastifyInstance } from "fastify";

const SERVICE = "calc";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();

/**
 * One account's plan, computed from the scope it belongs to.
 *
 * The scope travels rather than the account, because an account is not a unit of
 * planning: its bills are funded from its owner's budget alongside every other
 * account's, and a request carrying one account could only be answered by
 * pretending the rest of the scope is not there — which is the arrangement
 * ONE-ENGINE.md deletes.
 */
interface AccountPlanBody {
  scope: ScopeInput;
  accountId: string;
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
    return accountPlanFromScope(
      req.body.scope,
      computeScopePlan(req.body.scope, asOf),
      req.body.accountId,
    );
  });

  return app;
}
