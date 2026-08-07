import { createHash, randomBytes } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import {
  addMemberBody,
  createHouseholdBody,
  deleteMeBody,
  forgotPasswordBody,
  type HealthResponse,
  loginBody,
  loginTotpBody,
  type ReadinessResponse,
  registerBody,
  resetPasswordBody,
  totpDisableBody,
  totpEnableBody,
  updateMemberRoleBody,
  updateMemberShareBody,
  updateMeBody,
} from "@finance-planner/contracts";
import { createStore, type Store, type User } from "@finance-planner/data";
import { createMailer, type Mailer } from "@finance-planner/mailer";
import { type AppAbility, buildAbility, subject } from "@finance-planner/policies";
import {
  buildOtpauthUri,
  generateTotpSecret,
  hashPassword,
  randomToken,
  sha256,
  signAccessToken,
  signPendingTotpToken,
  verifyAccessToken,
  verifyPassword,
  verifyPendingTotpToken,
  verifyTotp,
} from "@finance-planner/security";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { type AuthEnv, loadEnv, type OidcEnv } from "./env.js";
import { HttpOidcClient, type OidcClient } from "./oidc.js";
import { generateRecoveryCode, normaliseRecoveryCode, RECOVERY_CODE_COUNT } from "./recovery.js";

const SERVICE = "auth";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();
const REFRESH_COOKIE = "fp_refresh";
const OIDC_STATE_COOKIE = "fp_oidc_state";
const OIDC_VERIFIER_COOKIE = "fp_oidc_verifier";
/** How long the browser has to finish the SSO round-trip, in seconds. */
const OIDC_HANDSHAKE_TTL_SECONDS = 600;
/** How long the "password accepted, second factor owed" ticket lives. */
const PENDING_TTL_SECONDS = 300;
/** How long an emailed password-reset link stays redeemable. */
const RESET_TTL_MS = 60 * 60 * 1000;
/**
 * How long after we rotate a refresh token the superseded one may still be
 * presented before we call it theft. Browser tabs share one cookie, and a page
 * whose access token has just expired 401s on several requests at once — so
 * concurrent presentations of the same token are ordinary traffic, not attack
 * traffic. Kept short: outside it, reuse detection is as strict as ever.
 */
const ROTATION_GRACE_MS = 10_000;
/** How far a straggler may be chased along the rotation chain (the winner can
 *  itself have rotated again while the straggler was in flight). */
const ROTATION_CHAIN_MAX = 8;

export interface AuthDeps {
  store?: Store;
  mailer?: Mailer;
  env?: AuthEnv;
  /** Injected in tests so the OIDC flow can run without a real provider. */
  oidcClient?: OidcClient;
  /**
   * Opt out of rate-limiting. Defaults to on — omitting this throttles, so a
   * new caller (and production) is limited by default rather than by remembering.
   *
   * Most of the suite passes false: `inject()` gives every request the same IP,
   * so a test that logs in five times over would trip a per-IP throttle that no
   * real user would ever see. That opt-out is kept, but it is also how this
   * service shipped a rate limiter that throttled nothing for as long as it did
   * — every test disabled the thing under test, so the fact that it was wired
   * to no routes at all was invisible. The standing repair is the "rate
   * limiting" block in server.test.ts, which builds the server with the
   * throttle ON and drives a real route past its limit. If you add a route
   * whose limit matters, add it there; a test that merely asserts the plugin is
   * registered passes against a server that throttles nothing.
   */
  rateLimit?: boolean;
  /**
   * Wall clock in milliseconds. Injected so tests can step over the refresh
   * rotation grace window instead of sleeping through it.
   */
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Shape of a zod issue, duck-typed so `zod` needn't be a direct dependency. */
interface ZodIssue {
  path?: (string | number)[];
  message: string;
}

/** Flatten a validation failure into one readable line. */
function validationMessage(err: Error & { issues?: ZodIssue[] }): string {
  if (!Array.isArray(err.issues)) return err.message;
  return err.issues
    .map((i) => (i.path?.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

export function buildServer(deps: AuthDeps = {}): FastifyInstance {
  const env = deps.env ?? loadEnv();
  const handle = deps.store
    ? { store: deps.store, close: async () => {} }
    : createStore(env.databaseUrl);
  const store = handle.store;
  const now = deps.now ?? Date.now;
  // SSO is off unless an injected client or a fully-configured provider says so.
  const oidcClient = deps.oidcClient ?? (env.oidc ? new HttpOidcClient(env.oidc) : undefined);

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  // Built after the app so the log-only mailer can write through the service
  // logger rather than raw stdout.
  const mailer = deps.mailer ?? createMailer(env, (msg) => app.log.info(msg));
  // The signing secret lets the OIDC handshake cookies be tamper-evident.
  app.register(fastifyCookie, { secret: env.jwtSecret });
  // Rate-limit gate. `global: false` means only the routes that carry a
  // `config.rateLimit` are throttled — `rl()` below decides which, and at what.
  //
  // On an exceeded limit the plugin sets its `x-ratelimit-*` headers and then
  // throws a bare Error carrying `statusCode`. This service's error handler
  // reads `HttpError` and nothing else, so that bare Error would be flattened
  // to a 500 and the 429 would never reach the caller. Building an HttpError
  // here keeps the status *and* puts the refusal in the service's own
  // `{ error: { code, message } }` envelope, like every other refusal.
  if (deps.rateLimit !== false) {
    app.register(fastifyRateLimit, {
      global: false,
      errorResponseBuilder: (_req, ctx) =>
        new HttpError(
          ctx.statusCode,
          ctx.ban ? "rate_limit_banned" : "rate_limited",
          `Too many requests, retry in ${ctx.after}`,
        ),
    });
  }
  app.decorate("mailer", mailer);
  app.addHook("onClose", async () => handle.close());

  app.setErrorHandler((err: Error & { validation?: unknown; issues?: ZodIssue[] }, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    // Both Fastify's own schema validation and a rejected zod body schema mean
    // the same thing to a caller: you sent something we can't use.
    if (err.validation || err.name === "ZodError") {
      return reply
        .code(422)
        .send({ error: { code: "validation_error", message: validationMessage(err) } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "Internal error" } });
  });

  const authenticate = async (req: FastifyRequest): Promise<string> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "unauthorized", "Missing bearer token");
    }
    try {
      const claims = await verifyAccessToken(env.jwtSecret, header.slice(7));
      return claims.sub;
    } catch {
      throw new HttpError(401, "unauthorized", "Invalid token");
    }
  };

  /** Build the caller's per-request ability from their household memberships. */
  const abilityFor = async (userId: string): Promise<AppAbility> => {
    const households = await store.listHouseholdsForUser(userId);
    const ctx = await Promise.all(
      households.map(async (h) => {
        const m = await store.getMembership(h.id, userId);
        return { id: h.id, role: m?.role ?? "member" };
      }),
    );
    return buildAbility({ userId, accountAccess: [], households: ctx });
  };

  const setRefreshCookie = (reply: FastifyReply, token: string): void => {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: env.cookieSecure,
      path: env.cookiePath,
      maxAge: env.refreshTtlDays * 24 * 60 * 60,
    });
  };

  /** Drop the refresh cookie. The attributes must match setRefreshCookie's — a
   *  clear that differs on SameSite/Secure/Path names a *different* cookie, and
   *  the real one survives the "logout". */
  const clearRefreshCookie = (reply: FastifyReply): void => {
    reply.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: env.cookieSecure,
      path: env.cookiePath,
    });
  };

  /** Both halves of a new session: the access token for the caller, and the
   *  refresh token the cookie now carries (which /auth/refresh remembers for
   *  the grace window). */
  const issueSession = async (
    reply: FastifyReply,
    userId: string,
    email: string,
  ): Promise<{ accessToken: string; refreshToken: string }> => {
    const refresh = randomToken();
    const expiresAt = new Date(now() + env.refreshTtlDays * 86_400_000).toISOString();
    await store.createSession({ userId, refreshTokenHash: sha256(refresh), expiresAt });
    setRefreshCookie(reply, refresh);
    return {
      accessToken: await signAccessToken(
        env.jwtSecret,
        { sub: userId, email },
        env.accessTtlSeconds,
      ),
      refreshToken: refresh,
    };
  };

  /** The session a spent refresh token was rotated into. */
  interface Rotation {
    refreshToken: string;
    userId: string;
    email: string;
  }

  /**
   * Refresh tokens rotated — or being rotated right now — within the last
   * ROTATION_GRACE_MS, keyed by the hash of the token that was spent.
   *
   * The value is the *promise* of the replacement, not the replacement, which
   * is what makes simultaneous presentations safe: two requests carrying the
   * same cookie land microseconds apart, and the second must wait for the
   * first's new session rather than read a half-rotated one and cry theft.
   *
   * Purely in-process and self-pruning: nothing here outlives the grace window.
   * A race split across replicas therefore still falls to the strict path — no
   * worse than before, and the client's own single-flight refresh keeps one tab
   * from racing itself. Closing that last gap would need the successor recorded
   * on the session row, i.e. a migration.
   */
  const rotations = new Map<string, { at: number; replacement: Promise<Rotation | null> }>();

  /** Claim a token's rotation. The promise is settled by whoever claimed it —
   *  with null if their refresh turned out to fail. */
  const claimRotation = (): {
    promise: Promise<Rotation | null>;
    settle: (r: Rotation | null) => void;
  } => {
    let settle!: (r: Rotation | null) => void;
    const promise = new Promise<Rotation | null>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  };

  /** Housekeeping: drop everything past the window, so a hit afterwards is
   *  inside the grace period by construction. */
  const pruneRotations = (nowMs: number): void => {
    for (const [hash, rotated] of rotations) {
      if (nowMs - rotated.at > ROTATION_GRACE_MS) rotations.delete(hash);
    }
  };

  /**
   * The session a straggler should be handed back, or null when the presented
   * token is a replay we have no business honouring.
   *
   * Follows the rotation chain, because the tab that won the race may have
   * rotated again while the straggler was in flight. Whatever the chain ends at
   * is checked against the store, so a session killed in the meantime — logout,
   * password reset, account deletion, an earlier theft sweep — can never be
   * resurrected here.
   */
  const rotationReplay = async (
    entry: { replacement: Promise<Rotation | null> },
    nowMs: number,
  ): Promise<Rotation | null> => {
    let rotation = await entry.replacement;
    for (let hop = 0; rotation && hop < ROTATION_CHAIN_MAX; hop++) {
      const next = rotations.get(sha256(rotation.refreshToken));
      if (!next) break;
      rotation = await next.replacement;
    }
    if (!rotation) return null;
    const successor = await store.getSessionByTokenHash(sha256(rotation.refreshToken));
    if (!successor || successor.revokedAt) return null;
    if (new Date(successor.expiresAt) < new Date(nowMs)) return null;
    return rotation;
  };

  /** The one place a login succeeds: password, second factor and SSO all land
   *  here, so the session + response shape can never drift between them. */
  const completeLogin = async (reply: FastifyReply, user: User): Promise<FastifyReply> => {
    const { accessToken } = await issueSession(reply, user.id, user.email);
    return reply.send({
      accessToken,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    });
  };

  /** Load the caller, or 404 if the token outlived the account. */
  const requireUser = async (userId: string): Promise<User> => {
    const user = await store.getUserById(userId);
    if (!user) throw new HttpError(404, "not_found", "User not found");
    return user;
  };

  /**
   * Spend a recovery code. The stored hashes are salted scrypt, so we can't
   * look one up — verify the presented code against each unused hash, then burn
   * the row that matched.
   */
  const consumeRecoveryCode = async (userId: string, presented: string): Promise<boolean> => {
    const candidate = normaliseRecoveryCode(presented);
    if (!candidate) return false;
    for (const stored of await store.listUnusedRecoveryCodes(userId)) {
      if (verifyPassword(candidate, stored.codeHash)) {
        return store.consumeRecoveryCode(userId, stored.codeHash);
      }
    }
    return false;
  };

  // Every route below is declared inside `after()` rather than inline, and that
  // is load-bearing. `register()` above only *queues* the rate-limit plugin;
  // avvio does not run it until `ready()`. But `app.post(...)` fires its
  // `onRoute` hooks immediately — so a route declared inline is declared before
  // the plugin has installed the very hook that reads its `config.rateLimit`.
  // The config is then read by nobody and the limit silently never applies,
  // which is exactly what this service shipped: correct `rl()` numbers on every
  // sensitive route and zero requests actually throttled.
  //
  // `after()` is the join point — it runs once everything registered before it
  // has booted. Note this stays on the root instance rather than an
  // encapsulated child plugin, so the decorators, the error handler and the
  // cookie plugin resolve exactly as they did when these routes were inline.
  app.after(() => {
    // ---- health ----
    app.get("/healthz", async (): Promise<HealthResponse> => ({
      status: "ok",
      service: SERVICE,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }));
    app.get("/readyz", async (): Promise<ReadinessResponse> => ({ ready: true, checks: {} }));

    /** Per-route rate-limit config, or empty when the caller opted out. The
     *  plugin is registered with `global: false`, so omitting the config is the
     *  same as no limit — which also means a route that forgets `rl()` is
     *  silently unthrottled, and nothing will tell you. */
    const rl = (max: number) =>
      deps.rateLimit === false ? {} : { config: { rateLimit: { max, timeWindow: "1 minute" } } };

    // ---- register ----
    app.post("/auth/register", rl(3), async (req, reply) => {
      const body = registerBody.parse(req.body);
      if (await store.getUserByEmail(body.email)) {
        throw new HttpError(409, "email_taken", "Email already registered");
      }
      const user = await store.createUser({
        email: body.email,
        passwordHash: hashPassword(body.password),
        displayName: body.displayName,
      });
      const token = randomToken();
      await store.createEmailVerificationToken({
        token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await mailer.sendVerificationEmail(user.email, token);
      return reply.code(201).send({ userId: user.id });
    });

    // ---- verify email ----
    app.post("/auth/verify-email", async (req) => {
      const { token } = req.body as { token?: string };
      if (!token) throw new HttpError(422, "validation_error", "token required");
      const record = await store.consumeEmailVerificationToken(token);
      if (!record || new Date(record.expiresAt) < new Date()) {
        throw new HttpError(400, "invalid_token", "Invalid or expired token");
      }
      await store.setUserVerified(record.userId);
      return { verified: true };
    });

    // ---- login ----
    app.post("/auth/login", rl(5), async (req, reply) => {
      const body = loginBody.parse(req.body);
      const user = await store.getUserByEmail(body.email);
      if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
        throw new HttpError(401, "invalid_credentials", "Invalid email or password");
      }
      // Two-factor users get a ticket, not a session: no cookie is set and no
      // access token is minted until /auth/login/totp succeeds.
      if (user.totpEnabledAt) {
        const pendingToken = await signPendingTotpToken(
          env.jwtSecret,
          { sub: user.id, email: user.email },
          PENDING_TTL_SECONDS,
        );
        return reply.send({ totpRequired: true, pendingToken });
      }
      return completeLogin(reply, user);
    });

    // ---- login: second factor ----
    app.post("/auth/login/totp", rl(10), async (req, reply) => {
      const body = loginTotpBody.parse(req.body);
      let claims: { sub: string };
      try {
        claims = await verifyPendingTotpToken(env.jwtSecret, body.pendingToken);
      } catch {
        throw new HttpError(401, "invalid_pending_token", "Sign in again to continue");
      }
      const user = await store.getUserById(claims.sub);
      if (!user?.totpEnabledAt || !user.totpSecret) {
        throw new HttpError(401, "unauthorized", "Two-factor is not enabled for this account");
      }
      const accepted = body.code
        ? verifyTotp(user.totpSecret, body.code, Date.now())
        : await consumeRecoveryCode(user.id, body.recoveryCode!);
      if (!accepted) {
        throw new HttpError(401, "invalid_code", "That code didn't match");
      }
      return completeLogin(reply, user);
    });

    // ---- two-factor enrolment ----
    /** Stage a secret. Nothing is enforced until /auth/totp/enable proves a code,
     *  so an abandoned setup leaves the account exactly as it was. */
    app.post("/auth/totp/setup", rl(10), async (req) => {
      const user = await requireUser(await authenticate(req));
      if (user.totpEnabledAt) {
        throw new HttpError(409, "totp_already_enabled", "Two-factor is already enabled");
      }
      const secret = generateTotpSecret();
      await store.setUserTotpSecret(user.id, secret);
      return { secret, otpauthUri: buildOtpauthUri(secret, user.email) };
    });

    /** Prove the staged secret, then hand back the recovery codes — the only time
     *  they are ever shown in the clear. */
    app.post("/auth/totp/enable", rl(10), async (req) => {
      const user = await requireUser(await authenticate(req));
      const body = totpEnableBody.parse(req.body);
      if (user.totpEnabledAt) {
        throw new HttpError(409, "totp_already_enabled", "Two-factor is already enabled");
      }
      if (!user.totpSecret) {
        throw new HttpError(409, "totp_not_started", "Start with /auth/totp/setup");
      }
      if (!verifyTotp(user.totpSecret, body.code, Date.now())) {
        throw new HttpError(422, "invalid_code", "That code didn't match");
      }
      await store.enableUserTotp(user.id);
      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
      await store.replaceRecoveryCodes(user.id, recoveryCodes.map(hashPassword));
      return { enabled: true, recoveryCodes };
    });

    /** Turn two-factor off. Accepts a live code or an unused recovery code, so a
     *  lost phone isn't a lost account. */
    app.post("/auth/totp/disable", rl(10), async (req) => {
      const user = await requireUser(await authenticate(req));
      const body = totpDisableBody.parse(req.body);
      if (!user.totpEnabledAt || !user.totpSecret) {
        throw new HttpError(409, "totp_not_enabled", "Two-factor is not enabled");
      }
      const accepted =
        verifyTotp(user.totpSecret, body.code, Date.now()) ||
        (await consumeRecoveryCode(user.id, body.code));
      if (!accepted) {
        throw new HttpError(422, "invalid_code", "That code didn't match");
      }
      await store.setUserTotpSecret(user.id, null); // also clears totpEnabledAt
      await store.replaceRecoveryCodes(user.id, []);
      return { enabled: false };
    });

    // ---- password reset ----
    /** Always 204, whether or not the address is known — the response must not
     *  tell a stranger which emails have accounts. */
    app.post("/auth/password/forgot", rl(3), async (req, reply) => {
      const body = forgotPasswordBody.parse(req.body);
      const user = await store.getUserByEmail(body.email);
      // SSO-only accounts have no password to reset; silently do nothing.
      if (user?.passwordHash) {
        const token = randomToken();
        await store.createPasswordResetToken({
          token,
          userId: user.id,
          expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
        });
        await mailer.sendPasswordReset(user.email, `${env.publicWebUrl}/reset?token=${token}`);
      }
      return reply.code(204).send();
    });

    app.post("/auth/password/reset", rl(5), async (req) => {
      const body = resetPasswordBody.parse(req.body);
      const record = await store.consumePasswordResetToken(body.token);
      if (!record || new Date(record.expiresAt) < new Date()) {
        throw new HttpError(422, "invalid_token", "Invalid or expired reset token");
      }
      await store.updateUserPassword(record.userId, hashPassword(body.password));
      // A reset is also a "kick everyone out" — whoever prompted it may be logged in.
      await store.revokeAllUserSessions(record.userId);
      return { reset: true };
    });

    // ---- refresh ----
    app.post("/auth/refresh", rl(20), async (req, reply) => {
      const refresh = req.cookies[REFRESH_COOKIE];
      if (!refresh) throw new HttpError(401, "unauthorized", "Missing refresh token");
      const nowMs = now();
      const hash = sha256(refresh);
      pruneRotations(nowMs);

      // Claim this token's rotation, synchronously — no `await` between the read
      // and the write — so two requests carrying the same cookie can never both
      // believe they are first. A token *we* rotated moments ago is a race, not a
      // theft: tabs share one cookie, and a page's requests all 401 together the
      // instant an access token expires. The straggler gets the same session the
      // winner got; revoking the lot here is what signed people out everywhere.
      const inflight = rotations.get(hash);
      const claim = inflight ? null : claimRotation();
      if (claim) rotations.set(hash, { at: nowMs, replacement: claim.promise });

      if (inflight) {
        const replay = await rotationReplay(inflight, nowMs);
        if (replay) {
          setRefreshCookie(reply, replay.refreshToken);
          return reply.send({
            accessToken: await signAccessToken(
              env.jwtSecret,
              { sub: replay.userId, email: replay.email },
              env.accessTtlSeconds,
            ),
          });
        }
        // That rotation failed, or its session has since been ended. Fall through
        // and let the store say why.
      }

      try {
        const session = await store.getSessionByTokenHash(hash);
        if (!session) throw new HttpError(401, "unauthorized", "Invalid refresh token");
        if (new Date(session.expiresAt) < new Date(nowMs)) {
          throw new HttpError(401, "unauthorized", "Refresh token expired");
        }
        // Revoked, with no rotation of ours to account for it: an attacker has
        // captured a previously-rotated cookie. Nuke every active session for
        // this user — they'll have to re-login.
        if (session.revokedAt) {
          await store.revokeAllUserSessions(session.userId);
          clearRefreshCookie(reply);
          throw new HttpError(401, "reuse_detected", "Refresh token reused; sessions revoked");
        }
        await store.revokeSession(session.id); // rotation
        const user = await store.getUserById(session.userId);
        if (!user) throw new HttpError(401, "unauthorized", "Unknown user");
        const { accessToken, refreshToken } = await issueSession(reply, user.id, user.email);
        claim?.settle({ refreshToken, userId: user.id, email: user.email });
        return reply.send({ accessToken });
      } catch (err) {
        // Nothing to replay: release the claim so the next attempt starts clean.
        // Only ours — a slow enough failure can have been pruned and re-claimed.
        if (claim) {
          if (rotations.get(hash)?.replacement === claim.promise) rotations.delete(hash);
          claim.settle(null);
        }
        throw err;
      }
    });

    // ---- logout ----
    app.post("/auth/logout", async (req, reply) => {
      const refresh = req.cookies[REFRESH_COOKIE];
      if (refresh) {
        const session = await store.getSessionByTokenHash(sha256(refresh));
        if (session) await store.revokeSession(session.id);
      }
      clearRefreshCookie(reply);
      return reply.send({ ok: true });
    });

    // ---- me ----
    /** The caller's own profile. One shape, built once, so GET and PATCH can
     *  never drift. */
    const mePayload = async (user: User) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      totpEnabled: !!user.totpEnabledAt,
      notifyEmail: user.notifyEmail,
      households: await store.listHouseholdsForUser(user.id),
    });

    app.get("/auth/me", async (req) => mePayload(await requireUser(await authenticate(req))));

    /** Change a setting on your own account. Only the digest opt-in for now. */
    app.patch("/auth/me", async (req) => {
      const userId = await authenticate(req);
      await requireUser(userId);
      const body = updateMeBody.parse(req.body);
      await store.setUserNotifyEmail(userId, body.notifyEmail);
      return mePayload(await requireUser(userId));
    });

    /**
     * Erase the account. Takes everything that is the caller's alone — owned
     * accounts and their history, projects, households they founded, their
     * memberships elsewhere, sessions and tokens. Accounts merely shared *with*
     * them survive; they are their owners'.
     *
     * The password is re-checked only for accounts that have one. An SSO-only
     * user has no local password to prove, and the identity provider already
     * vouched for them to get the access token they are holding — so holding a
     * valid token IS the proof, and the body's `password` is ignored. (Sending
     * `{"password":""}` fails schema validation, so those callers send any
     * non-empty placeholder; requiring a fresh re-auth window instead was
     * considered and rejected as more machinery than the risk warrants.)
     */
    app.delete("/auth/me", rl(3), async (req, reply) => {
      const userId = await authenticate(req);
      const user = await requireUser(userId);
      const body = deleteMeBody.parse(req.body);
      if (user.passwordHash && !verifyPassword(body.password, user.passwordHash)) {
        throw new HttpError(403, "invalid_credentials", "Password does not match");
      }
      await store.deleteUserCascade(userId);
      clearRefreshCookie(reply);
      return reply.code(204).send();
    });

    // ---- OIDC single sign-on ----
    /**
     * Deliberate decision: OIDC logins skip our TOTP step-up. The identity
     * provider owns multi-factor for accounts it authenticates — re-challenging
     * here would only prove the user still has *our* authenticator, which says
     * nothing about the session the IdP just vouched for. Local password logins
     * are unaffected and still step up.
     */
    const requireOidc = (): { client: OidcClient; config: OidcEnv } => {
      if (!oidcClient || !env.oidc) {
        throw new HttpError(404, "oidc_disabled", "Single sign-on is not configured");
      }
      return { client: oidcClient, config: env.oidc };
    };

    const setHandshakeCookie = (reply: FastifyReply, name: string, value: string): void => {
      reply.setCookie(name, value, {
        httpOnly: true,
        sameSite: "lax", // the provider redirects back cross-site; strict would drop it
        secure: env.cookieSecure,
        signed: true,
        path: env.cookiePath,
        maxAge: OIDC_HANDSHAKE_TTL_SECONDS,
      });
    };

    const readHandshakeCookie = (req: FastifyRequest, name: string): string | null => {
      const raw = req.cookies[name];
      if (!raw) return null;
      const unsigned = req.unsignCookie(raw);
      return unsigned.valid ? unsigned.value : null;
    };

    const clearHandshakeCookies = (reply: FastifyReply): void => {
      reply.clearCookie(OIDC_STATE_COOKIE, { path: env.cookiePath });
      reply.clearCookie(OIDC_VERIFIER_COOKIE, { path: env.cookiePath });
    };

    /** What the SPA asks before deciding whether to draw a "Sign in with…" button. */
    app.get("/auth/oidc/meta", async () =>
      oidcClient && env.oidc ? { enabled: true, issuer: env.oidc.issuer } : { enabled: false },
    );

    /** Start the handshake: PKCE verifier + state into signed cookies, user to
     *  the provider. */
    app.get("/auth/oidc/login", rl(20), async (_req, reply) => {
      const { client, config } = requireOidc();
      const { authorizationEndpoint } = await client.discover();
      const state = randomBytes(16).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      setHandshakeCookie(reply, OIDC_STATE_COOKIE, state);
      setHandshakeCookie(reply, OIDC_VERIFIER_COOKIE, verifier);

      const params = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const separator = authorizationEndpoint.includes("?") ? "&" : "?";
      return reply.redirect(`${authorizationEndpoint}${separator}${params.toString()}`, 302);
    });

    /** Provider hands the code back here. Validate state, exchange, verify the
     *  id_token, then land the browser on the SPA with a refresh cookie set. */
    app.get("/auth/oidc/callback", rl(20), async (req, reply) => {
      const { client } = requireOidc();
      const query = req.query as { code?: string; state?: string };
      const expectedState = readHandshakeCookie(req, OIDC_STATE_COOKIE);
      const verifier = readHandshakeCookie(req, OIDC_VERIFIER_COOKIE);
      clearHandshakeCookies(reply); // one handshake per pair of cookies, win or lose

      if (!query.code || !query.state || !expectedState || !verifier) {
        throw new HttpError(403, "invalid_state", "Sign-in request expired; try again");
      }
      if (query.state !== expectedState) {
        throw new HttpError(403, "invalid_state", "Sign-in state mismatch");
      }

      const { idToken } = await client.exchangeCode(query.code, verifier);
      const claims = await client.verifyIdToken(idToken);
      const email = claims.email?.trim().toLowerCase();
      if (!email) {
        throw new HttpError(403, "email_required", "Your provider did not share an email address");
      }

      let user = await store.getUserByEmail(email);
      if (!user) {
        // First sight of this address: create a passwordless account. It can be
        // given a local password later via the forgot-password flow.
        user = await store.createUser({
          email,
          passwordHash: null,
          displayName: claims.name?.trim() || email.split("@")[0]!,
        });
        // The provider vouched for the address unless it explicitly said otherwise.
        if (claims.emailVerified !== false) await store.setUserVerified(user.id);
      }

      await issueSession(reply, user.id, user.email);
      return reply.redirect(env.publicWebUrl, 302);
    });

    // ---- households ----
    app.get("/auth/households", async (req) => {
      const userId = await authenticate(req);
      return store.listHouseholdsForUser(userId);
    });

    app.post("/auth/households", async (req, reply) => {
      const userId = await authenticate(req);
      const body = createHouseholdBody.parse(req.body);
      const household = await store.createHousehold(body.name, userId);
      return reply.code(201).send(household);
    });

    app.post("/auth/households/:id/members", async (req, reply) => {
      const userId = await authenticate(req);
      const { id } = req.params as { id: string };
      const body = addMemberBody.parse(req.body);
      const ability = await abilityFor(userId);
      const ref = subject("Household", { id });
      if (!ability.hasAnyAccess(ref)) {
        throw new HttpError(404, "not_found", "Household not found");
      }
      if (!ability.can("manage_members", ref)) {
        throw new HttpError(403, "forbidden", "Only household admins can add members");
      }
      const invitee = await store.getUserByEmail(body.email);
      if (!invitee) throw new HttpError(404, "not_found", "No user with that email");
      if (await store.getMembership(id, invitee.id)) {
        throw new HttpError(409, "already_member", "That user is already a member");
      }
      const added = await store.addMembership(id, invitee.id, body.role);
      return reply.code(201).send(added);
    });

    /** Return household + members + shared accounts in one payload. The caller
     *  must be a member; non-members get a 404 (not 403) to avoid leaking
     *  household existence. */
    app.get("/auth/households/:id", async (req) => {
      const userId = await authenticate(req);
      const { id } = req.params as { id: string };
      const membership = await store.getMembership(id, userId);
      if (!membership) throw new HttpError(404, "not_found", "Household not found");
      const household = await store.getHousehold(id);
      if (!household) throw new HttpError(404, "not_found", "Household not found");

      const members = await store.listMembersForHousehold(id);
      const memberDtos = await Promise.all(
        members.map(async (m) => {
          const user = await store.getUserById(m.userId);
          return {
            membershipId: m.id,
            userId: m.userId,
            role: m.role,
            shareBp: m.contributionShareBp,
            displayName: user?.displayName ?? "(unknown)",
            email: user?.email ?? "",
            isSelf: m.userId === userId,
          };
        }),
      );

      const shares = await store.listSharesForHousehold(id);
      const shareDtos = await Promise.all(
        shares.map(async (sh) => {
          const account = await store.getAccount(sh.accountId);
          return {
            shareId: sh.id,
            accountId: sh.accountId,
            accountName: account?.name ?? "(unknown account)",
            currency: account?.currency ?? "",
            permission: sh.permission,
          };
        }),
      );

      return {
        id: household.id,
        name: household.name,
        createdAt: household.createdAt,
        yourRole: membership.role,
        members: memberDtos,
        shares: shareDtos,
      };
    });

    app.delete("/auth/households/:id/members/:userId", async (req, reply) => {
      const callerId = await authenticate(req);
      const { id, userId: targetUserId } = req.params as { id: string; userId: string };
      const ability = await abilityFor(callerId);
      const ref = subject("Household", { id });
      if (!ability.hasAnyAccess(ref)) {
        throw new HttpError(404, "not_found", "Household not found");
      }
      // Anyone can leave; only admins/owners can remove others.
      if (targetUserId !== callerId && !ability.can("manage_members", ref)) {
        throw new HttpError(403, "forbidden", "Only household admins can remove members");
      }
      const target = await store.getMembership(id, targetUserId);
      if (!target) throw new HttpError(404, "not_found", "Membership not found");
      if (target.role === "owner" && targetUserId !== callerId) {
        throw new HttpError(403, "forbidden", "Cannot remove the household owner");
      }
      await store.removeMember(id, targetUserId);
      return reply.code(204).send();
    });

    /** Promote / demote a member between admin and member. Owner-only — admins
     *  cannot grant or revoke the admin badge. Owners themselves are not
     *  promotable from this endpoint (ownership is the founding role). */
    app.patch("/auth/households/:id/members/:userId", async (req) => {
      const callerId = await authenticate(req);
      const { id, userId: targetUserId } = req.params as { id: string; userId: string };
      const body = updateMemberRoleBody.parse(req.body);
      const ability = await abilityFor(callerId);
      const ref = subject("Household", { id });
      if (!ability.hasAnyAccess(ref)) {
        throw new HttpError(404, "not_found", "Household not found");
      }
      if (!ability.can("change_roles", ref)) {
        throw new HttpError(403, "forbidden", "Only the household owner can change roles");
      }
      const target = await store.getMembership(id, targetUserId);
      if (!target) throw new HttpError(404, "not_found", "Membership not found");
      if (target.role === "owner") {
        throw new HttpError(403, "forbidden", "Cannot change the owner's role");
      }
      const updated = await store.updateMembershipRole(id, targetUserId, body.role);
      if (!updated) throw new HttpError(404, "not_found", "Membership not found");
      return updated;
    });

    /** Set a member's proportional contribution share (basis points). This drives
     *  how shared household costs are split, so it's an admin action like other
     *  member management. */
    app.patch("/auth/households/:id/members/:userId/share", async (req) => {
      const callerId = await authenticate(req);
      const { id, userId: targetUserId } = req.params as { id: string; userId: string };
      const body = updateMemberShareBody.parse(req.body);
      const ability = await abilityFor(callerId);
      const ref = subject("Household", { id });
      if (!ability.hasAnyAccess(ref)) {
        throw new HttpError(404, "not_found", "Household not found");
      }
      if (!ability.can("manage_members", ref)) {
        throw new HttpError(403, "forbidden", "Only household admins can set contribution shares");
      }
      const updated = await store.updateMembershipShare(id, targetUserId, body.shareBp);
      if (!updated) throw new HttpError(404, "not_found", "Membership not found");
      return updated;
    });

    /** Hard-delete a household. Owner-only. Removes all shares + memberships. */
    app.delete("/auth/households/:id", async (req, reply) => {
      const callerId = await authenticate(req);
      const { id } = req.params as { id: string };
      const ability = await abilityFor(callerId);
      const ref = subject("Household", { id });
      if (!ability.hasAnyAccess(ref)) {
        throw new HttpError(404, "not_found", "Household not found");
      }
      if (!ability.can("delete_household", ref)) {
        throw new HttpError(403, "forbidden", "Only the household owner can delete the household");
      }
      await store.deleteHousehold(id);
      return reply.code(204).send();
    });
  });

  return app;
}
