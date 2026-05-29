import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("calc service", () => {
  it("GET /healthz returns ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe("calc");
    await app.close();
  });

  it("POST /internal/calc/account-plan computes a plan", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/internal/calc/account-plan",
      payload: {
        asOfDate: "2026-01-01",
        account: {
          accountId: "a1",
          currency: "GBP",
          incomes: [
            { id: "i1", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" },
          ],
          payments: [
            {
              id: "p1",
              name: "Holiday",
              category: "fixed_point",
              amountMinor: 120_000,
              dueDate: "2026-09-01",
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan.monthlyIncomeMinor).toBe(100_000);
    expect(plan.lines[0].requiredMonthlyMinor).toBe(15_000);
    expect(plan.leftoverMinor).toBe(85_000);
    await app.close();
  });
});
