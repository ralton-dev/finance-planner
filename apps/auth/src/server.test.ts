import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("auth health endpoints", () => {
  it("GET /healthz returns ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe("auth");
    await app.close();
  });
});
