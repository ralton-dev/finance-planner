import { describe, expect, it } from "vitest";
import {
  estate,
  ESTATE_ASOF,
  ESTATE_CONFIRMATION_SHAPES,
  type ConfirmationShape,
} from "./estate.fixture.js";
import { computeScopePlan } from "./scope.js";

/**
 * **The fixture, held to its own intent.**
 *
 * Every other test over the estate asks what the pass makes of it. This one asks
 * whether the estate is still the estate that was written down — because the
 * only figures in it that a domain change can invalidate *silently* are the
 * confirmations, and those are the figures the whole reality loop hangs off.
 *
 * A confirmation is not a number, it is a relationship: £424 is "the whole of
 * it" only against a plan that derives £424. `scope.ts` clamps a confirmation to
 * what the transfer came to, for a good reason — one taken in a month a member
 * owed £300 must not still credit £300 in a month they owe £120 — and the price
 * of that kindness is that a stale figure never fails. It becomes a part-moved
 * one and every assertion downstream, which reads the *clamped* value, still
 * agrees with itself.
 *
 * That happened. `1ea409f` re-netted alice's share of the pot's bills from £594
 * to £424 and left `59_400` in the fixture; `seedEstate` in
 * `apps/api/src/server.test.ts` branches on that exact equality to decide
 * whether to confirm through `POST /api/households/:id/transfers/confirm` or to
 * write straight to the store, took the direct arm, and so booked none of the
 * contributions the endpoint books. The estate WP-C planned, WP-D closed and
 * WP-E rendered had an empty contributions ledger for four packages, and no
 * test anywhere said a word.
 *
 * So the relationship is asserted here, against the **hand-set** figures rather
 * than the clamped ones — the only place the drift is visible at all.
 */

const plan = computeScopePlan(estate.scope, ESTATE_ASOF);

/** The three ways the pass keys a derived transfer, as one readable string. */
const transferKey = (t: { fromAccountId: string; toAccountId: string; memberUserId: string }) =>
  `${t.memberUserId}: ${t.fromAccountId} → ${t.toAccountId}`;

/**
 * What a hand-set figure stands as, against what the pass derives for it.
 *
 * Over-confirmation gets a sentence rather than a shape, because it is neither
 * of the three and it is what staleness looks like from this side: the clamp
 * would swallow it and report a part-moved transfer.
 */
const shapeOf = (
  confirmedMinor: number | undefined,
  derivedMinor: number,
): ConfirmationShape | string =>
  confirmedMinor === undefined || confirmedMinor === 0
    ? "none"
    : confirmedMinor === derivedMinor
      ? "whole"
      : confirmedMinor < derivedMinor
        ? "partial"
        : `over-confirmed — ${confirmedMinor} said against ${derivedMinor} derived`;

describe("the estate's confirmations stand where the fixture says they stand", () => {
  it("stands each derived transfer as declared, against the figure the pass derives", () => {
    const stated = ESTATE_CONFIRMATION_SHAPES.transfers.map((declared) => {
      const derived = plan.transfers.find((t) => transferKey(t) === transferKey(declared))!;
      const handSet = (estate.scope.confirmedTransfers ?? []).find(
        (c) => transferKey(c) === transferKey(declared),
      );
      return [transferKey(declared), shapeOf(handSet?.confirmedMinor, derived.amountMinor)];
    });
    expect(stated).toEqual(
      ESTATE_CONFIRMATION_SHAPES.transfers.map((d) => [transferKey(d), d.shape]),
    );
  });

  it("stands each authored movement as declared, against what the pass moves", () => {
    const arrivals = new Map(
      estate.scope.accounts.flatMap((a) =>
        (a.confirmedArrivals ?? []).map((c) => [c.inflowId, c.confirmedMinor] as const),
      ),
    );
    const stated = ESTATE_CONFIRMATION_SHAPES.movements.map((declared) => {
      const moved = plan.movements.find((m) => m.inflowId === declared.inflowId)!;
      return [declared.inflowId, shapeOf(arrivals.get(declared.inflowId), moved.fundedMinor)];
    });
    expect(stated).toEqual(ESTATE_CONFIRMATION_SHAPES.movements.map((d) => [d.inflowId, d.shape]));
  });

  /**
   * `seedEstate` branches on the **authored** amount and the confirm endpoint
   * books the **funded** one. They are the same number here, and this is what
   * says so: a movement the pass could only part-fund would send the seeder down
   * one arm while the endpoint booked the figure belonging to the other.
   */
  it("funds every authored movement in full, so the seeder and the endpoint mean one figure", () => {
    for (const m of plan.movements) {
      expect([m.inflowId, m.fundedMinor]).toEqual([m.inflowId, m.requestedMinor]);
    }
    expect(plan.movements).toHaveLength(ESTATE_CONFIRMATION_SHAPES.movements.length);
  });

  it("declares every transfer the pass derives, and confirms nothing it does not", () => {
    expect(plan.transfers.map(transferKey).sort()).toEqual(
      ESTATE_CONFIRMATION_SHAPES.transfers.map(transferKey).sort(),
    );
    // And from the other end: a confirmation of a transfer this plan no longer
    // derives is dead weight the pass would drop without comment.
    expect((estate.scope.confirmedTransfers ?? []).map(transferKey).sort()).toEqual(
      ESTATE_CONFIRMATION_SHAPES.transfers
        .filter((d) => d.shape !== "none")
        .map(transferKey)
        .sort(),
    );
  });

  /**
   * The row of the fixture's own table this file exists to keep honest — *mixed
   * confirmed states, full / partial / none, both kinds*. Without it the cheap
   * way past a failure above is to redeclare a stale "whole" as "partial", which
   * is precisely the downgrade that went unnoticed for four packages.
   */
  it("carries all three states in both kinds, which is why the estate has them", () => {
    for (const declared of [
      ESTATE_CONFIRMATION_SHAPES.transfers,
      ESTATE_CONFIRMATION_SHAPES.movements,
    ]) {
      expect(new Set(declared.map((d) => d.shape))).toEqual(
        new Set<ConfirmationShape>(["whole", "partial", "none"]),
      );
    }
  });
});
