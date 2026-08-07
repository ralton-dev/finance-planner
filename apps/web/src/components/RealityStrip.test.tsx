import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { realityNote, RealityStrip } from "./RealityStrip.js";
import { formatMinor, phraseText } from "../lib/money.js";
import { DEFAULT_STALE_AFTER_DAYS } from "../lib/needsYou.js";
import type { AccountPlanDto } from "../lib/types.js";

/**
 * The reality banner — what it says, and when it is entitled to say it.
 *
 * The sibling pin (`pins/headline-short.pin.test.tsx`) asserts only that issue
 * #45's £222.94 is gone. This file owns the replacement wording, because a
 * sentence nobody asserts is a sentence that drifts.
 */

const TODAY = "2026-08-07";
const CURRENCY = "GBP";

/** Ben's screen, 2026-08-07 — the figures issue #45 was found on. */
const BALANCE_MINOR = 1_170; // £11.70 checked in
const RESERVED_MINOR = 23_464; // £234.64 recorded as saved, cumulative
const ARRIVING_MINOR = 4_639; // £46.39 allocated, none of it confirmed
/** `234.64 − (11.70 + 46.39)`, per decision 26. Expected, and never clamped. */
const UNACCOUNTED_MINOR = 17_655; // £176.55

const daysBefore = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

function planWith(over: Partial<AccountPlanDto> = {}): AccountPlanDto {
  return {
    accountId: "everyday",
    asOfDate: TODAY,
    currency: CURRENCY,
    monthlyIncomeMinor: 0,
    bufferMinor: 0,
    totalRequiredMinor: RESERVED_MINOR,
    totalFundedMinor: RESERVED_MINOR,
    leftoverMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: { asOfDate: TODAY, balanceMinor: BALANCE_MINOR },
    reservedMinor: RESERVED_MINOR,
    allocatedInflowMinor: ARRIVING_MINOR,
    confirmedInflowMinor: 0,
    ...over,
  };
}

const banner = () => screen.queryByRole("status");

describe("realityNote — the sentence", () => {
  /**
   * The acceptance criterion, in one assertion: Ben's exact figures produce a
   * sentence a person can act on. Asserted as text rather than by fragment so
   * that a reworded banner has to come back through this test deliberately.
   */
  it("says, on Ben's figures, what the screen had never said", () => {
    expect(phraseText(realityNote(planWith())!)).toBe(
      "£46.39 is still on its way. Even after it lands, £176.55 of what is recorded as saved" +
        " here is not in the account — either it never moved in, or the saved figures below" +
        " are too high.",
    );
  });

  /**
   * Decision 26. The arriving money is counted and the gap does **not** reach
   * zero, which is the whole finding: money recorded as saved into an account
   * the account does not hold. A clamp would print nothing here.
   */
  it("prints the residue that counting the arriving money leaves behind", () => {
    expect(RESERVED_MINOR - (BALANCE_MINOR + ARRIVING_MINOR)).toBe(UNACCOUNTED_MINOR);
    render(<RealityStrip plan={planWith()} />);
    expect(banner()).toHaveTextContent(formatMinor(UNACCOUNTED_MINOR, CURRENCY));
    expect(banner()).toHaveTextContent("is not in the account");
  });

  /** The old arithmetic — `reserved − balance` — is gone from the sentence. */
  it("no longer subtracts a one-day balance from a cumulative total", () => {
    render(<RealityStrip plan={planWith()} />);
    expect(banner()).not.toHaveTextContent("£222.94");
  });

  /**
   * Decision 27: "short" means the month cannot cover it. £11.70 held plus
   * £46.39 arriving covers £50.00 recorded, so there is nothing to report —
   * this is the case that used to fire and should never have.
   */
  it("says nothing when the money on its way covers what is recorded", () => {
    const covered = planWith({ reservedMinor: 5_000 });
    expect(realityNote(covered)).toBeNull();
    render(<RealityStrip plan={covered} />);
    expect(banner()).not.toBeInTheDocument();
  });

  /** Exactly covered is covered: the test is `>`, not `>=`. */
  it("says nothing when the cover is exact to the penny", () => {
    expect(realityNote(planWith({ reservedMinor: BALANCE_MINOR + ARRIVING_MINOR }))).toBeNull();
    expect(
      realityNote(planWith({ reservedMinor: BALANCE_MINOR + ARRIVING_MINOR + 1 })),
    ).not.toBeNull();
  });

  /** An account with nothing arriving still gets the substance, without a
   *  clause about money that does not exist. */
  it("drops the arriving clause when nothing is on its way", () => {
    const text = phraseText(realityNote(planWith({ allocatedInflowMinor: 0 }))!);
    expect(text).toBe(
      "£222.94 of what is recorded as saved here is not in the account — either it never" +
        " moved in, or the saved figures below are too high.",
    );
    // The same £222.94 as issue #45 — but only because nothing is arriving to
    // count, and now it is named as a record that disagrees with an account
    // rather than asserted as this month's shortfall.
    expect(text).not.toContain("short");
  });

  /** A missing `allocatedInflowMinor` reads as nothing arriving, not NaN. */
  it("treats an absent arriving figure as none", () => {
    const without = planWith({ allocatedInflowMinor: undefined });
    expect(phraseText(realityNote(without)!)).toContain("£222.94 of what is");
  });

  /** Never reconciled: no observation, so no disagreement to report. */
  it("says nothing about an account that has never been checked in", () => {
    expect(realityNote(planWith({ latestBalance: null }))).toBeNull();
  });
});

describe("realityNote — a stale balance", () => {
  const stale = (days: number) =>
    planWith({ latestBalance: { asOfDate: daysBefore(days), balanceMinor: BALANCE_MINOR } });

  /**
   * **The decision, asserted.** A balance nobody has confirmed for three weeks
   * is a cheaper explanation for the gap than missing money, so the banner
   * still fires — suppressing it would hide a real discrepancy — but it leads
   * with the age and asks for the one action that tells the two apart.
   */
  it("fires on a three-week-old balance, but does not call it missing money", () => {
    expect(phraseText(realityNote(stale(22))!)).toBe(
      "this balance was checked in 22 days ago, and £46.39 is still on its way. £176.55 of" +
        " what is recorded as saved here is unaccounted for beyond that — but a balance that" +
        " old is not evidence the money is gone. Check in a fresh one.",
    );
  });

  /** Not floored away: the figure survives the stale wording. */
  it("still prints the unaccounted figure when the balance is stale", () => {
    render(<RealityStrip plan={stale(22)} />);
    expect(banner()).toHaveTextContent("£176.55");
    expect(banner()).toHaveTextContent("Check in a fresh one.");
  });

  /**
   * One threshold for the whole app. `DEFAULT_STALE_AFTER_DAYS` already drove
   * the needs-you checklist and the accounts page's "stale N d" chip; the
   * banner draws the line in the same place rather than inventing a second one.
   */
  it("draws the line at the app's own staleness threshold, not its own", () => {
    const fresh = phraseText(realityNote(stale(DEFAULT_STALE_AFTER_DAYS))!);
    const aged = phraseText(realityNote(stale(DEFAULT_STALE_AFTER_DAYS + 1))!);
    expect(fresh).not.toContain("days ago");
    expect(aged).toContain(`${DEFAULT_STALE_AFTER_DAYS + 1} days ago`);
  });

  /**
   * Staleness is measured against the plan's own `asOfDate` — the server's day,
   * already on the wire — so it does not drift with the reader's clock.
   */
  it("ages the balance against the plan's day, not the browser's", () => {
    const p = planWith({
      asOfDate: "2026-09-30",
      latestBalance: { asOfDate: "2026-08-07", balanceMinor: BALANCE_MINOR },
    });
    expect(phraseText(realityNote(p)!)).toContain("54 days ago");
  });

  /** A stale balance with nothing arriving keeps the age and drops the clause. */
  it("drops the arriving clause when a stale account has nothing on its way", () => {
    const p = { ...stale(22), allocatedInflowMinor: 0 };
    expect(phraseText(realityNote(p)!)).toBe(
      "this balance was checked in 22 days ago. £222.94 of what is recorded as saved here is" +
        " unaccounted for beyond that — but a balance that old is not evidence the money is" +
        " gone. Check in a fresh one.",
    );
  });

  /** A covered account stays silent however old its balance is. */
  it("stays silent on a stale balance the arriving money covers", () => {
    expect(realityNote({ ...stale(22), reservedMinor: 5_000 })).toBeNull();
  });
});

describe("RealityStrip — the figures above the banner", () => {
  /** The strip itself is unchanged, and the banner never repeats it. */
  it("prints the balance, its date and the reserved total exactly once", () => {
    render(<RealityStrip plan={planWith()} />);
    expect(screen.getByText("£11.70")).toBeInTheDocument();
    expect(screen.getByText("£234.64")).toBeInTheDocument();
    expect(screen.getByText(`· as of ${TODAY}`)).toBeInTheDocument();
  });

  /**
   * Privacy mode blurs elements, never strings. Every figure in the sentence
   * has to be its own `.amount` or the banner is the one place on the account
   * page where the numbers stay readable over your shoulder.
   */
  it("wraps every figure in the sentence so privacy mode can reach it", () => {
    render(<RealityStrip plan={planWith()} />);
    const amounts = [...banner()!.querySelectorAll(".amount")].map((n) => n.textContent);
    expect(amounts).toEqual(["£46.39", "£176.55"]);
  });
});
