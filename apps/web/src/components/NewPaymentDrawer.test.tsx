import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider, useQuickAdd } from "../contexts/QuickAddContext.js";
import type { AccountPlanDto, AccountDto, PaymentDto, PlanLineDto } from "../lib/types.js";
import { NewPaymentDrawer } from "./NewPaymentDrawer.js";

const accounts: AccountDto[] = [
  {
    id: "acc-1",
    name: "Owned Account",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: true,
    permission: "edit",
  },
  {
    id: "acc-2",
    name: "View-Only Shared",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: false,
    permission: "view", // should be excluded from the picker
  },
];

/** Payments already on acc-1 — the source of the tag suggestions. */
const existingPayments: Partial<PaymentDto>[] = [
  { id: "old-1", name: "Rent", tag: "housing" },
  { id: "old-2", name: "MOT", tag: "car" },
  { id: "old-3", name: "Misc", tag: null },
];

function planLine(over: Partial<PlanLineDto> & { paymentId: string }): PlanLineDto {
  return {
    name: over.paymentId,
    category: "fixed_point",
    amountMinor: 100_000,
    dueDate: "2026-12-01",
    targetDate: "2026-12-01",
    monthsUntilDue: 4,
    requiredMonthlyMinor: 25_000,
    fundedMonthlyMinor: 25_000,
    alreadySavedMinor: 0,
    onTrack: true,
    ...over,
  };
}

function accountPlan(over: Partial<AccountPlanDto>): AccountPlanDto {
  return {
    accountId: "acc-1",
    asOfDate: "2026-08-04",
    currency: "GBP",
    monthlyIncomeMinor: 300_000,
    bufferMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: null,
    reservedMinor: 0,
    ...over,
  };
}

/** Default preview: adding the payment eats into the headroom and knocks the
 *  car insurance off track. Individual tests override it. */
let previewReply: unknown = {
  base: accountPlan({
    leftoverMinor: 200_000,
    lines: [planLine({ paymentId: "p1", name: "car insurance", onTrack: true })],
  }),
  preview: accountPlan({
    leftoverMinor: 150_000,
    lines: [
      planLine({ paymentId: "p1", name: "car insurance", onTrack: false }),
      planLine({ paymentId: "preview-payment-1", name: "New telly", onTrack: false }),
    ],
  }),
};

let fetchMock: ReturnType<typeof vi.fn>;
function makeFetchMock() {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const ok = (body: unknown, status = 200) => ({
      ok: true,
      status,
      statusText: "OK",
      json: async () => body,
    });
    if (url === "/api/accounts") return ok(accounts);
    if (url === "/api/projects") return ok([]);
    if (url.endsWith("/plan/preview") && method === "POST") return ok(previewReply);
    if (url.endsWith("/payments") && method === "GET") return ok(existingPayments);
    if (url.endsWith("/payments") && method === "POST") return ok({ id: "p-1" }, 201);
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  });
}

/** The JSON body of the first request matching a method + path suffix. */
function bodyOf(method: string, suffix: string): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find(
    (c) => String(c[0]).endsWith(suffix) && (c[1]?.method ?? "GET") === method,
  );
  return call?.[1]?.body ? JSON.parse(call[1].body) : undefined;
}

/** Fill in the fields every payment needs, so a test can get to its own point. */
async function fillBasics(name = "New telly", amount = "1200"): Promise<void> {
  await waitFor(() =>
    expect((screen.getByLabelText(/account/i) as HTMLSelectElement).value).toBe("acc-1"),
  );
  fireEvent.change(screen.getByPlaceholderText(/holiday/i), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: amount } });
}

beforeEach(() => {
  previewReply = {
    base: accountPlan({
      leftoverMinor: 200_000,
      lines: [planLine({ paymentId: "p1", name: "car insurance", onTrack: true })],
    }),
    preview: accountPlan({
      leftoverMinor: 150_000,
      lines: [
        planLine({ paymentId: "p1", name: "car insurance", onTrack: false }),
        planLine({ paymentId: "preview-payment-1", name: "New telly", onTrack: false }),
      ],
    }),
  };
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
      expect(screen.getByRole("option", { name: /Owned Account/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("option", { name: /View-Only Shared/ })).toBeNull();
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

    // The drawer also GETs this path for the tag suggestions, so match on the
    // method too rather than on the first request to the URL.
    await waitFor(() => expect(bodyOf("POST", "/payments")).toBeTruthy());
    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/payments") && c[1]?.method === "POST",
    )!;
    const [url, init] = postCall;
    expect(url).toBe("/api/accounts/acc-1/payments");
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
      scope: "shared",
      bearerUserId: null,
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

    // Category stays locked; the account is now movable (edit + recreate is gone).
    expect(screen.getByLabelText(/account/i)).not.toBeDisabled();
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
      accountId: "acc-1", // sent so a move (if the account changed) takes effect
    });
  });
});

describe("NewPaymentDrawer · goal modes", () => {
  it("offers the two ways to express a goal, by date first", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    expect(screen.getByRole("button", { name: "by date" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(/due \/ target date/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/amount \/ month/i)).toBeNull();
  });

  it("hides the goal-type switch for categories that are not one-off goals", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "yearly_recurring" },
    });
    expect(screen.queryByRole("group", { name: "goal type" })).toBeNull();
  });

  it("swaps the date field for a monthly amount in fixed-monthly mode", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: "fixed monthly" }));
    expect(screen.getByLabelText(/amount \/ month/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/due \/ target date/i)).toBeNull();
  });

  it("posts the monthly cap and clears the date for a paced goal", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: "fixed monthly" }));
    fireEvent.change(screen.getByLabelText(/amount \/ month/i), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /add payment/i }));

    await waitFor(() => expect(bodyOf("POST", "/payments")).toBeTruthy());
    expect(bodyOf("POST", "/payments")).toMatchObject({
      name: "New telly",
      category: "fixed_point",
      amountMinor: 120_000,
      fixedMonthlyMinor: 15_000,
      dueDate: null,
    });
  });

  it("blocks submit until a paced goal has a monthly amount", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: "fixed monthly" }));
    expect(screen.getByRole("button", { name: /add payment/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/amount \/ month/i), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /add payment/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/amount \/ month/i), { target: { value: "25" } });
    expect(screen.getByRole("button", { name: /add payment/i })).toBeEnabled();
  });

  it("blocks submit when a dated goal has no date", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    expect(screen.getByRole("button", { name: /add payment/i })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/due \/ target date/i), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /add payment/i })).toBeDisabled();
  });

  it("keeps a monthly bill submittable with no date at all", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "monthly_recurring" },
    });
    expect(screen.getByRole("button", { name: /add payment/i })).toBeEnabled();
  });

  it("hides the target date behind a disclosure, and sends it once revealed", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: "fixed monthly" }));
    fireEvent.change(screen.getByLabelText(/amount \/ month/i), { target: { value: "150" } });
    expect(screen.queryByLabelText(/target date/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /also set a target date/i }));
    fireEvent.change(screen.getByLabelText(/target date \(optional\)/i), {
      target: { value: "2027-03-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add payment/i }));

    await waitFor(() => expect(bodyOf("POST", "/payments")).toBeTruthy());
    expect(bodyOf("POST", "/payments")).toMatchObject({
      fixedMonthlyMinor: 15_000,
      dueDate: "2027-03-01",
    });
  });

  it("opens an existing capped goal in fixed-monthly mode", async () => {
    const capped: PaymentDto = {
      id: "p-77",
      accountId: "acc-1",
      name: "Kitchen",
      category: "fixed_point",
      amountMinor: 500_000,
      dueDate: null,
      recurrence: null,
      targetDate: null,
      priority: 100,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      notes: null,
      projectId: null,
      scope: "shared",
      bearerUserId: null,
      fixedMonthlyMinor: 20_000,
      tag: "home",
    };

    render(<EditHarness payment={capped} />);
    await waitFor(() => expect(screen.getByText(/edit payment · Kitchen/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "fixed monthly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText(/amount \/ month/i)).toHaveValue("200.00");
    // No date was set, so the optional target date stays folded away.
    expect(screen.queryByLabelText(/target date/i)).toBeNull();
  });

  it("opens a dated goal in by-date mode with no cap", async () => {
    const dated: PaymentDto = {
      id: "p-78",
      accountId: "acc-1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: "2026-09-01",
      recurrence: null,
      targetDate: null,
      priority: 100,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      notes: null,
      projectId: null,
      scope: "shared",
      bearerUserId: null,
      fixedMonthlyMinor: null,
      tag: null,
    };

    render(<EditHarness payment={dated} />);
    await waitFor(() => expect(screen.getByText(/edit payment · Holiday/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "by date" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(/due \/ target date/i)).toHaveValue("2026-09-01");
  });
});

describe("NewPaymentDrawer · tags", () => {
  it("trims the tag before sending it", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.change(screen.getByLabelText(/tag \(optional\)/i), {
      target: { value: "  housing  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /add payment/i }));

    await waitFor(() => expect(bodyOf("POST", "/payments")).toBeTruthy());
    expect(bodyOf("POST", "/payments")).toMatchObject({ tag: "housing" });
  });

  it("sends null for an empty (or whitespace-only) tag", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.change(screen.getByLabelText(/tag \(optional\)/i), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /add payment/i }));

    await waitFor(() => expect(bodyOf("POST", "/payments")).toBeTruthy());
    expect(bodyOf("POST", "/payments")!.tag).toBeNull();
  });

  it("suggests the tags already used on the account, once each", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    const input = screen.getByLabelText(/tag \(optional\)/i);
    expect(input).toHaveAttribute("list", "payment-tag-suggestions");
    await waitFor(() =>
      expect(document.querySelectorAll("#payment-tag-suggestions option")).toHaveLength(2),
    );
    const values = [...document.querySelectorAll("#payment-tag-suggestions option")].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual(["car", "housing"]);
  });
});

describe("NewPaymentDrawer · what-if preview", () => {
  it("stays out of the way until the form is worth previewing", async () => {
    render(<Harness accountId="acc-1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /preview impact/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /preview impact/i })).toBeDisabled();

    await fillBasics();
    expect(screen.getByRole("button", { name: /preview impact/i })).toBeEnabled();
  });

  it("shows the before → after strip and what the payment puts at risk", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: /preview impact/i }));

    const strip = await screen.findByLabelText("preview impact");
    expect(strip).toHaveTextContent("left over");
    expect(strip).toHaveTextContent("£2,000.00");
    expect(strip).toHaveTextContent("£1,500.00");
    expect(strip).toHaveTextContent("puts at risk: car insurance");
    // The worsened row is the one that gets the warn styling.
    expect(strip.querySelector(".preview-row.warn")).not.toBeNull();

    // The drafted payment goes to the preview endpoint, and nothing is created.
    expect(bodyOf("POST", "/plan/preview")).toMatchObject({
      addPayments: [{ name: "New telly", amountMinor: 120_000, category: "fixed_point" }],
    });
    expect(bodyOf("POST", "/payments")).toBeUndefined();
  });

  it("says so plainly when the plan improves", async () => {
    previewReply = {
      base: accountPlan({ leftoverMinor: 0, shortfallMinor: 50_000 }),
      preview: accountPlan({ leftoverMinor: 25_000, shortfallMinor: 0 }),
    };
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: /preview impact/i }));

    const strip = await screen.findByLabelText("preview impact");
    expect(strip).toHaveTextContent("no goal falls behind.");
    expect(strip.querySelector(".preview-row.warn")).toBeNull();
  });

  it("clears the strip as soon as the draft changes", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();

    fireEvent.click(screen.getByRole("button", { name: /preview impact/i }));
    await screen.findByLabelText("preview impact");

    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "2400" } });
    expect(screen.queryByLabelText("preview impact")).toBeNull();
  });

  it("never fires on its own while the user types", async () => {
    render(<Harness accountId="acc-1" />);
    await fillBasics();
    fireEvent.change(screen.getByLabelText(/tag \(optional\)/i), { target: { value: "housing" } });

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/plan/preview"))).toHaveLength(
      0,
    );
  });

  it("offers no preview while editing an existing payment", async () => {
    const existing: PaymentDto = {
      id: "p-99",
      accountId: "acc-1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: "2026-09-01",
      recurrence: null,
      targetDate: null,
      priority: 50,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      notes: null,
      projectId: null,
      scope: "shared",
      bearerUserId: null,
    };
    render(<EditHarness payment={existing} />);
    await waitFor(() => expect(screen.getByText(/edit payment · Holiday/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /preview impact/i })).toBeNull();
  });

  it("reports a failed preview instead of pretending", async () => {
    previewReply = null;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === "/api/accounts") {
        return { ok: true, status: 200, statusText: "OK", json: async () => accounts };
      }
      if (url.endsWith("/plan/preview") && init?.method === "POST") {
        return {
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: async () => ({ error: { code: "forbidden", message: "no access" } }),
        };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    });

    render(<Harness accountId="acc-1" />);
    await fillBasics();
    fireEvent.click(screen.getByRole("button", { name: /preview impact/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no access/i);
  });
});
