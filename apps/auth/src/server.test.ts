import { MemoryStore } from "@finance-planner/data";
import { LogMailer } from "@finance-planner/mailer";
import { signAccessToken, totpCode } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./env.js";
import type { OidcClient, OidcDiscovery, OidcIdTokenClaims } from "./oidc.js";
import { buildServer } from "./server.js";

const env: AuthEnv = {
  port: 0,
  host: "127.0.0.1",
  jwtSecret: "test-secret",
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
  cookieSecure: false,
  cookiePath: "/api/auth",
  publicWebUrl: "http://localhost:5173",
  mailFrom: "Finance Planner <no-reply@test.local>",
};

const oidcEnv: AuthEnv = {
  ...env,
  oidc: {
    issuer: "https://idp.example.com",
    clientId: "finance-planner",
    clientSecret: "shhh",
    redirectUri: "http://localhost:4001/auth/oidc/callback",
  },
};

const register = { email: "user@example.com", password: "password123", displayName: "User" };

/** `now` is injected by the refresh-rotation tests so they can step over the
 *  grace window rather than sleep through it. */
function makeApp(now?: () => number) {
  const store = new MemoryStore();
  const mailer = new LogMailer();
  // Disable rate-limit in tests so back-to-back logins don't trip the per-IP throttle.
  const app = buildServer({ store, mailer, env, rateLimit: false, now });
  return { app, store, mailer };
}

/** Stands in for a real identity provider: no network, scriptable claims. */
class FakeOidcClient implements OidcClient {
  public exchanged: { code: string; verifier: string }[] = [];
  constructor(private claims: OidcIdTokenClaims) {}

  async discover(): Promise<OidcDiscovery> {
    return {
      issuer: "https://idp.example.com",
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      jwksUri: "https://idp.example.com/jwks",
    };
  }

  async exchangeCode(code: string, verifier: string): Promise<{ idToken: string }> {
    this.exchanged.push({ code, verifier });
    return { idToken: "fake.id.token" };
  }

  async verifyIdToken(): Promise<OidcIdTokenClaims> {
    return this.claims;
  }
}

function makeOidcApp(claims: OidcIdTokenClaims) {
  const store = new MemoryStore();
  const mailer = new LogMailer();
  const oidcClient = new FakeOidcClient(claims);
  const app = buildServer({ store, mailer, env: oidcEnv, oidcClient, rateLimit: false });
  return { app, store, mailer, oidcClient };
}

/** The fp_refresh value a response set — what the next request must send back. */
function refreshCookie(res: { cookies: { name: string; value: string }[] }): string {
  return res.cookies.find((c) => c.name === "fp_refresh")!.value;
}

/** Register + log in, returning the bearer header the authed routes want. */
async function registerAndLogin(app: ReturnType<typeof makeApp>["app"]) {
  await app.inject({ method: "POST", url: "/auth/register", payload: register });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: register });
  return { authorization: `Bearer ${login.json().accessToken as string}` };
}

/** Walk a user all the way through TOTP enrolment; hand back secret + codes. */
async function enrolTotp(app: ReturnType<typeof makeApp>["app"], auth: { authorization: string }) {
  const setup = await app.inject({ method: "POST", url: "/auth/totp/setup", headers: auth });
  const secret = setup.json().secret as string;
  const enable = await app.inject({
    method: "POST",
    url: "/auth/totp/enable",
    headers: auth,
    payload: { code: totpCode(secret, Date.now()) },
  });
  return { secret, enable, recoveryCodes: enable.json().recoveryCodes as string[] };
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
    // A replay long after the rotation is theft, not a race: hold the clock
    // still, then step it past the grace window before replaying.
    let clock = Date.now();
    const app = makeApp(() => clock).app;
    await app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login1 = await app.inject({ method: "POST", url: "/auth/login", payload: register });
    const cookie1 = refreshCookie(login1);

    // Second login (e.g. a second device) — another active session is born.
    const login2 = await app.inject({ method: "POST", url: "/auth/login", payload: register });
    const cookie2 = refreshCookie(login2);

    // First refresh rotates cookie1 — the old one is now revoked.
    const rotated = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: cookie1 },
    });
    expect(rotated.statusCode).toBe(200);

    clock += 60_000;

    // Replay cookie1 → attacker scenario. Expect 401 with reuse code, and the
    // *other* session (cookie2) should also be revoked as collateral.
    const replayed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: cookie1 },
    });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().error.code).toBe("reuse_detected");

    const stillAlive = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: cookie2 },
    });
    expect(stillAlive.statusCode).toBe(401);
  });

  // The bug these pin: two tabs (or one page's parallel requests) present the
  // same refresh cookie, the second one lands after rotation, and the old code
  // read that as theft — signing the user out of every device, the racing tab
  // included.
  it("keeps racing refreshes on one cookie signed in", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const cookie = refreshCookie(login);

    // Five at once is the real trigger: a page whose access token has expired
    // 401s on every request it has in flight, and each retry refreshes.
    const raced = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { fp_refresh: cookie } }),
      ),
    );

    expect(raced.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    for (const res of raced) expect(res.json().accessToken).toBeTruthy();
    // All were handed the same live session, so whichever Set-Cookie the
    // browser kept still works.
    const issued = new Set(raced.map(refreshCookie));
    expect(issued.size).toBe(1);
    const next = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: [...issued][0]! },
    });
    expect(next.statusCode).toBe(200);
  });

  it("leaves other devices' sessions alone when tabs race", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const laptop = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const phone = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });

    for (let i = 0; i < 2; i++) {
      const raced = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { fp_refresh: refreshCookie(laptop) },
      });
      expect(raced.statusCode).toBe(200);
    }

    const stillSignedIn = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: refreshCookie(phone) },
    });
    expect(stillSignedIn.statusCode).toBe(200);
  });

  it("follows the rotation chain when the straggler is several refreshes behind", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const stale = refreshCookie(login);

    // The winning tab refreshes twice more while the straggler is in flight.
    let latest = stale;
    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { fp_refresh: latest },
      });
      latest = refreshCookie(res);
    }

    const straggler = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: stale },
    });
    expect(straggler.statusCode).toBe(200);
    expect(refreshCookie(straggler)).toBe(latest);
  });

  it("never resurrects a session that was ended inside the grace window", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const stale = refreshCookie(login);

    const rotated = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: stale },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { fp_refresh: refreshCookie(rotated) },
    });

    // Still inside the window, but there is no live session to replay onto.
    const replayed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: stale },
    });
    expect(replayed.statusCode).toBe(401);
  });

  it("clears the refresh cookie with the attributes it was set with", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const set = login.cookies.find((c) => c.name === "fp_refresh")!;

    const out = await ctx.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { fp_refresh: set.value },
    });
    const cleared = out.cookies.find((c) => c.name === "fp_refresh")!;
    expect(cleared.value).toBe("");
    // A clear whose attributes differ names a different cookie to the browser.
    expect(cleared.path).toBe(set.path);
    expect(cleared.sameSite).toBe(set.sameSite);
    expect(cleared.httpOnly).toBe(set.httpOnly);
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

describe("two-factor authentication", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("enrols: setup stages a secret, a wrong code is refused, a right one arms it", async () => {
    const auth = await registerAndLogin(ctx.app);

    const setup = await ctx.app.inject({ method: "POST", url: "/auth/totp/setup", headers: auth });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.json().otpauthUri).toContain(
      "otpauth://totp/Finance%20Planner:user%40example.com",
    );
    expect(setup.json().otpauthUri).toContain(`secret=${secret}`);

    // Staged only: two-factor is not live yet, so login still works outright.
    const user = await ctx.store.getUserByEmail(register.email);
    expect(user?.totpEnabledAt).toBeNull();
    const stagedLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: register,
    });
    expect(stagedLogin.json().accessToken).toBeTruthy();

    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/enable",
      headers: auth,
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe("invalid_code");
    expect((await ctx.store.getUserByEmail(register.email))?.totpEnabledAt).toBeNull();

    const enable = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/enable",
      headers: auth,
      payload: { code: totpCode(secret, Date.now()) },
    });
    expect(enable.statusCode).toBe(200);
    const codes = enable.json().recoveryCodes as string[];
    expect(codes).toHaveLength(8);
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(new Set(codes).size).toBe(8);
    // Codes are stored hashed, never in the clear.
    const stored = await ctx.store.listUnusedRecoveryCodes(
      (await ctx.store.getUserByEmail(register.email))!.id,
    );
    expect(stored).toHaveLength(8);
    for (const row of stored) expect(codes).not.toContain(row.codeHash);

    // Re-running setup once armed would silently rotate the secret — refuse.
    const again = await ctx.app.inject({ method: "POST", url: "/auth/totp/setup", headers: auth });
    expect(again.statusCode).toBe(409);
  });

  it("stops login at the password step and finishes it with a code", async () => {
    const auth = await registerAndLogin(ctx.app);
    const { secret } = await enrolTotp(ctx.app, auth);

    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    expect(login.statusCode).toBe(200);
    expect(login.json().totpRequired).toBe(true);
    expect(login.json().accessToken).toBeUndefined();
    // Crucially: no session yet, so no refresh cookie.
    expect(login.cookies.find((c) => c.name === "fp_refresh")).toBeUndefined();
    const pendingToken = login.json().pendingToken as string;

    // A pending ticket is not a bearer token, anywhere.
    const meWithPending = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${pendingToken}` },
    });
    expect(meWithPending.statusCode).toBe(401);
    const householdsWithPending = await ctx.app.inject({
      method: "GET",
      url: "/auth/households",
      headers: { authorization: `Bearer ${pendingToken}` },
    });
    expect(householdsWithPending.statusCode).toBe(401);

    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken, code: "000000" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("invalid_code");

    // Neither a code nor a recovery code → validation failure, not a 401.
    const empty = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken },
    });
    expect(empty.statusCode).toBe(422);

    // A garbage ticket is rejected before any code is even looked at.
    const badTicket = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken: "not-a-jwt", code: totpCode(secret, Date.now()) },
    });
    expect(badTicket.statusCode).toBe(401);
    expect(badTicket.json().error.code).toBe("invalid_pending_token");

    const done = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken, code: totpCode(secret, Date.now()) },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().accessToken).toBeTruthy();
    expect(done.json().user.email).toBe(register.email);
    const refresh = done.cookies.find((c) => c.name === "fp_refresh");
    expect(refresh).toBeDefined();

    // The session behaves exactly like a password-only one.
    const me = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${done.json().accessToken}` },
    });
    expect(me.json().email).toBe(register.email);
    expect(me.json().totpEnabled).toBe(true);
    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: refresh!.value },
    });
    expect(refreshed.statusCode).toBe(200);
  });

  it("accepts a recovery code once and never again", async () => {
    const auth = await registerAndLogin(ctx.app);
    const { recoveryCodes } = await enrolTotp(ctx.app, auth);
    const code = recoveryCodes[0]!;

    const login = async () =>
      (await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register })).json()
        .pendingToken as string;

    const first = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken: await login(), recoveryCode: code.toLowerCase() },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().accessToken).toBeTruthy();

    const replay = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken: await login(), recoveryCode: code },
    });
    expect(replay.statusCode).toBe(401);

    // The other seven still work.
    const second = await ctx.app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { pendingToken: await login(), recoveryCode: recoveryCodes[1]! },
    });
    expect(second.statusCode).toBe(200);
  });

  it("disables two-factor with a recovery code and clears the stored secret", async () => {
    const auth = await registerAndLogin(ctx.app);
    const { recoveryCodes } = await enrolTotp(ctx.app, auth);

    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: auth,
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(422);

    const disabled = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: auth,
      payload: { code: recoveryCodes[7]! },
    });
    expect(disabled.statusCode).toBe(200);

    const user = await ctx.store.getUserByEmail(register.email);
    expect(user?.totpSecret).toBeNull();
    expect(user?.totpEnabledAt).toBeNull();
    expect(await ctx.store.listUnusedRecoveryCodes(user!.id)).toHaveLength(0);

    // Back to a one-step login.
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    expect(login.json().accessToken).toBeTruthy();
    expect(login.json().totpRequired).toBeUndefined();

    // Nothing left to disable.
    const twice = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: auth,
      payload: { code: recoveryCodes[6]! },
    });
    expect(twice.statusCode).toBe(409);
  });

  it("disables two-factor with a live authenticator code", async () => {
    const auth = await registerAndLogin(ctx.app);
    const { secret } = await enrolTotp(ctx.app, auth);

    const disabled = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: auth,
      payload: { code: totpCode(secret, Date.now()) },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await ctx.store.getUserByEmail(register.email))?.totpEnabledAt).toBeNull();
  });

  it("refuses enable before setup, and every 2FA route without a bearer token", async () => {
    const auth = await registerAndLogin(ctx.app);
    const premature = await ctx.app.inject({
      method: "POST",
      url: "/auth/totp/enable",
      headers: auth,
      payload: { code: "123456" },
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().error.code).toBe("totp_not_started");

    for (const url of ["/auth/totp/setup", "/auth/totp/enable", "/auth/totp/disable"]) {
      const res = await ctx.app.inject({ method: "POST", url, payload: { code: "123456" } });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("password reset", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  const tokenFromLink = (link: string) => new URL(link).searchParams.get("token")!;

  it("says nothing about unknown addresses", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.mailer.passwordResets).toHaveLength(0);

    // …and the answer is byte-identical for an address that does exist.
    const known = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { email: register.email },
    });
    expect(known.statusCode).toBe(204);
    expect(known.body).toBe(res.body);
    expect(ctx.mailer.passwordResets).toHaveLength(1);
  });

  it("resets the password, kills existing sessions, and burns the token", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const oldLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: register,
    });
    const oldCookie = oldLogin.cookies.find((c) => c.name === "fp_refresh")!.value;

    await ctx.app.inject({
      method: "POST",
      url: "/auth/password/forgot",
      payload: { email: register.email.toUpperCase() },
    });
    const sent = ctx.mailer.passwordResets[0]!;
    expect(sent.to).toBe(register.email);
    expect(sent.link).toContain("http://localhost:5173/reset?token=");

    const token = tokenFromLink(sent.link);
    const reset = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token, password: "brand-new-password" },
    });
    expect(reset.statusCode).toBe(200);

    // Old password is dead, new one works.
    const stale = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    expect(stale.statusCode).toBe(401);
    const fresh = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: register.email, password: "brand-new-password" },
    });
    expect(fresh.statusCode).toBe(200);

    // Sessions minted before the reset are gone.
    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: oldCookie },
    });
    expect(refreshed.statusCode).toBe(401);

    // Single use.
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token, password: "another-password" },
    });
    expect(replay.statusCode).toBe(422);
    expect(replay.json().error.code).toBe("invalid_token");
  });

  it("rejects expired, unknown and too-short resets", async () => {
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const user = await ctx.store.getUserByEmail(register.email);
    await ctx.store.createPasswordResetToken({
      token: "stale-token",
      userId: user!.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const expired = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token: "stale-token", password: "brand-new-password" },
    });
    expect(expired.statusCode).toBe(422);
    expect(expired.json().error.code).toBe("invalid_token");

    const unknown = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token: "never-issued", password: "brand-new-password" },
    });
    expect(unknown.statusCode).toBe(422);

    const short = await ctx.app.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token: "whatever", password: "short" },
    });
    expect(short.statusCode).toBe(422);

    // The original password still works — none of that changed anything.
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    expect(login.statusCode).toBe(200);
  });
});

describe("oidc sign-in", () => {
  const claims = { sub: "idp-user-1", email: "Sso@Example.com", name: "SSO Person" };

  it("is off by default and the routes 404 with it", async () => {
    const ctx = makeApp();
    const meta = await ctx.app.inject({ method: "GET", url: "/auth/oidc/meta" });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toEqual({ enabled: false }); // nothing else leaks

    for (const url of ["/auth/oidc/login", "/auth/oidc/callback?code=x&state=y"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("oidc_disabled");
    }
  });

  it("advertises the provider once configured", async () => {
    const ctx = makeOidcApp(claims);
    const meta = await ctx.app.inject({ method: "GET", url: "/auth/oidc/meta" });
    expect(meta.json()).toEqual({ enabled: true, issuer: "https://idp.example.com" });
  });

  it("redirects to the provider with state + PKCE and stashes both in cookies", async () => {
    const ctx = makeOidcApp(claims);
    const res = await ctx.app.inject({ method: "GET", url: "/auth/oidc/login" });
    expect(res.statusCode).toBe(302);

    const target = new URL(res.headers.location as string);
    expect(target.origin + target.pathname).toBe("https://idp.example.com/authorize");
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("client_id")).toBe("finance-planner");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("scope")).toContain("openid");
    const state = target.searchParams.get("state")!;

    const stateCookie = res.cookies.find((c) => c.name === "fp_oidc_state")!;
    const verifierCookie = res.cookies.find((c) => c.name === "fp_oidc_verifier")!;
    expect(stateCookie.httpOnly).toBe(true);
    expect(verifierCookie.httpOnly).toBe(true);
    // Signed, so the value on the wire is not the bare state.
    expect(stateCookie.value).not.toBe(state);
    expect(stateCookie.value).toContain(state);
  });

  it("creates an account on first sign-in and issues a refresh cookie", async () => {
    const ctx = makeOidcApp(claims);
    const start = await ctx.app.inject({ method: "GET", url: "/auth/oidc/login" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const cookies = Object.fromEntries(start.cookies.map((c) => [c.name, c.value]));

    const res = await ctx.app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=auth-code&state=${state}`,
      cookies,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:5173");
    expect(res.cookies.find((c) => c.name === "fp_refresh")).toBeDefined();

    // The code was exchanged with the PKCE verifier we minted, not the challenge.
    expect(ctx.oidcClient.exchanged).toHaveLength(1);
    expect(ctx.oidcClient.exchanged[0]!.code).toBe("auth-code");
    expect(ctx.oidcClient.exchanged[0]!.verifier).toBeTruthy();

    const user = await ctx.store.getUserByEmail("sso@example.com");
    expect(user).not.toBeNull();
    expect(user!.passwordHash).toBeNull(); // no local password for IdP accounts
    expect(user!.displayName).toBe("SSO Person");
    expect(user!.emailVerified).toBe(true);

    // The handshake cookies are spent.
    const stateCookie = res.cookies.find((c) => c.name === "fp_oidc_state");
    expect(stateCookie?.value).toBe("");

    // The refresh cookie is a normal session.
    const refresh = res.cookies.find((c) => c.name === "fp_refresh")!;
    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { fp_refresh: refresh.value },
    });
    expect(refreshed.statusCode).toBe(200);
  });

  it("links to the existing local account with the same email", async () => {
    const ctx = makeOidcApp({ ...claims, email: register.email });
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const before = await ctx.store.getUserByEmail(register.email);

    const start = await ctx.app.inject({ method: "GET", url: "/auth/oidc/login" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=auth-code&state=${state}`,
      cookies: Object.fromEntries(start.cookies.map((c) => [c.name, c.value])),
    });
    expect(res.statusCode).toBe(302);

    const after = await ctx.store.getUserByEmail(register.email);
    expect(after!.id).toBe(before!.id); // linked, not duplicated
    expect(after!.passwordHash).toBe(before!.passwordHash); // local password untouched
    expect(after!.displayName).toBe("User"); // the IdP doesn't rename people
  });

  it("skips our TOTP step-up — the identity provider owns MFA", async () => {
    const ctx = makeOidcApp({ ...claims, email: register.email });
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload: register });
    const login = await ctx.app.inject({ method: "POST", url: "/auth/login", payload: register });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };
    await enrolTotp(ctx.app, auth);

    const start = await ctx.app.inject({ method: "GET", url: "/auth/oidc/login" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=auth-code&state=${state}`,
      cookies: Object.fromEntries(start.cookies.map((c) => [c.name, c.value])),
    });
    // Straight to the app with a session, no second factor asked for.
    expect(res.statusCode).toBe(302);
    expect(res.cookies.find((c) => c.name === "fp_refresh")).toBeDefined();
    // Password logins are unaffected: still stepped up.
    const passwordLogin = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: register,
    });
    expect(passwordLogin.json().totpRequired).toBe(true);
  });

  it("rejects a mismatched, missing or unsigned state (403) without creating anyone", async () => {
    const ctx = makeOidcApp(claims);
    const start = await ctx.app.inject({ method: "GET", url: "/auth/oidc/login" });
    const cookies = Object.fromEntries(start.cookies.map((c) => [c.name, c.value]));

    const mismatch = await ctx.app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=auth-code&state=someone-elses-state",
      cookies,
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error.code).toBe("invalid_state");

    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const noCookies = await ctx.app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=auth-code&state=${state}`,
    });
    expect(noCookies.statusCode).toBe(403);

    // A forged (unsigned) state cookie doesn't pass either.
    const forged = await ctx.app.inject({
      method: "GET",
      url: "/auth/oidc/callback?code=auth-code&state=forged",
      cookies: { fp_oidc_state: "forged", fp_oidc_verifier: cookies.fp_oidc_verifier! },
    });
    expect(forged.statusCode).toBe(403);

    expect(await ctx.store.getUserByEmail("sso@example.com")).toBeNull();
    expect(ctx.oidcClient.exchanged).toHaveLength(0);
  });

  it("refuses a provider that won't share an email (403)", async () => {
    const ctx = makeOidcApp({ sub: "idp-user-2" });
    const start = await ctx.app.inject({ method: "GET", url: "/auth/oidc/login" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=auth-code&state=${state}`,
      cookies: Object.fromEntries(start.cookies.map((c) => [c.name, c.value])),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("email_required");
  });
});

describe("account settings + erasure", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("toggles the email digest opt-in and reflects it on /auth/me", async () => {
    const auth = await registerAndLogin(ctx.app);

    const before = await ctx.app.inject({ method: "GET", url: "/auth/me", headers: auth });
    expect(before.json().notifyEmail).toBe(false);

    const on = await ctx.app.inject({
      method: "PATCH",
      url: "/auth/me",
      headers: auth,
      payload: { notifyEmail: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().notifyEmail).toBe(true);
    expect(on.json().email).toBe(register.email); // the full me payload comes back

    const after = await ctx.app.inject({ method: "GET", url: "/auth/me", headers: auth });
    expect(after.json().notifyEmail).toBe(true);
    expect((await ctx.store.listUsersWithNotifications()).map((u) => u.email)).toEqual([
      register.email,
    ]);

    const off = await ctx.app.inject({
      method: "PATCH",
      url: "/auth/me",
      headers: auth,
      payload: { notifyEmail: false },
    });
    expect(off.json().notifyEmail).toBe(false);
    expect(await ctx.store.listUsersWithNotifications()).toEqual([]);
  });

  it("rejects a nonsense settings body (422) and an unauthenticated one (401)", async () => {
    const auth = await registerAndLogin(ctx.app);
    const bad = await ctx.app.inject({
      method: "PATCH",
      url: "/auth/me",
      headers: auth,
      payload: { notifyEmail: "yes please" },
    });
    expect(bad.statusCode).toBe(422);
    const anon = await ctx.app.inject({
      method: "PATCH",
      url: "/auth/me",
      payload: { notifyEmail: true },
    });
    expect(anon.statusCode).toBe(401);
  });

  it("erases the account (and its data) once the password is proven", async () => {
    const auth = await registerAndLogin(ctx.app);
    const user = (await ctx.store.getUserByEmail(register.email))!;
    const account = await ctx.store.createAccount({
      ownerUserId: user.id,
      name: "Everyday",
      currency: "GBP",
    });
    const household = await ctx.store.createHousehold("Home", user.id);

    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/me",
      headers: auth,
      payload: { password: register.password },
    });
    expect(res.statusCode).toBe(204);
    // The refresh cookie is cleared on the way out.
    expect(res.cookies.find((c) => c.name === "fp_refresh")?.value).toBe("");

    expect(await ctx.store.getUserById(user.id)).toBeNull();
    expect(await ctx.store.getAccount(account.id)).toBeNull();
    expect(await ctx.store.getHousehold(household.id)).toBeNull();
    // The token outlived the account; the routes say so rather than 500ing.
    const after = await ctx.app.inject({ method: "GET", url: "/auth/me", headers: auth });
    expect(after.statusCode).toBe(404);
  });

  it("refuses erasure on a wrong password, and leaves the account standing", async () => {
    const auth = await registerAndLogin(ctx.app);
    const user = (await ctx.store.getUserByEmail(register.email))!;
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/me",
      headers: auth,
      payload: { password: "not-my-password" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("invalid_credentials");
    expect(await ctx.store.getUserById(user.id)).not.toBeNull();
  });

  it("erases a passwordless (SSO) account without checking the password", async () => {
    // Holding a valid access token is the proof: there is no local password to
    // re-check, and the identity provider already vouched for them.
    const sso = await ctx.store.createUser({
      email: "sso@example.com",
      passwordHash: null,
      displayName: "SSO",
    });
    const token = await signAccessToken(env.jwtSecret, { sub: sso.id, email: sso.email });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "ignored" },
    });
    expect(res.statusCode).toBe(204);
    expect(await ctx.store.getUserById(sso.id)).toBeNull();
  });

  it("rejects erasure without a token (401) or without a password field (422)", async () => {
    const auth = await registerAndLogin(ctx.app);
    const anon = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/me",
      payload: { password: "x" },
    });
    expect(anon.statusCode).toBe(401);
    const empty = await ctx.app.inject({
      method: "DELETE",
      url: "/auth/me",
      headers: auth,
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
  });
});

/** The rest of the suite builds apps with `rateLimit: false`. These build it
 *  *on*, because the only evidence that the throttle is wired is a request that
 *  comes back 429 — asserting that the plugin is registered passes against code
 *  where the plugin never sees a single route. */
function makeThrottledApp() {
  const store = new MemoryStore();
  const mailer = new LogMailer();
  const app = buildServer({ store, mailer, env });
  return { app, store, mailer };
}

describe("rate limiting", () => {
  it("throttles /auth/register at 3 requests per window, with headers", async () => {
    const { app, store } = makeThrottledApp();
    // The route's rate-limit hook is installed by an onRoute hook that only sees
    // routes declared after the plugin has booted. Registering the routes in a
    // child plugin is what puts them on the right side of that boot; this test
    // fails with a 201 if they ever move back.
    const attempt = (n: number) =>
      app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: `rl${n}@example.com`, password: "password123", displayName: "RL" },
      });

    const first = await attempt(1);
    const second = await attempt(2);
    const third = await attempt(3);
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 201]);
    // The allowance counts down over the accepted requests.
    expect(first.headers["x-ratelimit-limit"]).toBe("3");
    expect(first.headers["x-ratelimit-remaining"]).toBe("2");
    expect(third.headers["x-ratelimit-remaining"]).toBe("0");

    const fourth = await attempt(4);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers["x-ratelimit-limit"]).toBe("3");
    expect(fourth.headers["x-ratelimit-remaining"]).toBe("0");
    // Both the reset and the retry-after are seconds remaining in the window.
    expect(Number(fourth.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
    expect(Number(fourth.headers["retry-after"])).toBeGreaterThan(0);
    expect(fourth.json().error.code).toBe("rate_limited");
    // The throttled request must not have created the user it was refused: the
    // limiter runs as an onRequest hook, ahead of the handler.
    expect(await store.getUserByEmail("rl4@example.com")).toBeNull();

    await app.close();
  });

  it("throttles login, password reset and the OIDC callback too", async () => {
    // Every credential-guessing surface in the service, not just register.
    const { app } = makeThrottledApp();
    /** Send `max + 1` requests — one more than the route allows — and report
     *  the status of the last one. */
    const flood = async (
      method: "GET" | "POST",
      url: string,
      max: number,
      payload?: Record<string, string>,
    ): Promise<number> => {
      let status = 0;
      for (let i = 0; i <= max; i++) {
        const res = await app.inject({ method, url, payload });
        status = res.statusCode;
      }
      return status;
    };
    // /auth/login is 5/min; /auth/password/forgot is 3/min. Neither depends on
    // the credentials being valid — the throttle runs before the handler, so
    // these come back 401/200 until the limit and 429 after it.
    expect(await flood("POST", "/auth/login", 5, { email: "a@b.co", password: "nope12345" })).toBe(
      429,
    );
    expect(await flood("POST", "/auth/password/forgot", 3, { email: "a@b.co" })).toBe(429);
    // The OIDC callback is a GET at 20/min and carries its state in the query.
    expect(await flood("GET", "/auth/oidc/callback?code=x&state=y", 20)).toBe(429);

    await app.close();
  });

  it("answers a malformed body with the status it means, not a 500", async () => {
    // The same defect the throttle had, one layer down: the limiter refuses by
    // throwing an error that carries `statusCode`, and an error handler that
    // reads only its own HttpError turns every such refusal into a server
    // fault. Malformed JSON is the cheapest way to hold that behaviour still.
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
    await app.close();
  });

  it("leaves the throttle off when a caller opts out", async () => {
    // What the rest of the suite relies on: back-to-back logins must not trip it.
    const { app } = makeApp();
    await app.inject({ method: "POST", url: "/auth/register", payload: register });
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: register });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});
