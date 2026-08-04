import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type Theme,
  ThemeProvider,
  useTheme,
} from "./ThemeContext.js";

function Consumer() {
  const { theme, resolved, cycle, setTheme } = useTheme();
  return (
    <>
      <button type="button" onClick={cycle}>
        theme {theme}
      </button>
      <p data-testid="resolved">{resolved}</p>
      <button type="button" onClick={() => setTheme("dark")}>
        force dark
      </button>
    </>
  );
}

/** A `prefers-color-scheme` stub with a working listener, so `system` can be
 *  driven both ways. jsdom's own matchMedia always answers "no". */
function stubPrefersDark(dark: boolean): (next: boolean) => void {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = dark;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query.includes("dark") ? matches : !matches;
    },
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.delete(fn),
  }));
  return (next: boolean) => {
    matches = next;
    for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
  };
}

const attribute = (): string | null => document.documentElement.getAttribute(THEME_ATTRIBUTE);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe("ThemeProvider", () => {
  it("starts light and stamps the root attribute", () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: "theme light" })).toBeInTheDocument();
    expect(attribute()).toBe("light");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("cycles light → dark → system → light, dropping the attribute for system", () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    const toggle = (): HTMLElement => screen.getByRole("button", { name: /^theme / });

    // Dark is one click from a fresh install, which is the whole promise of
    // flipping the default.
    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent("theme dark");
    expect(attribute()).toBe("dark");

    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent("theme system");
    // No attribute in system mode: the stylesheet's media query answers instead.
    expect(attribute()).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent("theme light");
    expect(attribute()).toBe("light");
  });

  it("persists the choice", () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: /^theme / }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it.each<Theme>(["dark", "system"])("restores a stored %s session", (stored) => {
    localStorage.setItem(THEME_STORAGE_KEY, stored);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: `theme ${stored}` })).toBeInTheDocument();
    expect(attribute()).toBe(stored === "system" ? null : stored);
  });

  it("falls back to light rather than the OS when nothing is stored", () => {
    stubPrefersDark(true);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    // `system` is a choice you make, not one you inherit — and `:root` in the
    // stylesheet carries light, so anything else here would flash on first
    // paint.
    expect(attribute()).toBe("light");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "puce");
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(attribute()).toBe("light");
  });

  describe("system", () => {
    it("resolves against the OS preference", () => {
      stubPrefersDark(true);
      localStorage.setItem(THEME_STORAGE_KEY, "system");
      render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      );
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    });

    it("follows the OS changing under it", () => {
      const setPrefersDark = stubPrefersDark(false);
      localStorage.setItem(THEME_STORAGE_KEY, "system");
      render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      );
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");

      act(() => setPrefersDark(true));
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    });

    it("keeps an explicit choice regardless of the OS", () => {
      // The machine says light; the user says dark, and the user wins.
      stubPrefersDark(false);
      render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "force dark" }));
      expect(attribute()).toBe("dark");
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    });
  });

  it("takes the attribute with it when the app unmounts", () => {
    const view = render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(attribute()).toBe("light");
    view.unmount();
    expect(attribute()).toBeNull();
  });

  it("survives localStorage throwing, as private-mode Safari does", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^theme / }));
    // No persistence, but a working toggle for this session.
    expect(attribute()).toBe("dark");

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("leaves the page in the default theme outside a provider rather than throwing", () => {
    render(<Consumer />);
    expect(screen.getByRole("button", { name: "theme light" })).toBeInTheDocument();
    expect(attribute()).toBeNull();
  });
});
