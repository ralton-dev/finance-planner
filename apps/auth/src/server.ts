import fastifyCookie from "@fastify/cookie";
import {
  addMemberBody,
  createHouseholdBody,
  type HealthResponse,
  loginBody,
  type ReadinessResponse,
  registerBody,
} from "@finance-planner/contracts";
import { createStore, type Store } from "@finance-planner/data";
import {
  hashPassword,
  randomToken,
  sha256,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from "@finance-planner/security";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { type AuthEnv, loadEnv } from "./env.js";
import { LogMailer, type Mailer } from "./mailer.js";

const SERVICE = "auth";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();
const REFRESH_COOKIE = "fp_refresh";

export interface AuthDeps {
  store?: Store;
  mailer?: Mailer;
  env?: AuthEnv;
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

export function buildServer(deps: AuthDeps = {}): FastifyInstance {
  const env = deps.env ?? loadEnv();
  const handle = deps.store
    ? { store: deps.store, close: async () => {} }
    : createStore(env.databaseUrl);
  const store = handle.store;
  const mailer = deps.mailer ?? new LogMailer();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.register(fastifyCookie);
  app.decorate("mailer", mailer);
  app.addHook("onClose", async () => handle.close());

  app.setErrorHandler((err: Error & { validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(422).send({ error: { code: "validation_error", message: err.message } });
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

  const setRefreshCookie = (reply: FastifyReply, token: string): void => {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: env.cookieSecure,
      path: "/auth",
      maxAge: env.refreshTtlDays * 24 * 60 * 60,
    });
  };

  const issueSession = async (
    reply: FastifyReply,
    userId: string,
    email: string,
  ): Promise<string> => {
    const refresh = randomToken();
    const expiresAt = new Date(Date.now() + env.refreshTtlDays * 86_400_000).toISOString();
    await store.createSession({ userId, refreshTokenHash: sha256(refresh), expiresAt });
    setRefreshCookie(reply, refresh);
    return signAccessToken(env.jwtSecret, { sub: userId, email }, env.accessTtlSeconds);
  };

  // ---- health ----
  app.get(
    "/healthz",
    async (): Promise<HealthResponse> => ({
      status: "ok",
      service: SERVICE,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );
  app.get("/readyz", async (): Promise<ReadinessResponse> => ({ ready: true, checks: {} }));

  // ---- register ----
  app.post("/auth/register", async (req, reply) => {
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
  app.post("/auth/login", async (req, reply) => {
    const body = loginBody.parse(req.body);
    const user = await store.getUserByEmail(body.email);
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      throw new HttpError(401, "invalid_credentials", "Invalid email or password");
    }
    const accessToken = await issueSession(reply, user.id, user.email);
    return reply.send({
      accessToken,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    });
  });

  // ---- refresh ----
  app.post("/auth/refresh", async (req, reply) => {
    const refresh = req.cookies[REFRESH_COOKIE];
    if (!refresh) throw new HttpError(401, "unauthorized", "Missing refresh token");
    const session = await store.getSessionByTokenHash(sha256(refresh));
    if (!session || session.revokedAt || new Date(session.expiresAt) < new Date()) {
      throw new HttpError(401, "unauthorized", "Invalid refresh token");
    }
    await store.revokeSession(session.id); // rotation
    const user = await store.getUserById(session.userId);
    if (!user) throw new HttpError(401, "unauthorized", "Unknown user");
    const accessToken = await issueSession(reply, user.id, user.email);
    return reply.send({ accessToken });
  });

  // ---- logout ----
  app.post("/auth/logout", async (req, reply) => {
    const refresh = req.cookies[REFRESH_COOKIE];
    if (refresh) {
      const session = await store.getSessionByTokenHash(sha256(refresh));
      if (session) await store.revokeSession(session.id);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
    return reply.send({ ok: true });
  });

  // ---- me ----
  app.get("/me", async (req) => {
    const userId = await authenticate(req);
    const user = await store.getUserById(userId);
    if (!user) throw new HttpError(404, "not_found", "User not found");
    const households = await store.listHouseholdsForUser(userId);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      households,
    };
  });

  // ---- households ----
  app.get("/households", async (req) => {
    const userId = await authenticate(req);
    return store.listHouseholdsForUser(userId);
  });

  app.post("/households", async (req, reply) => {
    const userId = await authenticate(req);
    const body = createHouseholdBody.parse(req.body);
    const household = await store.createHousehold(body.name, userId);
    return reply.code(201).send(household);
  });

  app.post("/households/:id/members", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const body = addMemberBody.parse(req.body);
    const membership = await store.getMembership(id, userId);
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      throw new HttpError(403, "forbidden", "Only household admins can add members");
    }
    const invitee = await store.getUserByEmail(body.email);
    if (!invitee) throw new HttpError(404, "not_found", "No user with that email");
    const added = await store.addMembership(id, invitee.id, body.role);
    return reply.code(201).send(added);
  });

  return app;
}
