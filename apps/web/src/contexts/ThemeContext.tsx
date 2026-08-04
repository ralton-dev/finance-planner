import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

/** Where the choice lives between sessions. */
export const THEME_STORAGE_KEY = "fp.theme";
/** Attribute stamped on the document root; the stylesheet does the rest. */
export const THEME_ATTRIBUTE = "data-theme";

/** What the user picked. `system` defers to the OS. */
export type Theme = "dark" | "light" | "system";
/** What that comes out as — the two the stylesheet actually paints. */
export type ResolvedTheme = "dark" | "light";

/** The order the toggle walks: the two explicit choices, then "whatever the
 *  machine says". Light leads because light is the default — so from a fresh
 *  install dark is exactly one click away. */
export const THEME_ORDER: readonly Theme[] = ["light", "dark", "system"];

interface ThemeValue {
  /** The stored choice, including `system`. */
  theme: Theme;
  /** `system` resolved against the OS preference; never `system` itself. */
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** light → dark → system → light. */
  cycle: () => void;
}

/**
 * Default value rather than a throwing hook: a chart or a page rendered outside
 * the provider (a test, the login screen) should render in the default theme,
 * not crash.
 */
const ThemeContext = createContext<ThemeValue>({
  theme: "light",
  resolved: "light",
  setTheme: () => {},
  cycle: () => {},
});

const isTheme = (value: string | null): value is Theme =>
  value === "dark" || value === "light" || value === "system";

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    // Light is the default now. An unset (or corrupt) preference still resolves
    // to a fixed theme rather than falling through to the OS: `system` is a
    // choice you make, not one you inherit, and the stylesheet's `:root` block
    // has to agree with whatever this returns or the first paint flashes.
    return isTheme(stored) ? stored : "light";
  } catch {
    // Private-mode Safari and friends: no persistence, still a working toggle.
    return "light";
  }
}

/** The OS preference, when the browser will say. Asked as "is it dark?" to
 *  match the stylesheet, which now carries light in `:root` and overrides it
 *  under `@media (prefers-color-scheme: dark)`. */
function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * `system` leaves the attribute off so the stylesheet's
 * `@media (prefers-color-scheme: dark)` block can answer; anything else stamps
 * it, which outranks that block in both directions.
 */
function stamp(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, theme);
}

/**
 * Theme mode: dark, light, or whatever the machine is set to. One attribute on
 * the document root swaps the whole token set — instant, no reload, and it
 * reaches the drawers and the command palette, which render outside the page
 * tree. Persisted so it survives a refresh.
 *
 * Charts can't use `var()` (SVG presentation attributes don't take it), so they
 * read the resolved tokens through `useChartColors()`, which re-reads them off
 * this context. That's why `setTheme` writes the attribute itself rather than
 * leaving it to the effect: by the time a consumer re-renders, the DOM already
 * carries the new theme and the values it reads back are the new ones.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  useEffect(() => {
    stamp(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* no persistence available — the toggle still works for this session */
    }
  }, [theme]);

  // Watched even while an explicit theme is set, so picking `system` is right
  // immediately rather than after the next OS change.
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Unmount cleanup only, so the attribute never outlives the app (or a test).
  useEffect(() => () => document.documentElement.removeAttribute(THEME_ATTRIBUTE), []);

  const setTheme = useCallback((next: Theme) => {
    stamp(next);
    setThemeState(next);
  }, []);

  const cycle = useCallback(() => {
    setThemeState((current) => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]!;
      stamp(next);
      return next;
    });
  }, []);

  const resolved: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, cycle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
