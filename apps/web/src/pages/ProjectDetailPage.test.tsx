import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes as RouterRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { api } from "../lib/api.js";
import type { ProjectDetailDto, ProjectMemberPaymentDto } from "../lib/types.js";
import { stubApiFetch, type Routes } from "../test/apiMock.js";
import { ProjectDetailPage } from "./ProjectDetailPage.js";

/**
 * A project's detail page, on a **household of two**.
 *
 * The page has to answer two questions before any figure on it means anything —
 * whose project this is, and who else can read it — and a lone-user fixture can
 * ask neither.
 */

const ALICE = "u-alice";
const BOB = "u-bob";

function payment(
  partial: Partial<ProjectMemberPaymentDto> & { id: string; name: string },
): ProjectMemberPaymentDto {
  return {
    accountId: "a-alice-current",
    accountName: "Alice current",
    currency: "GBP",
    category: "fixed_point",
    amountMinor: 120000,
    alreadySavedMinor: 30000,
    dueDate: "2026-09-01",
    ...partial,
  };
}

function detail(partial: Partial<ProjectDetailDto> = {}): ProjectDetailDto {
  return {
    id: "p-kitchen",
    ownerUserId: ALICE,
    name: "Kitchen",
    description: null,
    color: null,
    targetDate: null,
    visibility: "shared",
    payments: [payment({ id: "pay-1", name: "Worktop" })],
    ...partial,
  };
}

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderPage(data: ProjectDetailDto, extra: Routes = {}): Promise<void> {
  stubApiFetch({
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
    [`GET /api/projects/${data.id}`]: { body: data },
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={[`/projects/${data.id}`]}>
      <AuthProvider>
        <RouterRoutes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects" element={<p>projects stub</p>} />
        </RouterRoutes>
      </AuthProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: /member payments/i });
}

describe("ProjectDetailPage", () => {
  it("leads with whose the project is and who else can read it", async () => {
    await renderPage(detail());
    const head = document.querySelector(".page-head")!;
    expect(head.textContent).toContain("shared");
    expect(head.textContent).toContain("yours");
    expect(
      screen.getByText(/everyone in your household can read this project/i),
    ).toBeInTheDocument();
  });

  it("names the owner when the project is a co-member's, and offers no way to delete it", async () => {
    await renderPage(
      detail({ id: "p-bathroom", name: "Bathroom", ownerUserId: BOB, ownerName: "Bob" }),
    );
    const head = document.querySelector(".page-head")!;
    expect(head.textContent).toContain("owned by Bob");
    expect(head.textContent).not.toContain("yours");
    // Deleting a shared project is its owner's alone; offering the control
    // would only ever produce a 403.
    expect(document.querySelector(".danger-zone")).toBeNull();
  });

  it("says a personal project is only yours, and keeps the danger zone", async () => {
    await renderPage(detail({ visibility: "personal" }));
    expect(screen.getByText("personal")).toBeInTheDocument();
    expect(screen.getByText(/only you can read this project/i)).toBeInTheDocument();
    expect(document.querySelector(".danger-zone")).not.toBeNull();
  });

  /**
   * The seam WP-AC left: the wire **omits** `accountName` when the caller may
   * not be told it — a payment outlives access to the account under it — and
   * the web types are hand-written, so typecheck catches nothing. The cell used
   * to render empty.
   */
  it("renders an absent account name as an absence, not as an empty cell", async () => {
    await renderPage(
      detail({
        payments: [
          payment({ id: "pay-1", name: "Worktop" }),
          payment({
            id: "pay-2",
            name: "Tiles",
            accountId: "a-gone",
            accountName: undefined,
            amountMinor: 45000,
          }),
        ],
      }),
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Alice current");
    expect(rows[1]!.textContent).toContain("another account");
    // The amount is never gated — the money is still in the project.
    expect(rows[1]!.textContent).toContain("£450.00");
  });

  it("totals per currency across the accounts a project spans", async () => {
    await renderPage(
      detail({
        payments: [
          payment({ id: "pay-1", name: "Worktop", amountMinor: 120000, alreadySavedMinor: 30000 }),
          payment({
            id: "pay-2",
            name: "Sink",
            accountId: "a-bob-current",
            accountName: "Bob current",
            amountMinor: 40000,
            alreadySavedMinor: 10000,
          }),
        ],
      }),
    );
    const kpis = [...document.querySelectorAll(".kpi")].map((k) =>
      k.textContent!.replace(/\s+/g, " "),
    );
    expect(kpis[0]).toContain("£1,600.00");
    expect(kpis[1]).toContain("£400.00");
    expect(kpis[2]).toContain("£1,200.00");
  });
});
