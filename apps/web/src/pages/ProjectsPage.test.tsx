import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { api } from "../lib/api.js";
import type { ProjectDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { ProjectsPage } from "./ProjectsPage.js";

/**
 * The projects index, on the shape this page exists for: **a household of
 * two**.
 *
 * A lone user cannot tell "yours" from "shared with you", cannot exercise the
 * owner column, and is exactly the fixture shape that let five field-by-field
 * audits in this repository miss a live defect. Alice is the caller; Bob is the
 * co-member whose shared project reaches her list.
 */

const ALICE = "u-alice";
const BOB = "u-bob";

function project(partial: Partial<ProjectDto> & { id: string; name: string }): ProjectDto {
  return {
    ownerUserId: ALICE,
    description: null,
    color: null,
    targetDate: null,
    visibility: "personal",
    ...partial,
  };
}

const KITCHEN = project({
  id: "p-kitchen",
  name: "Kitchen",
  visibility: "shared",
  targetDate: "2026-12-01",
});
const RAINY = project({ id: "p-rainy", name: "Rainy day" });
const BATHROOM = project({
  id: "p-bathroom",
  name: "Bathroom",
  ownerUserId: BOB,
  ownerName: "Bob",
  visibility: "shared",
});

let stub: FetchStub;

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPage(projects: ProjectDto[], extra: Routes = {}): Promise<void> {
  stub = stubApiFetch({
    // A real AuthProvider, because the page's whole job is telling your
    // projects from a co-member's and it needs to know who you are.
    "POST /api/auth/refresh": { body: { accessToken: "t" } },
    "GET /api/auth/me": {
      body: {
        id: ALICE,
        email: "alice@example.com",
        displayName: "Alice",
        totpEnabled: false,
        notifyEmail: false,
      },
    },
    "GET /api/projects": { body: projects },
    ...extra,
  });
  render(
    <MemoryRouter>
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
  await screen.findByText(/your projects/i);
}

/** The table under a given heading. */
function tableUnder(heading: RegExp): HTMLTableElement {
  const head = screen.getByRole("heading", { name: heading });
  let node: Element | null = head.parentElement;
  while (node && !node.querySelector("table")) node = node.nextElementSibling;
  return node!.querySelector("table")!;
}

describe("ProjectsPage", () => {
  it("splits your projects from the ones your household shared with you", async () => {
    await renderPage([KITCHEN, RAINY, BATHROOM]);

    const mine = tableUnder(/your projects/i);
    const rows = within(mine).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Kitchen"),
      expect.stringContaining("Rainy day"),
    ]);
    // The chip says which it is, in words rather than by colour alone.
    expect(within(rows[0]!).getByText("shared")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("personal")).toBeInTheDocument();

    const theirs = await screen.findByRole("heading", { name: /shared with you/i });
    expect(theirs).toBeInTheDocument();
    const shared = tableUnder(/shared with you/i);
    const sharedRows = within(shared).getAllByRole("row").slice(1);
    expect(sharedRows).toHaveLength(1);
    // Whose it is, by name — you can only see it because you share a household.
    expect(sharedRows[0]!.textContent).toContain("Bathroom");
    expect(sharedRows[0]!.textContent).toContain("Bob");
    // And no control to change something that is not yours.
    expect(within(shared).queryByRole("button")).toBeNull();
  });

  it("says nothing about a household you are not in", async () => {
    await renderPage([RAINY]);
    expect(screen.queryByRole("heading", { name: /shared with you/i })).toBeNull();
  });

  it("creates a shared project when the control asks for one", async () => {
    await renderPage([], { "POST /api/projects": { status: 201, body: KITCHEN } });

    fireEvent.change(screen.getByPlaceholderText(/project name/i), {
      target: { value: "  Kitchen  " },
    });
    fireEvent.change(screen.getByLabelText(/visibility/i), { target: { value: "shared" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(stub.bodyOf("POST /api/projects")).toMatchObject({
        name: "Kitchen",
        visibility: "shared",
      }),
    );
  });

  it("defaults a new project to personal", async () => {
    await renderPage([], { "POST /api/projects": { status: 201, body: RAINY } });
    fireEvent.change(screen.getByPlaceholderText(/project name/i), {
      target: { value: "Rainy day" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(stub.bodyOf("POST /api/projects")).toMatchObject({ visibility: "personal" }),
    );
  });

  it("flips one of yours between personal and shared", async () => {
    await renderPage([RAINY], {
      "PATCH /api/projects/p-rainy": { body: { ...RAINY, visibility: "shared" } },
    });
    fireEvent.click(screen.getByRole("button", { name: /share with household/i }));
    await waitFor(() =>
      expect(stub.bodyOf("PATCH /api/projects/p-rainy")).toEqual({ visibility: "shared" }),
    );
  });

  it("shows the server's refusal on the row that asked for it, naming the payments", async () => {
    await renderPage([RAINY], {
      "PATCH /api/projects/p-rainy": {
        status: 422,
        body: {
          error: {
            code: "payments_not_shared",
            message:
              "These payments are on accounts that are not shared into the household: Buffer top-up, Tiles",
          },
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /share with household/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Buffer top-up");
    expect(alert.textContent).toContain("Tiles");
    // The row is still personal — a refusal is not a partial success.
    expect(screen.getByText("personal")).toBeInTheDocument();
  });
});
