import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes as RouterRoutes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApiFetch, type Routes } from "../test/apiMock.js";
import { HouseholdHomePage } from "./HouseholdHomePage.js";

/**
 * The households tab is a household tab: it resolves to yours and goes there,
 * or offers the two ways in when you have none. Both journeys, plus the one
 * refusal a user can actually provoke.
 */

const me = (households: { id: string; name: string }[]) => ({
  body: { id: "u1", email: "ben@example.com", displayName: "Ben", households },
});

/** The landing, plus a marker page at the address it should redirect to. */
function renderPage(routes: Routes) {
  const stub = stubApiFetch(routes);
  render(
    <MemoryRouter initialEntries={["/households"]}>
      <RouterRoutes>
        <Route path="/households" element={<HouseholdHomePage />} />
        <Route path="/households/:id" element={<p>inside household</p>} />
      </RouterRoutes>
    </MemoryRouter>,
  );
  return stub;
}

describe("HouseholdHomePage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lands you inside your household rather than in a list of one", async () => {
    renderPage({ "GET /api/auth/me": me([{ id: "h1", name: "Home" }]) });
    expect(await screen.findByText("inside household")).toBeTruthy();
    // Nothing to choose between, so nothing that looks like a chooser.
    expect(screen.queryByText("Home")).toBeNull();
  });

  it("offers the two ways in when you are in none", async () => {
    renderPage({ "GET /api/auth/me": me([]) });
    expect(await screen.findByRole("heading", { name: /none yet/ })).toBeTruthy();
    expect(screen.getByLabelText("household name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ create" })).toBeTruthy();
    // The join half is honest about there being nothing to accept.
    expect(screen.getByText(/waiting to be added/)).toBeTruthy();
    expect(screen.getByText(/household at a time/i)).toBeTruthy();
  });

  it("goes straight into a household it has just founded", async () => {
    const stub = renderPage({
      "GET /api/auth/me": me([]),
      "POST /api/auth/households": { status: 201, body: { id: "h9", name: "Home" } },
    });
    await screen.findByLabelText("household name");
    await userEvent.type(screen.getByLabelText("household name"), "Home");
    await userEvent.click(screen.getByRole("button", { name: "+ create" }));

    expect(await screen.findByText("inside household")).toBeTruthy();
    expect(stub.bodyOf("POST /api/auth/households")).toEqual({ name: "Home" });
  });

  /**
   * The exclusivity rule reaching a person. The Store refuses a second
   * household as unprocessable and writes the message itself; the page shows
   * what it said rather than a shrug.
   */
  it("shows why a second household was refused", async () => {
    renderPage({
      "GET /api/auth/me": me([]),
      "POST /api/auth/households": {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message:
              "That user already belongs to a household; they must leave it before joining another.",
          },
        },
      },
    });
    await screen.findByLabelText("household name");
    await userEvent.type(screen.getByLabelText("household name"), "Second");
    await userEvent.click(screen.getByRole("button", { name: "+ create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already belongs to a household/);
  });

  it("says so plainly when it cannot read who you are", async () => {
    renderPage({ "GET /api/auth/me": { status: 500, body: { error: { code: "internal" } } } });
    expect(await screen.findByText(/could not read your household/)).toBeTruthy();
  });
});
