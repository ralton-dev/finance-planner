import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

/** Where the choice lives between sessions. */
export const THEME_STORAGE_KEY = "fp.theme";
/** Attribute stamped on the document root; the stylesheet does the rest. */
export const THEME_ATTRIBUTE = "data-theme";

/** What the user picked. `system` defers to the OS. */
export type Theme = "dark" | "light" | "system";
/** What that comes out as — the two the stylesheet actually paints. */
export type ResolvedTheme = "dark" | "light";

/** The order the toggle walks: the default first, then the two ways of
 *  overriding it. `system` leads because `system` is where everyone starts;
 *  light before dark after it, because that is the order the two are named in
 *  everywhere else in the app. */
export const THEME_ORDER: readonly Theme[] = ["system", "light", "dark"];

interface ThemeValue {
  /** The stored choice, including `system`. */
  theme: Theme;
  /** `system` resolved against the OS preference; never `system` itself. */
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** system → light → dark → system. */
  cycle: () => void;
}

/**
 * Default value rather than a throwing hook: a chart or a page rendered outside
 * the provider (a test, the login screen) should render in the default theme,
 * not crash. `resolved` is light because that is what `system` comes out as
 * absent any signal to the contrary — the same answer `:root` gives.
 */
const ThemeContext = createContext<ThemeValue>({
  theme: "system",
  resolved: "light",
  setTheme: () => {},
  cycle: () => {},
});

const isTheme = (value: string | null): value is Theme =>
  value === "dark" || value === "light" || value === "system";

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    // `system` is the default: an unset — or corrupt — preference follows the
    // machine. It is also the one default that cannot flash, because it stamps
    // no attribute at all: `:root` (light) and its
    // `@media (prefers-color-scheme: dark)` override answer the first paint on
    // their own, before any script has run.
    return isTheme(stored) ? stored : "system";
  } catch {
    // Private-mode Safari and friends: no persistence, still a working toggle.
    return "system";
  }
}

/** The OS preference, when the browser will say. Asked as "is it dark?" to
 *  match the stylesheet, which carries light in `:root` and overrides it under
 *  `@media (prefers-color-scheme: dark)`. */
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
 * Theme mode: dark, light, or whatever the machine is set to — the last of
 * which is where a new install starts. One attribute on the document root swaps
 * the whole token set — instant, no reload, and it reaches the drawers and the
 * command palette, which render outside the page tree. Persisted so it survives
 * a refresh.
 *
 * An explicit choice outranks the OS in both directions, because
 * `:root[data-theme="…"]` is (0,2,0) against the media block's (0,1,0).
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
