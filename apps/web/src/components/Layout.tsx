import { type ReactNode } from "react";
import { Link, Navigate, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div>
      <header className="topbar">
        <Link to="/" className="brand">
          Finance Planner
        </Link>
        <nav>
          <Link to="/">Overview</Link>
          <Link to="/accounts">Accounts</Link>
        </nav>
        <div className="spacer" />
        <span className="muted">{user?.displayName}</span>
        <button
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
        >
          Log out
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <p className="content">Loading…</p>;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
