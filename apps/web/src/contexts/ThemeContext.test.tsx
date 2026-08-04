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
      <button type="button" onClick={() => setTheme("light")}>
        force light
      </button>
    </>
  );
}

/** A `prefers-color-scheme` stub with a working listener, so `system` can be
 *  driven both ways. jsdom's own matchMedia always answers "no". */
function stubPrefersLight(light: boolean): (next: boolean) => void {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = light;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query.includes("light") ? matches : !matches;
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
  it("starts dark and stamps the root attribute", () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: "theme dark" })).toBeInTheDocument();
    expect(attribute()).toBe("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("cycles dark → light → system → dark, dropping the attribute for system", () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    const toggle = (): HTMLElement => screen.getByRole("button", { name: /^theme / });

    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent("theme light");
    expect(attribute()).toBe("light");

    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent("theme system");
    // No attribute in system mode: the stylesheet's media query answers instead.
    expect(attribute()).toBeNull();

    fireEvent.click(toggle());
    expect(toggle()).toHaveTextContent("theme dark");
    expect(attribute()).toBe("dark");
  });

  it("persists the choice", () => {
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: /^theme / }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it.each<Theme>(["light", "system"])("restores a stored %s session", (stored) => {
    localStorage.setItem(THEME_STORAGE_KEY, stored);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: `theme ${stored}` })).toBeInTheDocument();
    expect(attribute()).toBe(stored === "system" ? null : stored);
  });

  it("falls back to dark rather than the OS when nothing is stored", () => {
    stubPrefersLight(true);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    // Light is opt-in this release: an unset preference must not drift into it.
    expect(attribute()).toBe("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "puce");
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(attribute()).toBe("dark");
  });

  describe("system", () => {
    it("resolves against the OS preference", () => {
      stubPrefersLight(true);
      localStorage.setItem(THEME_STORAGE_KEY, "system");
      render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      );
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    });

    it("follows the OS changing under it", () => {
      const setPrefersLight = stubPrefersLight(false);
      localStorage.setItem(THEME_STORAGE_KEY, "system");
      render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      );
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");

      act(() => setPrefersLight(true));
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    });

    it("keeps an explicit choice regardless of the OS", () => {
      stubPrefersLight(true);
      render(
        <ThemeProvider>
          <Consumer />
        </ThemeProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "force light" }));
      expect(attribute()).toBe("light");
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    });
  });

  it("takes the attribute with it when the app unmounts", () => {
    const view = render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    expect(attribute()).toBe("dark");
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
    expect(attribute()).toBe("light");

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("leaves the page in the default theme outside a provider rather than throwing", () => {
    render(<Consumer />);
    expect(screen.getByRole("button", { name: "theme dark" })).toBeInTheDocument();
    expect(attribute()).toBeNull();
  });
});
