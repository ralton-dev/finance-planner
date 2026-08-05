import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatMinor } from "../lib/money.js";
import type { HouseholdPlanDto } from "../lib/types.js";
import { HouseholdPlanView } from "./HouseholdPlanView.js";

/**
 * A two-account, two-member household: one shared pot, one personal account
 * with a salary landing in it. Enough for both tables to have every shape.
 *
 * Bo is a member whose own account the household does not hold, which is the
 * ordinary shape decision 9 made possible and the reason the two leftover
 * figures differ here: `leftoverMinor` is both members' surplus scope-wide
 * (£1,286 + £1,124), `householdLeftoverMinor` is what is in the two accounts
 * listed below (£0 + £1,286).
 */
const PLAN: HouseholdPlanDto = {
  householdId: "hh",
  asOfDate: "2026-08-04",
  currency: "GBP",
  monthlyIncomeMinor: 460_000,
  totalRequiredMinor: 219_000,
  totalFundedMinor: 219_000,
  leftoverMinor: 241_000,
  householdLeftoverMinor: 128_600,
  shortfallMinor: 0,
  members: [
    {
      userId: "alex",
      displayName: "Alex",
      shareBp: 6_000,
      monthlyIncomeMinor: 260_000,
      obligationMinor: 131_400,
      fundedMinor: 131_400,
      leftoverMinor: 128_600,
      shortfallMinor: 0,
    },
    {
      userId: "bo",
      displayName: "Bo",
      shareBp: 4_000,
      monthlyIncomeMinor: 200_000,
      obligationMinor: 87_600,
      fundedMinor: 87_600,
      leftoverMinor: 112_400,
      shortfallMinor: 0,
    },
  ],
  accounts: [
    {
      accountId: "bills",
      name: "Bills joint",
      role: "shared",
      memberUserId: null,
      currency: "GBP",
      monthlyIncomeMinor: 0,
      requiredOutflowMinor: 219_000,
      fundedOutflowMinor: 219_000,
      transferInMinor: 219_000,
      transferOutMinor: 0,
      leftoverMinor: 0,
      shortfallMinor: 0,
    },
    {
      accountId: "alex-current",
      name: "Alex current",
      role: "personal",
      memberUserId: "alex",
      currency: "GBP",
      monthlyIncomeMinor: 260_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 131_400,
      leftoverMinor: 128_600,
      shortfallMinor: 0,
    },
  ],
  lines: [],
  transfers: [],
};

/** The two tables in the order the view renders them. */
function tables(container: HTMLElement): HTMLTableElement[] {
  return [...container.querySelectorAll("table")];
}

/** A table's headers, and which of them a phone keeps. */
function headers(table: HTMLTableElement): { all: string[]; kept: string[] } {
  const th = [...table.querySelectorAll("thead th")];
  return {
    all: th.map((h) => h.textContent ?? ""),
    kept: th.filter((h) => !h.classList.contains("wide-only")).map((h) => h.textContent ?? ""),
  };
}

// What jsdom can see of the narrow layout: the wrapper, the pinned column, and
// which columns are marked to drop. Whether the document actually stops
// scrolling sideways at 390px is a measurement, not an assertion.
describe("HouseholdPlanView · narrow layout", () => {
  it("scrolls each table inside a wrapper rather than dragging the document", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    for (const table of tables(container)) {
      expect(table.parentElement).toHaveClass("table-scroll");
    }
  });

  it("pins the first column of both tables", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    for (const table of tables(container)) {
      expect(table.querySelector("thead th")).toHaveClass("sticky-col");
      for (const row of table.querySelectorAll("tbody tr")) {
        expect(row.firstElementChild).toHaveClass("sticky-col");
      }
    }
  });

  it("keeps five columns per table on a phone, and the same five shape twice", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const [perAccount, perPerson] = tables(container);

    expect(headers(perAccount!).kept).toEqual([
      "account",
      "transfer in",
      "transfer out",
      "left over",
      "shortfall",
    ]);
    expect(headers(perPerson!).kept).toEqual([
      "member",
      "income",
      "their costs",
      "left over",
      "shortfall",
    ]);

    // Every dropped header has exactly one dropped cell under it in each row —
    // a column half-hidden would misalign the rest.
    for (const table of tables(container)) {
      const { all, kept } = headers(table);
      const dropped = all.length - kept.length;
      for (const row of table.querySelectorAll("tbody tr")) {
        expect(row.querySelectorAll("td.wide-only")).toHaveLength(dropped);
      }
    }
  });

  it("folds the role and the income into a sub-line under the account", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const [pot, personal] = tables(container)![0]!.querySelectorAll("tbody .row-sub");

    // A shared pot has no income of its own, so it is the role and nothing else.
    expect(pot).toHaveTextContent("shared pot");
    expect(pot?.querySelector(".amount")).toBeNull();

    expect(personal).toHaveTextContent("Alex · income £2,600.00");
    // Money in the sub-line still has to be something privacy mode can blur.
    expect(personal?.querySelector(".amount")).toHaveTextContent("£2,600.00");
  });

  it("folds the share into a sub-line under the member", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const subs = tables(container)![1]!.querySelectorAll("tbody .row-sub");
    expect([...subs].map((s) => s.textContent)).toEqual(["60% share", "40% share"]);
  });
});

/**
 * Decision 13 on screen: `leftoverMinor` keeps its meaning on the wire, and
 * every figure a person reads here is free-after-committed — which is also the
 * number the account page and the flow diagram print for the same account.
 * Printing the raw field is how this page came to read £2,793 against the
 * diagram's £2,093 (ONE-ENGINE.md).
 */
describe("HouseholdPlanView · the committed bucket", () => {
  /** Alex sweeps £400 a month into an ISA outside the household. */
  const WITH_SAVINGS: HouseholdPlanDto = {
    ...PLAN,
    committedMinor: 40_000,
    members: PLAN.members.map((m) =>
      m.userId === "alex" ? { ...m, committedMinor: 40_000 } : { ...m, committedMinor: 0 },
    ),
    accounts: PLAN.accounts.map((a) =>
      a.accountId === "alex-current"
        ? { ...a, committedMinor: 40_000 }
        : { ...a, committedMinor: 0 },
    ),
  };

  /** The cells of one table row, by the header above each. */
  function cells(table: HTMLTableElement, rowIndex: number): Record<string, string> {
    const heads = [...table.querySelectorAll("thead th")].map((h) => h.textContent ?? "");
    const row = [...table.querySelectorAll("tbody tr")][rowIndex]!;
    return Object.fromEntries(
      [...row.querySelectorAll("td")].map((td, i) => [heads[i]!, td.textContent ?? ""]),
    );
  }

  it("leads with what is free after committed, and names the committed alongside", () => {
    const { container } = render(<HouseholdPlanView plan={WITH_SAVINGS} />);
    const kpis = [...container.querySelectorAll(".kpi")].map((k) => k.textContent ?? "");

    expect(kpis).toContainEqual(expect.stringContaining("committed£400.00"));
    // £1,286 in the household's accounts, £400 of it already spoken for.
    expect(kpis).toContainEqual(expect.stringContaining("left over£886.00"));
    // Neither the members' scope-wide surplus nor that surplus net of the
    // committed — both are figures over accounts this page does not list.
    expect(kpis.join(" ")).not.toContain("£2,410.00");
    expect(kpis.join(" ")).not.toContain("£2,010.00");
  });

  it("shows the same subtraction per account and per member", () => {
    const { container } = render(<HouseholdPlanView plan={WITH_SAVINGS} />);
    const [perAccount, perPerson] = tables(container);

    expect(cells(perAccount!, 1)).toMatchObject({
      account: expect.stringContaining("Alex current"),
      committed: "£400.00",
      "left over": "£886.00",
    });
    // The pot commits nothing, so its row says so rather than repeating a zero.
    expect(cells(perAccount!, 0)).toMatchObject({ committed: "—", "left over": "£0.00" });
    expect(cells(perPerson!, 0)).toMatchObject({ committed: "£400.00", "left over": "£886.00" });
    expect(cells(perPerson!, 1)).toMatchObject({ committed: "—", "left over": "£1,124.00" });
  });

  it("leaves the column out entirely for a household that has committed nothing", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    for (const table of tables(container)) {
      expect(headers(table).all).not.toContain("committed");
    }
    // ...and the headline is the plain figure, unchanged to the penny.
    expect([...container.querySelectorAll(".kpi")].map((k) => k.textContent)).toContainEqual(
      expect.stringContaining("left over£1,286.00"),
    );
  });
});

/**
 * WP-Z: the headline and the table beneath it are one sum.
 *
 * `leftoverMinor` was the only scope-wide figure in a KPI row of household-only
 * ones — the fourth instance of "a figure derived over the scope published as
 * the household's" — and the row read as if it were not. A household holding
 * nothing but its bills pot reported income £0, required £1,410 and left over
 * £2,000: a headline derived from income its own income figure does not
 * contain, over accounts its own account table does not list.
 */
describe("HouseholdPlanView · the headline is the accounts it lists", () => {
  /** The reported shape: the household holds the shared pot and nothing else. */
  const POT_ONLY: HouseholdPlanDto = {
    ...PLAN,
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 141_000,
    totalFundedMinor: 141_000,
    // Both members' whole surplus, none of it in an account below.
    leftoverMinor: 200_000,
    householdLeftoverMinor: 0,
    accounts: [
      {
        ...PLAN.accounts[0]!,
        requiredOutflowMinor: 141_000,
        fundedOutflowMinor: 141_000,
        transferInMinor: 141_000,
      },
    ],
  };

  it("reports what is in the household's accounts, not what its members hold", () => {
    const { container } = render(<HouseholdPlanView plan={POT_ONLY} />);
    const kpis = [...container.querySelectorAll(".kpi")].map((k) => k.textContent ?? "");
    expect(kpis).toContainEqual(expect.stringContaining("left over£0.00"));
    expect(kpis.join(" ")).not.toContain("£2,000.00");
  });

  it("says an income of £0 is an income of £0, and where the money comes from", () => {
    const { container } = render(<HouseholdPlanView plan={POT_ONLY} />);
    const kpis = [...container.querySelectorAll(".kpi")].map((k) => k.textContent ?? "");
    expect(kpis[0]).toContain("monthly income£0.00");
    expect(kpis[0]).toContain("+ £1,410.00 arriving by transfer");
  });

  it("adds up to the LEFT OVER column printed beneath it, in every fixture", () => {
    for (const plan of [PLAN, POT_ONLY]) {
      const { container } = render(<HouseholdPlanView plan={plan} />);
      const column = plan.accounts.reduce(
        (sum, a) => sum + (a.leftoverMinor - (a.committedMinor ?? 0)),
        0,
      );
      expect([...container.querySelectorAll(".kpi")].map((k) => k.textContent)).toContainEqual(
        expect.stringContaining(`left over${formatMinor(column, plan.currency)}`),
      );
    }
  });

  it("names whose money it means, whether or not anything is committed", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const kpi = [...container.querySelectorAll(".kpi")].find((k) =>
      k.textContent?.startsWith("left over"),
    )!;
    expect(kpi.querySelector(".kpi-delta")).toHaveTextContent("these members', added up");
  });

  /**
   * Decision 19, and the whole point of the figure: a household's left over is
   * its members' left overs added up, so the per-person table's LEFT OVER
   * column sums to the KPI above it.
   *
   * The fixture is the cross-owner case, the only shape that tells the
   * ownership basis from the roster basis: an authored £400 of Bo's lands in a
   * pot Alex owns and is not spent there, so it is in Alex's residual and out
   * of Bo's. The old derivation printed £2,800 over a member column reading
   * £1,600 and £800; these are £2,100 and £800, and they add to £2,900.
   */
  it("prints the members' sum, and the member rows add up to it", () => {
    const crossOwner: HouseholdPlanDto = {
      ...PLAN,
      committedMinor: 50_000,
      householdLeftoverMinor: 330_000,
      membersLeftoverMinor: 290_000,
      members: [
        { ...PLAN.members[0]!, personalLeftoverMinor: 210_000, committedMinor: 10_000 },
        { ...PLAN.members[1]!, personalLeftoverMinor: 80_000, committedMinor: 40_000 },
      ],
    };
    const { container } = render(<HouseholdPlanView plan={crossOwner} />);

    const kpi = [...container.querySelectorAll(".kpi")].find((k) =>
      k.textContent?.startsWith("left over"),
    )!;
    expect(kpi.querySelector(".kpi-value")).toHaveTextContent("£2,900.00");

    // The per-person table is the second one; LEFT OVER is its
    // second-from-last cell.
    const people = container.querySelectorAll("table")[1]!;
    const cells = [...people.querySelectorAll("tbody tr")].map((r) => {
      const tds = r.querySelectorAll("td");
      return tds[tds.length - 2]!.textContent;
    });
    expect(cells).toEqual(["£2,100.00", "£800.00"]);
  });

  /** A payload from an API that predates the field means what it always did. */
  it("falls back to the scope-wide figure when the API sent none", () => {
    const older: HouseholdPlanDto = { ...PLAN };
    delete older.householdLeftoverMinor;
    const { container } = render(<HouseholdPlanView plan={older} />);
    expect([...container.querySelectorAll(".kpi")].map((k) => k.textContent)).toContainEqual(
      expect.stringContaining("left over£2,410.00"),
    );
  });
});

/**
 * The residual the pass stopped flooring, in a table cell.
 *
 * Measured in a browser: an account committed to sending out more than reaches
 * it — decision 11's member holding income somewhere other than the account
 * their transfers leave — printed **-£244.00 in green**. The pass reports the
 * sign so the screen can say the thing to do; a green minus says the opposite.
 */
describe("HouseholdPlanView · an account that has to be consolidated into", () => {
  const consolidating: HouseholdPlanDto = {
    ...PLAN,
    accounts: PLAN.accounts.map((a) =>
      a.accountId === "alex-current"
        ? { ...a, monthlyIncomeMinor: 50_000, transferOutMinor: 74_400, leftoverMinor: -24_400 }
        : a,
    ),
  };

  it("colours a negative left-over as a warning, never as a month that works", () => {
    const { container } = render(<HouseholdPlanView plan={consolidating} />);
    const row = [...tables(container)[0]!.querySelectorAll("tbody tr")][1]!;
    const cell = [...row.querySelectorAll("td")].find((td) =>
      td.textContent?.includes("-£244.00"),
    )!;
    expect(cell).toHaveClass("warn");
    expect(cell).not.toHaveClass("ok");
  });
});

/**
 * The figure that exceeded its own breakdown.
 *
 * THEIR COSTS is what the pass attributes to a person across the whole scope;
 * the lines and bars beneath this table cover only the household's own accounts.
 * Decision 9 made those two sets differ — Alex has a rent pot of his own, fed by
 * a transfer the plan derives — so the cell printed a figure nothing on the page
 * added up to, and nothing said why. The household view publishes the split now.
 */
describe("HouseholdPlanView · costs the household's lines do not carry", () => {
  const elsewhere: HouseholdPlanDto = {
    ...PLAN,
    members: PLAN.members.map((m) =>
      m.userId === "alex"
        ? {
            ...m,
            householdObligationMinor: 101_080,
            householdFundedMinor: 101_080,
            elsewhereObligationMinor: 30_320,
            elsewhereFundedMinor: 30_320,
          }
        : { ...m, elsewhereObligationMinor: 0, elsewhereFundedMinor: 0 },
    ),
  };

  it("says how much of a member's costs is somewhere this page is not", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const rows = [...tables(container)[1]!.querySelectorAll("tbody tr")];
    expect(rows[0]).toHaveTextContent("£1,314.00");
    expect(rows[0]!.querySelector(".cell-note")).toHaveTextContent("incl. £303.20 elsewhere");
    // ...and reconciles: what is left is exactly what the lines beneath carry.
    expect(131_400 - 30_320).toBe(101_080);
  });

  it("says nothing at all for a member whose costs are all in the household", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const rows = [...tables(container)[1]!.querySelectorAll("tbody tr")];
    expect(rows[1]!.querySelector(".cell-note")).toBeNull();
  });
});

/**
 * The same shape one column back, and the one `f3acef8` created.
 *
 * Closing ownership and household assignment into one relation put every account
 * a member owns into one scope with the household's, so a salary paid into an
 * account nobody assigned here now funds their household share — and shows in
 * INCOME, which is scope-wide like every other cell on the row. Bo banks
 * entirely outside this household: the £2,000 was in the figure and in nothing
 * the account table above it holds.
 *
 * The amount is published and the account is not (Ben, 2026-08-05): a co-member
 * reads it to judge whether the hand-set share split still makes sense, and
 * which account it lands in tells them nothing they need.
 */
describe("HouseholdPlanView · income the household's accounts do not hold", () => {
  /** Alex's salary lands in a household account; Bo's lands nowhere near one. */
  const elsewhere: HouseholdPlanDto = {
    ...PLAN,
    members: [
      { ...PLAN.members[0]!, householdIncomeMinor: 260_000, elsewhereIncomeMinor: 0 },
      { ...PLAN.members[1]!, householdIncomeMinor: 0, elsewhereIncomeMinor: 200_000 },
    ],
  };

  /** The INCOME cell of one person row — column three, after the folding share. */
  const incomeCell = (container: HTMLElement, row: number): HTMLTableCellElement =>
    [...tables(container)[1]!.querySelectorAll("tbody tr")[row]!.querySelectorAll("td")][2]!;

  it("says how much of a member's income is somewhere this page is not", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const cell = incomeCell(container, 1);
    expect(cell).toHaveTextContent("£2,000.00");
    expect(cell.querySelector(".cell-note")).toHaveTextContent("incl. £2,000.00 elsewhere");
    // The amount, and no route to the account it arrives in.
    expect(cell.textContent).not.toMatch(/account/i);
  });

  it("says nothing at all for a member who banks entirely in the household", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    expect(incomeCell(container, 0).querySelector(".cell-note")).toBeNull();
  });

  /**
   * The column itself never goes away — the mistake WP-AA made one column along,
   * where COMMITTED was gated on the household's total and vanished for a
   * household whose members commit only elsewhere. Income has no such gate to
   * get wrong: everyone on this table has some, wherever it lands, and a page
   * with no elsewhere income anywhere still owes every member the figure.
   */
  it("prints the income column for a payload that has never heard of the split", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    expect(incomeCell(container, 0)).toHaveTextContent("£2,600.00");
    expect(incomeCell(container, 1)).toHaveTextContent("£2,000.00");
    expect(tables(container)[1]!.querySelectorAll("tbody .cell-note")).toHaveLength(0);
  });
});

/**
 * The same shape one column along, and the money it was paying people twice.
 *
 * Every cell on a per-person row is scope-wide — their income, their costs,
 * their leftover, their shortfall — and COMMITTED was this household's accounts
 * only. So LEFT OVER netted a narrow figure against a wide one and handed the
 * member back whatever they commit out of an account the household does not
 * hold. Measured in a browser: Alice read £2,154 free while £1,150 of it was
 * already promised to two savings movements leaving her own current account.
 */
describe("HouseholdPlanView · what a member commits elsewhere", () => {
  /** Alex commits £400 out of a household account and £250 out of a private
   *  one; Bo commits £120, all of it outside. */
  const elsewhere: HouseholdPlanDto = {
    ...PLAN,
    committedMinor: 40_000,
    members: [
      { ...PLAN.members[0]!, committedMinor: 40_000, elsewhereCommittedMinor: 25_000 },
      { ...PLAN.members[1]!, committedMinor: 0, elsewhereCommittedMinor: 12_000 },
    ],
    accounts: PLAN.accounts.map((a) =>
      a.accountId === "alex-current"
        ? { ...a, committedMinor: 40_000 }
        : { ...a, committedMinor: 0 },
    ),
  };

  function personRows(container: HTMLElement): Element[] {
    return [...tables(container)[1]!.querySelectorAll("tbody tr")];
  }

  it("prints everything a member has committed, and names the part that is not here", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const [alex, bo] = personRows(container);
    expect(alex).toHaveTextContent("£650.00");
    expect(alex!.querySelector(".cell-note")).toHaveTextContent("incl. £250.00 elsewhere");
    // All of Bo's is elsewhere, which is a whole and not a part — the cell says
    // the total, and the note says where it is.
    expect(bo).toHaveTextContent("£120.00");
    expect(bo!.querySelector(".cell-note")).toHaveTextContent("incl. £120.00 elsewhere");
  });

  it("takes both off the member's left over", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const [alex, bo] = personRows(container);
    // £1,286 − £400 − £250, and £1,124 − £120.
    expect(alex!.lastElementChild!.previousElementSibling).toHaveTextContent("£636.00");
    expect(bo!.lastElementChild!.previousElementSibling).toHaveTextContent("£1,004.00");
  });

  it("leaves the household's own figures untouched by it", () => {
    // Decision 4/13: added alongside. The KPI row and the account table are
    // this household's accounts and know nothing of a member's private ISA.
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const kpis = [...container.querySelectorAll(".kpi")].map((k) => k.textContent ?? "");
    expect(kpis).toContainEqual(expect.stringContaining("committed£400.00"));
    expect(kpis).toContainEqual(expect.stringContaining("left over£886.00"));
    // What the headline would read if a member's private commitments leaked
    // into a figure about this household's accounts.
    expect(kpis.join(" ")).not.toContain("£516.00");
  });

  /**
   * The column the household's own total would have hidden. Nothing leaves a
   * household account here, so `plan.committedMinor` is nought — and both
   * members' LEFT OVER is reduced all the same. A page that showed the
   * subtraction and not the reason is the one reading a figure must never get.
   */
  it("shows the column for commitments that are all outside the household", () => {
    const outside: HouseholdPlanDto = {
      ...elsewhere,
      committedMinor: 0,
      members: elsewhere.members.map((m) => ({ ...m, committedMinor: 0 })),
      accounts: PLAN.accounts.map((a) => ({ ...a, committedMinor: 0 })),
    };
    const { container } = render(<HouseholdPlanView plan={outside} />);
    const [perAccount, perPerson] = tables(container);
    expect(headers(perPerson!).all).toContain("committed");
    // The account table is the household's accounts and still has nothing to
    // say, so it keeps its column count.
    expect(headers(perAccount!).all).not.toContain("committed");
    expect(personRows(container)[0]).toHaveTextContent("£250.00");
    expect(personRows(container)[0]!.lastElementChild!.previousElementSibling).toHaveTextContent(
      "£1,036.00",
    );
  });

  /**
   * The mirror: a household whose only movement leaves the shared pot. Nobody's
   * row has anything to say, and a column of em dashes on a table about people
   * is a concept asking to be understood for no reason.
   */
  it("leaves the column out when the movements are all the household's own", () => {
    const potOnly: HouseholdPlanDto = {
      ...PLAN,
      committedMinor: 5_000,
      members: PLAN.members.map((m) => ({ ...m, committedMinor: 0, elsewhereCommittedMinor: 0 })),
      accounts: PLAN.accounts.map((a) =>
        a.accountId === "bills" ? { ...a, committedMinor: 5_000 } : { ...a, committedMinor: 0 },
      ),
    };
    const { container } = render(<HouseholdPlanView plan={potOnly} />);
    const [perAccount, perPerson] = tables(container);
    expect(headers(perAccount!).all).toContain("committed");
    expect(headers(perPerson!).all).not.toContain("committed");
  });
});

/**
 * **Decision 25.** Two cells on this page hold money the reader's arithmetic
 * cannot account for, and until now only their neighbours said so.
 *
 * The figures are the cross-owner fixture's, read off a real browser: Alice's
 * row prints income £2,000, their costs £300, committed £100 and a left over of
 * £2,100 — a reader adding it up gets £1,600 — while the account table's LEFT
 * OVER column adds to £2,800 under a KPI of £2,900. The £400 is Bob's money in
 * a pot Alice owns; the £100 is an ISA of hers the household does not hold.
 */
describe("HouseholdPlanView · money that is somebody else's", () => {
  /** The cross-owner household, as the API now publishes it. */
  const CROSS: HouseholdPlanDto = {
    householdId: "hh-x",
    asOfDate: "2026-08-04",
    currency: "GBP",
    monthlyIncomeMinor: 350_000,
    totalRequiredMinor: 60_000,
    totalFundedMinor: 60_000,
    leftoverMinor: 290_000,
    householdLeftoverMinor: 330_000,
    membersLeftoverMinor: 290_000,
    committedMinor: 50_000,
    shortfallMinor: 0,
    members: [
      {
        userId: "alice",
        displayName: "Alice",
        shareBp: 5_000,
        monthlyIncomeMinor: 200_000,
        obligationMinor: 30_000,
        fundedMinor: 30_000,
        leftoverMinor: 170_000,
        committedMinor: 10_000,
        personalLeftoverMinor: 210_000,
        arrivedFromOthers: [{ ownerUserId: "bob", amountMinor: 40_000 }],
        shortfallMinor: 0,
      },
      {
        userId: "bob",
        displayName: "Bob",
        shareBp: 5_000,
        monthlyIncomeMinor: 150_000,
        obligationMinor: 30_000,
        fundedMinor: 30_000,
        leftoverMinor: 120_000,
        committedMinor: 40_000,
        personalLeftoverMinor: 80_000,
        shortfallMinor: 0,
      },
    ],
    accounts: [
      {
        accountId: "pot",
        name: "House pot",
        role: "shared",
        memberUserId: null,
        currency: "GBP",
        monthlyIncomeMinor: 0,
        requiredOutflowMinor: 60_000,
        fundedOutflowMinor: 60_000,
        transferInMinor: 60_000,
        transferOutMinor: 0,
        leftoverMinor: 40_000,
        shortfallMinor: 0,
      },
      {
        accountId: "alice-cur",
        name: "Alice current",
        role: "personal",
        memberUserId: "alice",
        currency: "GBP",
        monthlyIncomeMinor: 200_000,
        requiredOutflowMinor: 0,
        fundedOutflowMinor: 0,
        transferInMinor: 0,
        transferOutMinor: 30_000,
        leftoverMinor: 170_000,
        committedMinor: 10_000,
        shortfallMinor: 0,
      },
      {
        accountId: "bob-cur",
        name: "Bob current",
        role: "personal",
        memberUserId: "bob",
        currency: "GBP",
        monthlyIncomeMinor: 150_000,
        requiredOutflowMinor: 0,
        fundedOutflowMinor: 0,
        transferInMinor: 0,
        transferOutMinor: 30_000,
        leftoverMinor: 120_000,
        committedMinor: 40_000,
        shortfallMinor: 0,
      },
    ],
    lines: [],
    transfers: [],
  };

  const leftOverCell = (row: Element): Element => row.lastElementChild!.previousElementSibling!;

  it("names whose money is in a member's left over", () => {
    const { container } = render(<HouseholdPlanView plan={CROSS} />);
    const [alice, bob] = [...tables(container)[1]!.querySelectorAll("tbody tr")];

    // The figure is untouched — this is a label, not arithmetic.
    expect(leftOverCell(alice!)).toHaveTextContent("£2,100.00");
    expect(leftOverCell(alice!)).toHaveTextContent("incl. £400.00 that arrived from Bob");
    // Nothing of anybody else's is in Bob's, so his cell says nothing.
    expect(leftOverCell(bob!)).toHaveTextContent("£800.00");
    expect(leftOverCell(bob!).querySelector(".cell-note")).toBeNull();
  });

  it("uses the same note the cells beside it use", () => {
    const { container } = render(<HouseholdPlanView plan={CROSS} />);
    const [alice] = [...tables(container)[1]!.querySelectorAll("tbody tr")];
    expect(leftOverCell(alice!).querySelector(".cell-note")).not.toBeNull();
  });

  it("says nothing when nobody else's money is in anybody's accounts", () => {
    const own: HouseholdPlanDto = {
      ...CROSS,
      members: CROSS.members.map((m) => ({ ...m, arrivedFromOthers: [] })),
    };
    const { container } = render(<HouseholdPlanView plan={own} />);
    for (const row of tables(container)[1]!.querySelectorAll("tbody tr")) {
      expect(leftOverCell(row).querySelector(".cell-note")).toBeNull();
    }
  });

  it("names the money the household does not hold under the account column", () => {
    const { container } = render(<HouseholdPlanView plan={CROSS} />);
    const foot = tables(container)[0]!.querySelector("tfoot tr")!;

    // The column adds to £2,800; the KPI above reads £2,900.
    expect(foot).toHaveTextContent("these accounts");
    expect(foot).toHaveTextContent("£2,800.00");
    expect(foot).toHaveTextContent("plus £100.00 elsewhere");
    expect(foot.querySelector(".cell-note")).not.toBeNull();
    // Under the LEFT OVER column and no other: same cell count as a body row.
    const body = tables(container)[0]!.querySelector("tbody tr")!;
    expect(foot.children).toHaveLength(body.children.length);
  });

  it("draws no footer when the column already adds to the figure above it", () => {
    const held: HouseholdPlanDto = { ...CROSS, membersLeftoverMinor: 280_000 };
    const { container } = render(<HouseholdPlanView plan={held} />);
    expect(tables(container)[0]!.querySelector("tfoot")).toBeNull();
  });

  it("describes an owner it cannot name rather than printing their id", () => {
    // An owner the roster cannot name is described, never printed as an id.
    const stranger: HouseholdPlanDto = {
      ...CROSS,
      members: CROSS.members.map((m) =>
        m.userId === "alice"
          ? { ...m, arrivedFromOthers: [{ ownerUserId: "u-nobody", amountMinor: 40_000 }] }
          : m,
      ),
    };
    const { container } = render(<HouseholdPlanView plan={stranger} />);
    const [alice] = [...tables(container)[1]!.querySelectorAll("tbody tr")];
    expect(leftOverCell(alice!)).toHaveTextContent(
      "incl. £400.00 that arrived from somebody outside the household",
    );
    expect(leftOverCell(alice!).textContent).not.toContain("u-nobody");
  });
});
