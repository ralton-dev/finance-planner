import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("api health endpoints", () => {
  it("GET /healthz returns ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });

  it("GET /readyz reports readiness", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
    await app.close();
  });
});
