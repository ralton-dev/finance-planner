import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import type { ContributionDto, PaymentDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { ContributionLedger, ledgerNote } from "./ContributionLedger.js";

/**
 * The ledger behind the plan's already-saved, and the two rules that decide
 * what it offers.
 *
 * The first is the whole reason the section exists: money set aside was
 * written and never read back, so a mistyped figure was visible only in its
 * consequences. The second is WP-AP's guard — a row a transfer confirmation
 * wrote is refused by both PATCH and DELETE with 409 `confirmation_generated`,
 * so this screen must not offer either control on one. A button whose only
 * possible outcome is a refusal is worse than no button.
 */

const MONTH = "2026-08";

const contribution = (over: Partial<ContributionDto> = {}): ContributionDto => ({
  id: "c1",
  paymentId: "p1",
  accountId: "a1",
  userId: "u1",
  month: "2026-08-01",
  amountMinor: 12_500,
  note: null,
  transferConfirmationId: null,
  createdAt: "2026-08-04T09:00:00.000Z",
  ...over,
});

const payments = [
  { id: "p1", name: "Car service" },
  { id: "p2", name: "Council tax" },
] as PaymentDto[];

function renderLedger(
  contributions: ContributionDto[] | undefined,
  extra?: { routes?: Routes; canEdit?: boolean; failed?: boolean },
): { stub: FetchStub; changed: () => number } {
  const stub = stubApiFetch(extra?.routes ?? {});
  let changes = 0;
  render(
    <ContributionLedger
      contributions={contributions}
      failed={extra?.failed ?? false}
      payments={payments}
      currency="GBP"
      month={MONTH}
      canEdit={extra?.canEdit ?? true}
      onChanged={() => {
        changes += 1;
      }}
    />,
  );
  return { stub, changed: () => changes };
}

/** A mutation, its response and the re-render it causes, all landed. */
const settled = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Queries scoped to the row a payment's name sits in. */
const row = (name: string) => within(screen.getByText(name).closest("li") as HTMLElement);

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContributionLedger — reading the record back", () => {
  it("lists each row with its amount and its month", () => {
    renderLedger([
      contribution({ amountMinor: 12_500, note: "from the rebate" }),
      contribution({ id: "c2", paymentId: "p2", month: "2026-07-01", amountMinor: 30_000 }),
    ]);

    const first = screen.getByText("Car service").closest("li")!;
    expect(first).toHaveTextContent("£125.00");
    expect(first).toHaveTextContent("aug 2026");
    expect(first).toHaveTextContent("from the rebate");

    const second = screen.getByText("Council tax").closest("li")!;
    expect(second).toHaveTextContent("£300.00");
    expect(second).toHaveTextContent("jul 2026");
  });

  it("puts the newest month first, so a correction lands where it is looked for", () => {
    renderLedger([
      contribution({ id: "old", paymentId: "p2", month: "2026-06-01" }),
      contribution({ id: "new", paymentId: "p1", month: "2026-08-01" }),
    ]);

    const names = screen.getAllByText(/Car service|Council tax/).map((n) => n.textContent);
    expect(names).toEqual(["Car service", "Council tax"]);
  });

  /**
   * The rule the whole section is measured against. `formatMinor` inside a
   * template literal is a number privacy mode cannot reach — it has no element
   * of its own to blur — so every figure here, in the rows and in the sentence
   * above them, has to be inside something `.privacy` selects.
   */
  it("puts every figure inside something privacy mode can blur", () => {
    const { container } = render(
      <ContributionLedger
        contributions={[contribution(), contribution({ id: "c2", amountMinor: 999 })]}
        payments={payments}
        currency="GBP"
        month={MONTH}
        canEdit={true}
        onChanged={() => {}}
      />,
    );

    const escaped = Array.from(container.querySelectorAll("*"))
      .filter((el) => el.children.length === 0)
      .filter((el) => /[£$€]\s?\d/.test(el.textContent ?? ""))
      .filter((el) => !el.closest(".amount, td.num, span.num, .kpi-value"));
    expect(escaped).toEqual([]);
    expect(container.querySelectorAll(".amount").length).toBeGreaterThan(0);
  });

  it("does not say 'none recorded' before it has been told", () => {
    renderLedger(undefined);

    expect(screen.getByText(/set aside · money that moved/)).toHaveTextContent("[…");
    expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByText(/nothing recorded yet/)).toBeNull();
  });

  it("says so when the read failed, rather than loading for ever", () => {
    renderLedger(undefined, { failed: true });

    expect(screen.getByText("could not read what has been recorded.")).toBeInTheDocument();
    expect(screen.queryByText("loading…")).toBeNull();
  });

  it("offers nothing to a reader who cannot edit the account", () => {
    renderLedger([contribution()], { canEdit: false });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Car service")).toBeInTheDocument();
  });
});

describe("ContributionLedger — a row a confirmation wrote", () => {
  it("shows where it came from and offers no control at all", () => {
    renderLedger([contribution({ transferConfirmationId: "tc1" })]);

    const li = screen.getByText("Car service").closest("li")!;
    expect(li).toHaveTextContent("from a confirmed transfer");
    // The acceptance in one line: the API refuses both verbs on this row, so
    // neither is offered.
    expect(within(li).queryByRole("button", { name: "edit" })).toBeNull();
    expect(within(li).queryByRole("button", { name: "remove" })).toBeNull();
    expect(within(li).queryAllByRole("button")).toEqual([]);
  });

  it("points at the thing that can undo it", () => {
    renderLedger([contribution({ transferConfirmationId: "tc1" })]);

    expect(screen.getByTitle(/un-confirm the transfer/)).toBeInTheDocument();
  });

  it("keeps offering the controls on the hand-recorded row beside it", () => {
    renderLedger([
      contribution({ transferConfirmationId: "tc1" }),
      contribution({ id: "c2", paymentId: "p2" }),
    ]);

    expect(row("Council tax").queryByRole("button", { name: "edit" })).not.toBeNull();
    expect(row("Car service").queryByRole("button", { name: "edit" })).toBeNull();
  });
});

describe("ContributionLedger — correcting one", () => {
  it("sends only what the row now says, and clears an emptied note", async () => {
    const { stub, changed } = renderLedger([contribution({ note: "from the rebate" })], {
      routes: { "PATCH /api/contributions/c1": { body: contribution({ amountMinor: 22_500 }) } },
    });

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByLabelText("amount recorded for Car service")).toHaveValue("125.00");
    expect(screen.getByLabelText("month recorded for Car service")).toHaveValue("2026-08");

    fireEvent.change(screen.getByLabelText("amount recorded for Car service"), {
      target: { value: "225.00" },
    });
    fireEvent.change(screen.getByLabelText("note for Car service"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await settled();

    expect(stub.bodyOf("PATCH /api/contributions/c1")).toEqual({
      amountMinor: 22_500,
      month: "2026-08",
      note: null,
    });
    expect(changed()).toBe(1);
  });

  /**
   * Money in integer minor units, never a float: "225.00" is 22500, and the
   * only place the major-unit string exists is the box the person typed into.
   */
  it("sends integer minor units", async () => {
    const { stub } = renderLedger([contribution()], {
      routes: { "PATCH /api/contributions/c1": { body: contribution() } },
    });

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("amount recorded for Car service"), {
      target: { value: "0.07" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await settled();

    expect(stub.bodyOf("PATCH /api/contributions/c1")?.amountMinor).toBe(7);
  });

  it("refuses a month that has not started before asking the server", async () => {
    const { stub } = renderLedger([contribution()]);

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("month recorded for Car service"), {
      target: { value: "2099-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await settled();

    expect(screen.getByRole("alert")).toHaveTextContent("jan 2099 has not started");
    // The kind half: no round trip at all, rather than a 422 come back.
    expect(stub.calls("PATCH /api/contributions/c1")).toBe(0);
  });

  it("stops the calendar at the current month too", () => {
    renderLedger([contribution()]);

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByLabelText("month recorded for Car service")).toHaveAttribute("max", MONTH);
  });

  it("still reads the server's own refusal of a future month", async () => {
    // The client guard can go stale — a month rolls over under a session left
    // open — so the 422 is handled rather than assumed unreachable.
    const { stub } = renderLedger([contribution()], {
      routes: {
        "PATCH /api/contributions/c1": {
          status: 422,
          body: { error: { code: "future_month", message: "Cannot record a future month" } },
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await settled();

    expect(stub.calls("PATCH /api/contributions/c1")).toBe(1);
    expect(screen.getByRole("alert")).toHaveTextContent("that month has not started");
  });

  it("reads a 409 back in this screen's words if one ever arrives", async () => {
    renderLedger([contribution()], {
      routes: {
        "PATCH /api/contributions/c1": {
          status: 409,
          body: { error: { code: "confirmation_generated", message: "nope" } },
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await settled();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "a confirmed transfer wrote this — un-confirm the transfer instead",
    );
  });

  it("refuses an amount that is not money, without asking", async () => {
    const { stub, changed } = renderLedger([contribution()]);

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("amount recorded for Car service"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await settled();

    expect(screen.getByRole("alert")).toHaveTextContent("amount must be greater than zero");
    expect(stub.calls("PATCH /api/contributions/c1")).toBe(0);
    expect(changed()).toBe(0);
  });

  it("removes a row and tells the page to re-read the plan", async () => {
    const { stub, changed } = renderLedger([contribution()], {
      routes: { "DELETE /api/contributions/c1": { status: 204 } },
    });

    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    await settled();

    expect(stub.calls("DELETE /api/contributions/c1")).toBe(1);
    expect(changed()).toBe(1);
  });

  it("gives the edit up without asking anything when it is cancelled", async () => {
    const { stub } = renderLedger([contribution()]);

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("amount recorded for Car service"), {
      target: { value: "999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await settled();

    expect(stub.calls("PATCH /api/contributions/c1")).toBe(0);
    expect(screen.getByText("Car service").closest("li")).toHaveTextContent("£125.00");
  });
});

describe("ledgerNote", () => {
  it("keeps the figure apart from the words", () => {
    const note = ledgerNote([contribution({ amountMinor: 12_500 })], "GBP", MONTH);

    // A `Phrase`, not a string: the money part is an object the UI renders as
    // an <Amount>, which is the only form privacy mode can blur.
    expect(note).toEqual([
      { minor: 12_500, currency: "GBP" },
      " set aside in aug 2026, across 1 record",
    ]);
  });

  it("counts only this month, and says how much else there is", () => {
    const note = ledgerNote(
      [
        contribution({ amountMinor: 12_500 }),
        contribution({ id: "c2", amountMinor: 2_500 }),
        contribution({ id: "c3", month: "2026-07-01", amountMinor: 30_000 }),
      ],
      "GBP",
      MONTH,
    );

    expect(note?.[0]).toEqual({ minor: 15_000, currency: "GBP" });
    expect(note?.[1]).toBe(" set aside in aug 2026, across 2 records");
    expect(note?.[2]).toBe(" · 1 earlier");
  });

  it("says nothing this month rather than £0.00", () => {
    const note = ledgerNote([contribution({ month: "2026-07-01" })], "GBP", MONTH);

    expect(note).toEqual(["nothing recorded in aug 2026", " · 1 earlier"]);
  });

  it("has nothing to say about a ledger it has not read, or an empty one", () => {
    expect(ledgerNote(undefined, "GBP", MONTH)).toBeNull();
    expect(ledgerNote([], "GBP", MONTH)).toBeNull();
  });
});
