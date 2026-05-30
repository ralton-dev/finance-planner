import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { UserDto } from "../lib/types.js";

type Status = "loading" | "authed" | "anon";

interface AuthValue {
  user: UserDto | null;
  status: Status;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    // Attempt to restore a session from the refresh cookie.
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
      setUser(res.user);
      setStatus("authed");
    },
    async register(email, password, displayName) {
      await api.register({ email, password, displayName });
      const res = await api.login({ email, password });
      setUser(res.user);
      setStatus("authed");
    },
    async logout() {
      await api.logout();
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
