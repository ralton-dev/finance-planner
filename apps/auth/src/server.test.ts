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
  cookiePath: "/api/auth",
};

const register = { email: "user@example.com", password: "password123", displayName: "User" };

function makeApp() {
  const store = new MemoryStore();
  const mailer = new LogMailer();
  // Disable rate-limit in tests so back-to-back logins don't trip the per-IP throttle.
  const app = buildServer({ store, mailer, env, rateLimit: false });
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
      url: "/auth/me",
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
    const res = await ctx.app.inject({ method: "GET", url: "/auth/me" });
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

  it("detects refresh-token reuse and revokes every active session for the user", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login1 = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const cookie1 = login1.cookies.find((c) => c.name === "fp_refresh")!.value;

    // Second login (e.g. a second device) — another active session is born.
    const login2 = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const cookie2 = login2.cookies.find((c) => c.name === "fp_refresh")!.value;

    // First refresh rotates cookie1 — the old one is now revoked.
    const rotated = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: cookie1 },
    });
    expect(rotated.statusCode).toBe(200);

    // Replay cookie1 → attacker scenario. Expect 401 with reuse code, and the
    // *other* session (cookie2) should also be revoked as collateral.
    const replayed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: cookie1 },
    });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().error.code).toBe("reuse_detected");

    const stillAlive = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: cookie2 },
    });
    expect(stillAlive.statusCode).toBe(401);
  });

  it("creates and lists households for the authenticated user", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    const created = await ctx.app.inject({
      method: "POST",
      url: "/auth/households",
      headers: auth,
      payload: { name: "Home" },
    });
    expect(created.statusCode).toBe(201);

    const list = await ctx.app.inject({ method: "GET", url: "/auth/households", headers: auth });
    expect(list.json()).toHaveLength(1);
  });

  it("household detail returns members + shares for the owner", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const ownerAuth = { authorization: `Bearer ${login.json().accessToken}` };

    const partnerPayload = {
      email: "partner@example.com",
      password: "password123",
      displayName: "Partner",
    };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: partnerPayload });

    const household = (
      await ctx.app.inject({
        method: "POST",
        url: "/auth/households",
        headers: ownerAuth,
        payload: { name: "Home" },
      })
    ).json();

    // owner adds the partner
    const add = await ctx.app.inject({
      method: "POST",
      url: `/auth/households/${household.id}/members`,
      headers: ownerAuth,
      payload: { email: "partner@example.com", role: "member" },
    });
    expect(add.statusCode).toBe(201);

    // duplicate invite → 409
    const dup = await ctx.app.inject({
      method: "POST",
      url: `/auth/households/${household.id}/members`,
      headers: ownerAuth,
      payload: { email: "partner@example.com", role: "member" },
    });
    expect(dup.statusCode).toBe(409);

    // pre-seed a shared account directly via the store to avoid wiring the api gateway here
    const ownerUser = await ctx.store.getUserByEmail(register.email);
    const acct = await ctx.store.createAccount({
      ownerUserId: ownerUser!.id,
      name: "Joint",
      currency: "GBP",
    });
    await ctx.store.createAccountShare(acct.id, household.id, "edit");

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/auth/households/${household.id}`,
      headers: ownerAuth,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.name).toBe("Home");
    expect(body.yourRole).toBe("owner");
    expect(body.members.map((m: { email: string }) => m.email).sort()).toEqual([
      "partner@example.com",
      "user@example.com",
    ]);
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0].accountName).toBe("Joint");
    expect(body.shares[0].permission).toBe("edit");
  });

  it("sets a member's contribution share and surfaces it in the household detail", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const ownerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: register,
    });
    const ownerAuth = { authorization: `Bearer ${ownerLogin.json().accessToken}` };
    const partner = {
      email: "partner@example.com",
      password: "password123",
      displayName: "Partner",
    };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: partner });

    const household = (
      await ctx.app.inject({
        method: "POST",
        url: "/auth/households",
        headers: ownerAuth,
        payload: { name: "Home" },
      })
    ).json();
    await ctx.app.inject({
      method: "POST",
      url: `/auth/households/${household.id}/members`,
      headers: ownerAuth,
      payload: { email: partner.email, role: "member" },
    });

    const partnerUser = await ctx.store.getUserByEmail(partner.email);
    const set = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/households/${household.id}/members/${partnerUser!.id}/share`,
      headers: ownerAuth,
      payload: { shareBp: 3400 },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().contributionShareBp).toBe(3400);

    const detail = (
      await ctx.app.inject({
        method: "GET",
        url: `/auth/households/${household.id}`,
        headers: ownerAuth,
      })
    ).json();
    const pm = detail.members.find((m: { email: string }) => m.email === partner.email);
    expect(pm.shareBp).toBe(3400);
  });

  it("forbids a plain member from setting contribution shares (403)", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const ownerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: register,
    });
    const ownerAuth = { authorization: `Bearer ${ownerLogin.json().accessToken}` };
    const partner = {
      email: "partner@example.com",
      password: "password123",
      displayName: "Partner",
    };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: partner });
    const partnerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: partner,
    });
    const partnerAuth = { authorization: `Bearer ${partnerLogin.json().accessToken}` };

    const household = (
      await ctx.app.inject({
        method: "POST",
        url: "/auth/households",
        headers: ownerAuth,
        payload: { name: "Home" },
      })
    ).json();
    await ctx.app.inject({
      method: "POST",
      url: `/auth/households/${household.id}/members`,
      headers: ownerAuth,
      payload: { email: partner.email, role: "member" },
    });
    const partnerUser = await ctx.store.getUserByEmail(partner.email);

    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/households/${household.id}/members/${partnerUser!.id}/share`,
      headers: partnerAuth,
      payload: { shareBp: 5000 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("hides households from non-members (404)", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const ownerAuth = { authorization: `Bearer ${login.json().accessToken}` };
    const household = (
      await ctx.app.inject({
        method: "POST",
        url: "/auth/households",
        headers: ownerAuth,
        payload: { name: "Home" },
      })
    ).json();

    const stranger = {
      email: "stranger@example.com",
      password: "password123",
      displayName: "Stranger",
    };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: stranger });
    const strangerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: stranger,
    });
    const strangerAuth = { authorization: `Bearer ${strangerLogin.json().accessToken}` };

    const res = await ctx.app.inject({
      method: "GET",
      url: `/auth/households/${household.id}`,
      headers: strangerAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("admins can remove members; the owner cannot be removed by others", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const ownerAuth = { authorization: `Bearer ${login.json().accessToken}` };

    const partner = {
      email: "partner@example.com",
      password: "password123",
      displayName: "Partner",
    };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: partner });
    const partnerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: partner,
    });
    const partnerAuth = { authorization: `Bearer ${partnerLogin.json().accessToken}` };

    const household = (
      await ctx.app.inject({
        method: "POST",
        url: "/auth/households",
        headers: ownerAuth,
        payload: { name: "Home" },
      })
    ).json();
    await ctx.app.inject({
      method: "POST",
      url: `/auth/households/${household.id}/members`,
      headers: ownerAuth,
      payload: { email: partner.email, role: "member" },
    });

    const partnerUser = await ctx.store.getUserByEmail(partner.email);
    const ownerUser = await ctx.store.getUserByEmail(register.email);

    // partner (a regular member) cannot remove the owner
    const forbidden = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/households/${household.id}/members/${ownerUser!.id}`,
      headers: partnerAuth,
    });
    expect(forbidden.statusCode).toBe(403);

    // owner removes the partner
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/households/${household.id}/members/${partnerUser!.id}`,
      headers: ownerAuth,
    });
    expect(removed.statusCode).toBe(204);

    // partner can no longer see the household
    const after = await ctx.app.inject({
      method: "GET",
      url: `/auth/households/${household.id}`,
      headers: partnerAuth,
    });
    expect(after.statusCode).toBe(404);
  });

  it("only the owner can promote / demote members or delete the household", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const ownerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: register,
    });
    const ownerAuth = { authorization: `Bearer ${ownerLogin.json().accessToken}` };

    const partner = {
      email: "partner@example.com",
      password: "password123",
      displayName: "Partner",
    };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: partner });
    const partnerLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: partner,
    });
    const partnerAuth = { authorization: `Bearer ${partnerLogin.json().accessToken}` };

    const household = (
      await ctx.app.inject({
        method: "POST",
        url: "/auth/households",
        headers: ownerAuth,
        payload: { name: "Home" },
      })
    ).json();
    await ctx.app.inject({
      method: "POST",
      url: `/auth/households/${household.id}/members`,
      headers: ownerAuth,
      payload: { email: partner.email, role: "member" },
    });
    const partnerUser = await ctx.store.getUserByEmail(partner.email);
    const ownerUser = await ctx.store.getUserByEmail(register.email);

    // owner promotes partner to admin
    const promote = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/households/${household.id}/members/${partnerUser!.id}`,
      headers: ownerAuth,
      payload: { role: "admin" },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe("admin");

    // admin partner cannot promote anyone (only owner can)
    const adminAttempt = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/households/${household.id}/members/${partnerUser!.id}`,
      headers: partnerAuth,
      payload: { role: "member" },
    });
    expect(adminAttempt.statusCode).toBe(403);

    // nobody (not even the owner) can change the owner's role via this endpoint
    const ownerSelf = await ctx.app.inject({
      method: "PATCH",
      url: `/auth/households/${household.id}/members/${ownerUser!.id}`,
      headers: ownerAuth,
      payload: { role: "member" },
    });
    expect(ownerSelf.statusCode).toBe(403);

    // admin cannot delete the household
    const adminDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/households/${household.id}`,
      headers: partnerAuth,
    });
    expect(adminDelete.statusCode).toBe(403);

    // owner can — household and its memberships go away
    const ownerDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/auth/households/${household.id}`,
      headers: ownerAuth,
    });
    expect(ownerDelete.statusCode).toBe(204);
    expect(await ctx.store.getHousehold(household.id)).toBeNull();
  });
});
