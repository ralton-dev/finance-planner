import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";
import type { HouseholdPlanDto, TransferConfirmationDto } from "../lib/types.js";
import { TransferChecklist } from "./TransferChecklist.js";

const plan: HouseholdPlanDto = {
  householdId: "h1",
  asOfDate: "2026-08-04",
  currency: "GBP",
  monthlyIncomeMinor: 500_000,
  totalRequiredMinor: 200_000,
  totalFundedMinor: 200_000,
  leftoverMinor: 300_000,
  shortfallMinor: 0,
  members: [
    {
      userId: "u1",
      displayName: "Ada",
      shareBp: 6000,
      monthlyIncomeMinor: 300_000,
      obligationMinor: 120_000,
      fundedMinor: 120_000,
      leftoverMinor: 180_000,
      shortfallMinor: 0,
    },
    {
      userId: "u2",
      displayName: "Bo",
      shareBp: 4000,
      monthlyIncomeMinor: 200_000,
      obligationMinor: 80_000,
      fundedMinor: 80_000,
      leftoverMinor: 120_000,
      shortfallMinor: 0,
    },
  ],
  accounts: [
    {
      accountId: "acc-ada",
      name: "Ada current",
      role: "personal",
      memberUserId: "u1",
      currency: "GBP",
      monthlyIncomeMinor: 300_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 120_000,
      leftoverMinor: 180_000,
      shortfallMinor: 0,
    },
    {
      accountId: "acc-bo",
      name: "Bo current",
      role: "personal",
      memberUserId: "u2",
      currency: "GBP",
      monthlyIncomeMinor: 200_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 80_000,
      leftoverMinor: 120_000,
      shortfallMinor: 0,
    },
    {
      accountId: "acc-joint",
      name: "Joint bills",
      role: "shared",
      memberUserId: null,
      currency: "GBP",
      monthlyIncomeMinor: 0,
      requiredOutflowMinor: 200_000,
      fundedOutflowMinor: 200_000,
      transferInMinor: 200_000,
      transferOutMinor: 0,
      leftoverMinor: 0,
      shortfallMinor: 0,
    },
  ],
  lines: [],
  transfers: [
    {
      fromAccountId: "acc-ada",
      toAccountId: "acc-joint",
      memberUserId: "u1",
      amountMinor: 120_000,
    },
    { fromAccountId: "acc-bo", toAccountId: "acc-joint", memberUserId: "u2", amountMinor: 80_000 },
  ],
};

const adaConfirmed: TransferConfirmationDto = {
  id: "conf-1",
  householdId: "h1",
  month: "2026-08-01",
  fromAccountId: "acc-ada",
  toAccountId: "acc-joint",
  memberUserId: "u1",
  amountMinor: 120_000,
  createdAt: "2026-08-02T10:00:00.000Z",
};

const noop = async (): Promise<void> => {};

describe("TransferChecklist", () => {
  it("lists each planned transfer with who moves what, where", () => {
    render(
      <TransferChecklist
        plan={plan}
        confirmations={[]}
        onConfirm={noop}
        onUndo={noop}
        month="2026-08"
      />,
    );
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getAllByText("Joint bills")).toHaveLength(2);
    expect(screen.getByText("£1,200.00")).toBeInTheDocument();
    expect(screen.getByText(/0\/2 done/)).toBeInTheDocument();
  });

  it("matches confirmations to their transfer and leaves the rest to do", () => {
    render(
      <TransferChecklist
        plan={plan}
        confirmations={[adaConfirmed]}
        onConfirm={noop}
        onUndo={noop}
      />,
    );
    expect(screen.getByText("done · £1,200.00")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "mark done" })).toHaveLength(1);
    expect(screen.getByText(/1\/2 done/)).toBeInTheDocument();
  });

  it("fires onConfirm with the transfer being marked done", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <TransferChecklist
        plan={plan}
        confirmations={[adaConfirmed]}
        onConfirm={onConfirm}
        onUndo={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(plan.transfers[1]));
  });

  it("fires onUndo with the confirmation id", async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined);
    render(
      <TransferChecklist
        plan={plan}
        confirmations={[adaConfirmed]}
        onConfirm={noop}
        onUndo={onUndo}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "undo" }));

    await waitFor(() => expect(onUndo).toHaveBeenCalledWith("conf-1"));
  });

  it("surfaces the error code inline when confirming conflicts", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "already_confirmed", "Transfer already confirmed"));
    render(
      <TransferChecklist plan={plan} confirmations={[]} onConfirm={onConfirm} onUndo={noop} />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "mark done" })[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent("already_confirmed");
    // The other row is untouched.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("surfaces a permission failure from the server", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValue(new ApiError(403, "forbidden", "Only self or admins may confirm"));
    render(
      <TransferChecklist plan={plan} confirmations={[]} onConfirm={onConfirm} onUndo={noop} />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "mark done" })[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
  });

  it("still offers undo for a confirmation the plan no longer derives", () => {
    const orphan: TransferConfirmationDto = {
      ...adaConfirmed,
      id: "conf-9",
      fromAccountId: "acc-bo",
    };
    render(
      <TransferChecklist
        plan={{ ...plan, transfers: [] }}
        confirmations={[orphan]}
        onConfirm={noop}
        onUndo={noop}
      />,
    );
    expect(screen.getByText("no longer planned")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "undo" })).toBeInTheDocument();
  });

  it("says so when the plan needs no transfers at all", () => {
    render(
      <TransferChecklist
        plan={{ ...plan, transfers: [] }}
        confirmations={[]}
        onConfirm={noop}
        onUndo={noop}
      />,
    );
    expect(screen.getByText(/no transfers needed/i)).toBeInTheDocument();
  });
});
