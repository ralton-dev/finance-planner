import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider, useQuickAdd } from "../contexts/QuickAddContext.js";
import type { AccountDto, PaymentDto } from "../lib/types.js";
import { NewPaymentDrawer } from "./NewPaymentDrawer.js";

const accounts: AccountDto[] = [
  {
    id: "acc-1",
    name: "Ben Monzo",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: true,
    permission: "edit",
  },
  {
    id: "acc-2",
    name: "Izzy Monzo",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: false,
    permission: "view", // should be excluded from the picker
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
function makeFetchMock() {
  return vi.fn(async (url: string) => {
    if (url === "/api/accounts") {
      return { ok: true, status: 200, statusText: "OK", json: async () => accounts };
    }
    if (url.endsWith("/payments")) {
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({ id: "p-1" }),
      };
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  });
}

beforeEach(() => {
  fetchMock = makeFetchMock();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Test harness: opens the drawer pre-filled with the given account on mount. */
function Harness({ accountId }: { accountId?: string }) {
  const Opener = (): null => {
    const { openPayment } = useQuickAdd();
    useEffect(() => {
      openPayment(accountId);
    }, [openPayment, accountId]);
    return null;
  };
  return (
    <QuickAddProvider>
      <Opener />
      <NewPaymentDrawer />
    </QuickAddProvider>
  );
}

/** Edit-mode harness: opens the drawer pre-filled with an existing payment. */
function EditHarness({ payment }: { payment: PaymentDto }) {
  const Opener = (): null => {
    const { openEditPayment } = useQuickAdd();
    useEffect(() => {
      openEditPayment(payment);
    }, [openEditPayment, payment]);
    return null;
  };
  return (
    <QuickAddProvider>
      <Opener />
      <NewPaymentDrawer />
    </QuickAddProvider>
  );
}

describe("NewPaymentDrawer", () => {
  it("only lists accounts the caller can edit", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Ben Monzo/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("option", { name: /Izzy Monzo/ })).toBeNull();
  });

  it("pre-selects the account passed via openPayment(accountId)", async () => {
    render(<Harness accountId="acc-1" />);
    await waitFor(() =>
      expect((screen.getByLabelText(/account/i) as HTMLSelectElement).value).toBe("acc-1"),
    );
  });

  it("hides the due-date field for monthly_recurring and shows the recurrence row for custom", async () => {
    render(<Harness accountId="acc-1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /add payment/i })).toBeInTheDocument(),
    );

    expect(screen.getByLabelText(/due \/ target date/i)).toBeInTheDocument();
    expect(screen.queryByText(/every/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "monthly_recurring" },
    });
    expect(screen.queryByLabelText(/due \/ target date/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "custom_recurring" },
    });
    expect(screen.getByLabelText(/due \/ target date/i)).toBeInTheDocument();
    expect(screen.getByText(/every/)).toBeInTheDocument();
  });

  it("submits a fixed_point payment POST with the right body", async () => {
    render(<Harness accountId="acc-1" />);
    await waitFor(() =>
      expect((screen.getByLabelText(/account/i) as HTMLSelectElement).value).toBe("acc-1"),
    );

    fireEvent.change(screen.getByPlaceholderText(/holiday/i), { target: { value: "Holiday" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText(/due \/ target date/i), {
      target: { value: "2026-09-01" },
    });

    fireEvent.click(screen.getByRole("button", { name: /add payment/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/payments"));
      expect(postCall).toBeTruthy();
    });
    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/payments"))!;
    const [url, init] = postCall;
    expect(url).toBe("/api/accounts/acc-1/payments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120000,
      dueDate: "2026-09-01",
      priority: 100,
    });
  });

  it("edit mode pre-fills, locks account + category, and PATCHes on save", async () => {
    const existing: PaymentDto = {
      id: "p-99",
      accountId: "acc-1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120000,
      dueDate: "2026-09-01",
      recurrence: null,
      targetDate: null,
      priority: 50,
      alreadySavedMinor: 4000,
      autoRenew: true,
      active: true,
      notes: null,
      projectId: null,
    };

    // Make the PATCH endpoint succeed.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/accounts") {
        return { ok: true, status: 200, statusText: "OK", json: async () => accounts };
      }
      if (url === "/api/projects") {
        return { ok: true, status: 200, statusText: "OK", json: async () => [] };
      }
      if (url === "/api/payments/p-99" && init?.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ ...existing, name: "Lisbon trip" }),
        };
      }
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    });

    render(<EditHarness payment={existing} />);

    // Title reflects edit mode
    await waitFor(() => expect(screen.getByText(/edit payment · Holiday/i)).toBeInTheDocument());

    // Pre-filled values
    expect(screen.getByDisplayValue("Holiday")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1200.00")).toBeInTheDocument(); // amount in major
    expect(screen.getByDisplayValue("40.00")).toBeInTheDocument(); // already saved
    expect(screen.getByDisplayValue("50")).toBeInTheDocument(); // priority
    expect(screen.getByDisplayValue("2026-09-01")).toBeInTheDocument();

    // Account + category locked
    expect(screen.getByLabelText(/account/i)).toBeDisabled();
    expect(screen.getByLabelText(/category/i)).toBeDisabled();

    // Rename and save
    const nameInput = screen.getByDisplayValue("Holiday");
    fireEvent.change(nameInput, { target: { value: "Lisbon trip" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => String(c[0]) === "/api/payments/p-99" && c[1]?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
    });
    const patch = fetchMock.mock.calls.find(
      (c) => String(c[0]) === "/api/payments/p-99" && c[1]?.method === "PATCH",
    )!;
    const body = JSON.parse(patch[1].body);
    expect(body).toMatchObject({
      name: "Lisbon trip",
      category: "fixed_point",
      amountMinor: 120000,
      alreadySavedMinor: 4000,
      priority: 50,
      dueDate: "2026-09-01",
      projectId: null,
      active: true,
    });
  });
});
