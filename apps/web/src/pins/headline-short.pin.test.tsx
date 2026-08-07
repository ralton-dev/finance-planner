import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RealityStrip } from "../components/RealityStrip.js";
import type { AccountPlanDto } from "../lib/types.js";

/**
 * **Pin — issue #45. Flipped by WP-AT; green since.**
 *
 * > The banner subtracts a month's balance from a cumulative total and calls
 * > the difference a shortfall.
 *
 * `RealityStrip.tsx:28`:
 *
 *     const shortMinor = latest ? reserved - latest.balanceMinor : 0;
 *
 * `reserved` is `AccountPlanDto.reservedMinor`, which the API derives at
 * `apps/api/src/server.ts:208` as
 *
 *     plan.lines.reduce((sum, l) => sum + l.alreadySavedMinor, 0)
 *
 * — every line's **already-saved**, summed. Decision 26 states what that makes
 * it: *a cumulative already-saved total, not a monthly reserve*. It accumulates
 * across months. The balance beside it is one number on one day. Subtracting
 * the second from the first is arithmetic between two quantities that do not
 * share a unit, and the sentence it prints is a judgement about the month.
 *
 * The plan's standing assumption again, in the reality loop:
 *
 * > **that writing a record and the event it records are the same fact.**
 *
 * Money was *recorded* as set aside into this account. The banner reads that
 * record back as an event — as though the money had arrived and left again —
 * and tells the reader they are short. Nobody moved anything.
 *
 * ## Ben's screen, 2026-08-07 — the four figures
 *
 * | figure                                   | minor    | GBP        |
 * | ---------------------------------------- | -------- | ---------- |
 * | balance (`latestBalance.balanceMinor`)    | 1_170    | **£11.70** |
 * | reserved (`reservedMinor`)                | 23_464   | **£234.64**|
 * | arriving, still to land                   | 4_639    | **£46.39** |
 * | what the banner said                      | 22_294   | **£222.94**|
 *
 *     234.64 − 11.70 = 222.94
 *
 * Found on a real screen in seconds, with no failing test anywhere near it.
 *
 * ## What this pin does **not** say
 *
 * It does not say what the banner should print instead. WP-AT decides that,
 * and decision 27 has already narrowed it — *"short" means the month cannot
 * cover it*: warn on `reserved > balance + arriving`, not `reserved > balance`.
 * Decision 26 records that counting the arriving money **alone does not silence
 * this banner**:
 *
 *     234.64 − (11.70 + 46.39) = 176.55
 *
 * That £176.55 residue is expected. It is the real question this screen has
 * never asked — *money was recorded as saved into this account and the account
 * does not hold it* — and it is to be **explained on screen, not floored away**.
 * A replacement that reaches zero by clamping has failed. So the assertion
 * below is exactly one thing: **not £222.94**.
 *
 * ## What WP-AT put there instead
 *
 * The £176.55 is printed, in words that say which of the two numbers is a
 * record and which is an observation:
 *
 * > £46.39 is still on its way. Even after it lands, £176.55 of what is
 * > recorded as saved here is not in the account — either it never moved in, or
 * > the saved figures below are too high.
 *
 * That exact wording is asserted in `components/RealityStrip.test.tsx`, which
 * is the file that owns the sentence. This one stays a pin: it asserts the
 * defect is gone and deliberately not how, so rewording the banner never
 * reopens #45 by accident.
 *
 * ## The shape this fixture refuses to avoid
 *
 * **Money still on its way.** Every fixture in this repository check-ins a
 * balance and stops; nothing has ever put an unarrived transfer beside one, so
 * the difference between "you are short" and "it has not landed yet" has never
 * been expressible. Here £46.39 is allocated and £0.00 of it confirmed — the
 * account is owed money it has not got — and the figures are Ben's own rather
 * than round ones, so the arithmetic cannot be read off by eye and assumed.
 */

const CURRENCY = "GBP";

/** Ben's figures, in minor units, named once. */
const BALANCE_MINOR = 1_170; // £11.70
const RESERVED_MINOR = 23_464; // £234.64
const ARRIVING_MINOR = 4_639; // £46.39
/** `reserved − balance`, which is what `RealityStrip.tsx:28` prints today. */
const WHAT_THE_BANNER_SAID = "£222.94";

/**
 * The account as it stood on Ben's screen.
 *
 * `allocatedInflowMinor` is money arriving from another account this month;
 * `confirmedInflowMinor` is how much of it somebody has said actually moved.
 * £46.39 allocated and none confirmed is money on its way.
 */
const plan: AccountPlanDto = {
  accountId: "everyday",
  asOfDate: "2026-08-07",
  currency: CURRENCY,
  monthlyIncomeMinor: 0,
  bufferMinor: 0,
  totalRequiredMinor: RESERVED_MINOR,
  totalFundedMinor: RESERVED_MINOR,
  leftoverMinor: 0,
  shortfallMinor: 0,
  lines: [],
  contributionsMTD: [],
  latestBalance: { asOfDate: "2026-08-07", balanceMinor: BALANCE_MINOR },
  reservedMinor: RESERVED_MINOR,
  allocatedInflowMinor: ARRIVING_MINOR,
  confirmedInflowMinor: 0,
};

describe("the reality banner, on Ben's figures", () => {
  /**
   * The fixture's precondition, and **a plain `it` on purpose**.
   *
   * A pin that asserts the absence of a string passes trivially if nothing
   * rendered. This one holds the strip to actually printing the two figures the
   * banner is derived from, so a render that silently stops working turns the
   * build red instead of joining the expected failures.
   */
  it("prints the balance and the reserved total it is derived from", () => {
    render(<RealityStrip plan={plan} />);
    expect(screen.getByText("£11.70")).toBeInTheDocument();
    expect(screen.getByText("£234.64")).toBeInTheDocument();
  });

  /** **The pin.** One assertion, and it is a negative one on purpose. */
  it("does not call the account £222.94 short", () => {
    render(<RealityStrip plan={plan} />);
    expect(screen.queryByText(WHAT_THE_BANNER_SAID)).not.toBeInTheDocument();
  });
});
