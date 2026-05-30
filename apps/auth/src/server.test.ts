import { MemoryStore } from "@finance-planner/data";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./env.js";
import { LogMailer } from "./mailer.js";
import { buildServer } from "./server.js";

const env: AuthEnv = {
  port: 0,
  host: "127.0.0.1",
  jwtSecret: "test-secret",
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
  cookieSecure: false,
};

const register = { email: "user@example.com", password: "password123", displayName: "User" };

function makeApp() {
  const store = new MemoryStore();
  const mailer = new LogMailer();
  const app = buildServer({ store, mailer, env });
  return { app, store, mailer };
}

describe("auth service", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("health endpoint reports the service", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(res.json().service).toBe("auth");
  });

  it("registers, verifies, logs in, and returns the current user", async () => {
    const reg = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    expect(reg.statusCode).toBe(201);
    expect(ctx.mailer.sent).toHaveLength(1);

    const token = ctx.mailer.sent[0]!.token;
    const verify = await ctx.app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: { token },
    });
    expect(verify.json().verified).toBe(true);

    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    expect(login.statusCode).toBe(200);
    const accessToken = login.json().accessToken as string;
    expect(accessToken).toBeTruthy();

    const me = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.json().email).toBe("user@example.com");
    expect(me.json().emailVerified).toBe(true);
  });

  it("rejects duplicate registration", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const dup = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects bad credentials", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: register.email, password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("rejects /me without a token", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("refreshes the access token using the refresh cookie", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const refreshCookie = login.cookies.find((c) => c.name === "fp_refresh");
    expect(refreshCookie).toBeDefined();

    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: refreshCookie!.value },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().accessToken).toBeTruthy();
  });

  it("creates and lists households for the authenticated user", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    const created = await ctx.app.inject({
      method: "POST",
      url: "/households",
      headers: auth,
      payload: { name: "Home" },
    });
    expect(created.statusCode).toBe(201);

    const list = await ctx.app.inject({ method: "GET", url: "/households", headers: auth });
    expect(list.json()).toHaveLength(1);
  });
});
