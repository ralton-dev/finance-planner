import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { UserDto } from "../lib/types.js";

type Status = "loading" | "authed" | "anon";

/** What a password login settled on: a session, or a pending second factor. */
export type LoginOutcome = { totpRequired: false } | { totpRequired: true; pendingToken: string };

interface AuthValue {
  user: UserDto | null;
  status: Status;
  /** Resolves with `totpRequired: true` when the account needs a second factor;
   *  the caller holds the pending token in component state and finishes with
   *  completeTotpLogin(). It is deliberately never persisted. */
  login: (email: string, password: string) => Promise<LoginOutcome>;
  completeTotpLogin: (factor: {
    pendingToken: string;
    code?: string;
    recoveryCode?: string;
  }) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function seedDemoIfEnabled(): Promise<void> {
  try {
    const meta = await api.meta();
    if (meta.demoSeedEnabled) await api.seedDemo();
  } catch {
    // Registration should still succeed if a deployment has no seed, or if the
    // profile stopped being empty between login and seed.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    // Attempt to restore a session from the refresh cookie.
    //
    // This runs unconditionally — no flag in localStorage gates it — which is
    // what makes the SSO round-trip work: the provider callback lands the
    // browser back on the SPA with nothing but a refresh cookie set, and this
    // silent refresh is what turns that cookie into a logged-in session.
    (async () => {
      if (await api.tryRefresh()) {
        try {
          setUser(await api.me());
          setStatus("authed");
          return;
        } catch {
          /* fall through */
        }
      }
      setStatus("anon");
    })();
  }, []);

  const value: AuthValue = {
    user,
    status,
    async login(email, password) {
      const res = await api.login({ email, password });
      if ("totpRequired" in res) return { totpRequired: true, pendingToken: res.pendingToken };
      setUser(res.user);
      setStatus("authed");
      return { totpRequired: false };
    },
    async completeTotpLogin(factor) {
      const res = await api.loginTotp(factor);
      setUser(res.user);
      setStatus("authed");
    },
    async register(email, password, displayName) {
      await api.register({ email, password, displayName });
      const res = await api.login({ email, password });
      // A brand-new account cannot have 2FA yet, so this is always a session.
      if ("totpRequired" in res) throw new Error("unexpected 2FA challenge after registration");
      await seedDemoIfEnabled();
      setUser(res.user);
      setStatus("authed");
    },
    async logout() {
      // Ending the session locally must not hinge on the server call. The token
      // is often already dead by the time we get here — an expired session, or
      // an account that has just deleted itself — and staying "logged in" in
      // front of a dead token would be worse than a missed revocation.
      // api.logout() drops the access token in its own `finally` either way.
      try {
        await api.logout();
      } catch {
        /* already gone server-side */
      }
      setUser(null);
      setStatus("anon");
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
