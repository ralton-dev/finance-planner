import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { PrivacyProvider } from "../contexts/PrivacyContext.js";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY, ThemeProvider } from "../contexts/ThemeContext.js";
import { stubApiFetch } from "../test/apiMock.js";
import { Layout } from "./Layout.js";

function renderLayout() {
  stubApiFetch({
    "POST /api/auth/refresh": { body: { accessToken: "t" } },
    "GET /api/auth/me": { body: { id: "u1", email: "ben@example.com", displayName: "Ben" } },
  });
  return render(
    <ThemeProvider>
      <PrivacyProvider>
        <QuickAddProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route
                element={
                  <AuthProvider>
                    <Layout />
                  </AuthProvider>
                }
              >
                <Route path="/" element={<p>page</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QuickAddProvider>
      </PrivacyProvider>
    </ThemeProvider>,
  );
}

/** The sidebar item, not the compact one in the mobile bar. */
const sidebarToggle = (): HTMLElement =>
  screen.getAllByRole("button", { name: /^theme (dark|light|system) — switch to/ })[1]!;

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe("Layout theme toggle", () => {
  it("shows the current theme and walks to the next one", async () => {
    renderLayout();
    await waitFor(() => expect(screen.getByText("page")).toBeInTheDocument());

    // A fresh session follows the machine, so nothing is stamped yet.
    expect(sidebarToggle()).toHaveTextContent("theme system");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBeNull();

    fireEvent.click(sidebarToggle());
    expect(sidebarToggle()).toHaveTextContent("theme light");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    fireEvent.click(sidebarToggle());
    expect(sidebarToggle()).toHaveTextContent("theme dark");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("names the next stop so a three-way cycle has an honest label", async () => {
    renderLayout();
    await waitFor(() => expect(screen.getByText("page")).toBeInTheDocument());
    expect(sidebarToggle()).toHaveAccessibleName("theme system — switch to light");
  });

  it("keeps a copy in the mobile bar, where the sidebar is collapsed", async () => {
    renderLayout();
    await waitFor(() => expect(screen.getByText("page")).toBeInTheDocument());

    const mobile = screen.getAllByRole("button", { name: /^theme system — switch to/ })[0]!;
    fireEvent.click(mobile);
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });

  it("leaves the privacy toggle alone", async () => {
    renderLayout();
    await waitFor(() => expect(screen.getByText("page")).toBeInTheDocument());

    fireEvent.click(sidebarToggle());
    expect(screen.getAllByRole("button", { name: "hide amounts" })[0]).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
