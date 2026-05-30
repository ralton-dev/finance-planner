import { type ReactNode } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { openPayment, openIncome, openAccount } = useQuickAdd();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          finance-planner
          <span className="brand-version">v1</span>
        </div>

        <div className="nav-section">workspace</div>
        <NavLink to="/" end className={navClass}>
          <span className="label">today</span>
          <span className="kbd-ish">g h</span>
        </NavLink>
        <NavLink to="/accounts" className={navClass}>
          <span className="label">accounts</span>
          <span className="kbd-ish">g a</span>
        </NavLink>
        <NavLink to="/projects" className={navClass}>
          <span className="label">projects</span>
          <span className="kbd-ish">g p</span>
        </NavLink>
        <NavLink to="/households" className={navClass}>
          <span className="label">households</span>
          <span className="kbd-ish">g s</span>
        </NavLink>

        <div className="nav-section">quick add</div>
        <button type="button" className="nav-item" onClick={() => openPayment()}>
          <span className="label">new payment</span>
          <span className="kbd-ish">n p</span>
        </button>
        <button type="button" className="nav-item" onClick={() => openIncome()}>
          <span className="label">new income</span>
          <span className="kbd-ish">n i</span>
        </button>
        <button type="button" className="nav-item" onClick={() => openAccount()}>
          <span className="label">new account</span>
          <span className="kbd-ish">n a</span>
        </button>

        <div className="sidebar-foot">
          <div className="row">
            <span>command palette</span>
            <span>⌘K</span>
          </div>
          <div className="row">
            <span>session</span>
            <b>{user?.displayName ?? "—"}</b>
          </div>
          <button
            type="button"
            className="logout"
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
          >
            log out
          </button>
        </div>
      </aside>

      <main className="main">
        <StatusBar />
        <Outlet />
      </main>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? "nav-item active" : "nav-item";
}

function StatusBar() {
  const location = useLocation();
  const today = new Date().toISOString().slice(0, 10);
  const scope = scopeFromPath(location.pathname);
  return (
    <div className="statusbar">
      <span>
        <span className="statusbar-dot" />
        connected
      </span>
      <span className="spacer" />
      <span>
        scope <b>{scope}</b>
      </span>
      <span>
        as-of <b>{today}</b>
      </span>
    </div>
  );
}

function scopeFromPath(pathname: string): string {
  if (pathname === "/") return "all-accounts";
  if (pathname.startsWith("/accounts/")) return "account";
  if (pathname === "/accounts") return "accounts";
  if (pathname === "/projects") return "projects";
  if (pathname.startsWith("/projects/")) return "project";
  if (pathname === "/households") return "households";
  return pathname.slice(1);
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <p className="main">loading…</p>;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
