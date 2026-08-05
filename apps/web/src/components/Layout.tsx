import { type ReactNode, useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { usePrivacy } from "../contexts/PrivacyContext.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { type Theme, THEME_ORDER, useTheme } from "../contexts/ThemeContext.js";
import { useChordShortcuts } from "../lib/useChordShortcuts.js";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { openPayment, openIncome, openAccount } = useQuickAdd();
  const { hidden, toggle: togglePrivacy } = usePrivacy();
  const { theme, cycle: cycleTheme } = useTheme();

  // On mobile the sidebar collapses behind a burger toggle. Following a link
  // (which changes the route) closes it again so it never covers the content.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [location.pathname]);

  // Two-key chord shortcuts, mirroring the hints shown next to each item.
  useChordShortcuts({
    g: {
      h: () => navigate("/"),
      a: () => navigate("/accounts"),
      p: () => navigate("/projects"),
      s: () => navigate("/households"),
      f: () => navigate("/flow"),
      ",": () => navigate("/settings"),
    },
    n: {
      p: () => openPayment(),
      i: () => openIncome(),
      a: () => openAccount(),
    },
    // "h a" — hide amounts. Its own leader so it never fights g/n.
    h: {
      a: togglePrivacy,
    },
    // "t t" — theme, next one along.
    t: {
      t: cycleTheme,
    },
  });

  return (
    <div className="app">
      <div className="mobile-bar">
        <span className="mobile-brand">
          <span className="brand-dot" />
          finance-planner
        </span>
        <ThemeToggle theme={theme} onCycle={cycleTheme} className="nav-toggle" />
        <PrivacyToggle hidden={hidden} onToggle={togglePrivacy} className="nav-toggle" />
        <button
          type="button"
          className="nav-toggle"
          aria-label={navOpen ? "close navigation" : "open navigation"}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((open) => !open)}
        >
          {navOpen ? "✕" : "☰"}
        </button>
      </div>

      <aside id="app-sidebar" className={navOpen ? "sidebar open" : "sidebar"}>
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
        {/* Singular: the tab goes straight into your one household. `end` is
            deliberately absent, so the link stays lit on /households/:id — the
            address the redirect actually lands on. */}
        <NavLink to="/households" className={navClass}>
          <span className="label">household</span>
          <span className="kbd-ish">g s</span>
        </NavLink>
        <NavLink to="/flow" className={navClass}>
          <span className="label">money flow</span>
          <span className="kbd-ish">g f</span>
        </NavLink>
        <NavLink to="/settings" className={navClass}>
          <span className="label">settings</span>
          <span className="kbd-ish">g ,</span>
        </NavLink>

        <div className="nav-section">view</div>
        <button
          type="button"
          className={hidden ? "nav-item active" : "nav-item"}
          aria-pressed={hidden}
          onClick={togglePrivacy}
        >
          <span className="label">
            <span aria-hidden="true" className="privacy-eye">
              {hidden ? "◌" : "◉"}
            </span>{" "}
            {hidden ? "show amounts" : "hide amounts"}
          </span>
          <span className="kbd-ish">h a</span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-label={themeActionLabel(theme)}
          onClick={cycleTheme}
        >
          <span className="label">
            <span aria-hidden="true" className="theme-mark">
              {THEME_MARK[theme]}
            </span>{" "}
            theme {theme}
          </span>
          <span className="kbd-ish">t t</span>
        </button>

        <div className="nav-section">quick add</div>
        <button
          type="button"
          className="nav-item"
          onClick={() => {
            openPayment();
            setNavOpen(false);
          }}
        >
          <span className="label">new payment</span>
          <span className="kbd-ish">n p</span>
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={() => {
            openIncome();
            setNavOpen(false);
          }}
        >
          <span className="label">new income</span>
          <span className="kbd-ish">n i</span>
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={() => {
            openAccount();
            setNavOpen(false);
          }}
        >
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

/** One glyph per mode: filled for dark, hollow for light, half for "ask the
 *  machine". */
const THEME_MARK: Record<Theme, string> = { dark: "●", light: "○", system: "◑" };

/** A three-way cycle has no honest `aria-pressed`, so the label says where the
 *  next press lands — read off `THEME_ORDER` rather than restated here, which
 *  is how it came to promise the wrong stop when the order changed. */
function themeActionLabel(theme: Theme): string {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
  return `theme ${theme} — switch to ${next}`;
}

/** Dark, light, or whatever the OS says. In the mobile bar as well as the
 *  sidebar: the sidebar is collapsed exactly when the room's lighting is least
 *  likely to be the one the app was set up in. */
function ThemeToggle({
  theme,
  onCycle,
  className,
}: {
  theme: Theme;
  onCycle: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={themeActionLabel(theme)}
      title={themeActionLabel(theme)}
      onClick={onCycle}
    >
      {THEME_MARK[theme]}
    </button>
  );
}

/** The eye. Present in the mobile bar too, because the sidebar it lives in is
 *  collapsed exactly when someone is most likely reading over your shoulder. */
function PrivacyToggle({
  hidden,
  onToggle,
  className,
}: {
  hidden: boolean;
  onToggle: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-pressed={hidden}
      aria-label={hidden ? "show amounts" : "hide amounts"}
      title={hidden ? "show amounts" : "hide amounts"}
      onClick={onToggle}
    >
      {hidden ? "◌" : "◉"}
    </button>
  );
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
  // A diagram's scope is a set of accounts the reader chose, which the status
  // bar cannot name in a word — and must not call a household, because it very
  // often is not one.
  if (pathname === "/flow") return "account-set";
  if (pathname === "/projects") return "projects";
  if (pathname.startsWith("/projects/")) return "project";
  // Both spellings of the same place: /households resolves to yours, and there
  // is only ever one of them.
  if (pathname.startsWith("/households")) return "household";
  return pathname.slice(1);
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <p className="main">loading…</p>;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
