# Implementation plan — an account inside a household knows it

Agreed 2026-08-04. Written to be picked up cold by a fresh agent; read it in full
before starting. Conventions and the definition of done are inherited from
[`REDESIGN.md`](./REDESIGN.md) — integer minor units, explicit `asOfDate`, Store
parity (Memory + Pg + contract test) for data changes, plain CSS through design
tokens, no new dependencies, stage only owned paths, never `git add -A`.

---

## The problem

An account assigned to a household is planned twice, by two engines that never speak.

`computePlanForAccount` (`apps/api/src/plan.ts:88`) builds its input purely from the
account's own incomes and payments. A bills pot has no income of its own, so its budget
is £0, nothing can be funded, and every line comes back `at risk` with
`shortfallMinor === totalRequiredMinor`.

The household engine already knows better. `HouseholdAccountPlan.transferInMinor`
(`packages/domain/src/household.ts:118`) holds the money it has allocated into that
account. The figure is correct and it has no channel into the account-level plan.

Observed: household plan says `All 11 payments funded · £5,836.77 left over` and asks for
one transfer of £303.20 into the bills pot. The bills pot's own page says
`REQUIRED £303.20 · SHORTFALL £303.20`, every line `at risk`. Both are computing
correctly. One is computing with a missing input.

## Two defects, deliberately kept separate

**D1 — income blindness.** The account plan cannot see allocated inflow. Structural.

**D2 — `onTrack` is overloaded.** `PaymentPlanLine.onTrack` is a boolean
(`engine.ts:204`, `funded >= required`). It cannot distinguish:

- _the plan cannot fund this_ — you are genuinely short; the remedy is to cut something
  or raise a share;
- _the plan funds this, you have not moved the money_ — the remedy is to make a transfer.

Both render red `at risk` today (`PlanTable.tsx:196-203`). Different problems, different
actions, same colour.

## Explicitly out of scope

A pot's **balance is not its saved figure**. The screenshot shows `balance £358.89` against
`saved £0.00` on every line, because `saved` is `alreadySavedMinor` + recorded
contributions, and a pooled balance cannot say which of 11 payments it belongs to. That is
the deliberate record-vs-check-in distinction and it is working as designed. It does mean a
bills pot that always holds enough will nag until contributions are recorded — a real
question about whether the save-up model fits a pass-through pot, but a **different** piece
of work. Do not solve it here.

## Decisions already taken (do not relitigate)

1. **Planned-but-unconfirmed transfers count as funded** for the arithmetic, but carry a
   distinct status so the contingency is visible.
2. **The fix goes into the account plan itself**, not the account page's presentation.
   A display-only patch would leave two sources of truth — the same class of defect as the
   two-balances bug fixed in `24f806e`.
3. **Own income and allocated inflow are separate fields.** Folding inflow into
   `monthlyIncomeMinor` would double-count the same money in any aggregate that sums income
   across accounts (the accounts index already displays it per account).
4. **`onTrack` stays**, meaning "the plan covers it". The new axis is added alongside, so
   existing consumers keep working.

There is **no circularity**: required outflow does not depend on income, only funding does.
The order is: compute requirements → household allocates → fund each account from own
income plus allocation.

**No schema change is expected.** Everything here is derived; transfer confirmations are
already persisted. If you conclude a migration is genuinely required, **stop and report**
rather than writing one.

---

## WP-A · Domain: the account plan accepts allocated inflow

**Goal:** `computeAccountPlan` can be told what is arriving, and reports how each line was
funded.

- `AccountPlanInput` gains an optional inflow describing what the household has allocated
  this month and how much of it is **confirmed**. Optional so a standalone account is
  unchanged.
- Budget becomes own income + allocated inflow. Funding order is untouched.
- `PaymentPlanLine` gains `fundedFromOwnMinor` and `fundedFromInflowMinor` (they sum to
  `fundedMinor`). Funding is already priority-ordered, so the split falls out of walking the
  budget: own income is consumed first, inflow second.
- `PaymentPlanLine` gains `status: "funded" | "awaiting_transfer" | "at_risk"`, derived:
  - `at_risk` when `!onTrack`;
  - `awaiting_transfer` when `onTrack` and the line drew on **unconfirmed** inflow;
  - `funded` otherwise.
    `onTrack` keeps its current meaning and value.
- `AccountPlan` gains `allocatedInflowMinor` and `confirmedInflowMinor`.
  `monthlyIncomeMinor` continues to mean **own income only** — do not change it.
- `shortfallMinor` must go to 0 when inflow covers the gap. `leftoverMinor` must not count
  inflow that was never needed as the account's surplus without saying so — decide and
  document which, and test it.

**Acceptance:** a standalone account's plan is byte-identical to today (pin it); an account
with fully-confirmed inflow reports `funded` and zero shortfall; with unconfirmed inflow
reports `awaiting_transfer` and zero shortfall; with insufficient inflow reports `at_risk`
for the uncovered lines only, and the own/inflow split sums to `fundedMinor` on every line.

Owns: `packages/domain/src/engine.ts`, `packages/domain/src/types.ts`, their tests.
Size **M**. Depends: none. **Coverage gate applies** (≥95% lines / ≥80% branches).

## WP-B · API: supply the allocation

**Goal:** every read that plans an account in a household passes it the household's allocation.

- Where an account is assigned to a household, compute the household plan, take that
  account's `transferInMinor`, and pass it — together with how much is confirmed this month
  (transfer confirmations are already stored) — into the account plan.
- **`buildAccountInput` / `loadAccountInputs` is the choke point** (`apps/api/src/plan.ts`).
  Everything that reasons about an account's money goes through it: the plan endpoint, the
  projection, upcoming, the overview handler, the digest. Fix it there, once, rather than at
  each call site.
- **Access control:** the inflow _amount_ is a fact about an account the caller can already
  see, so it may always be surfaced. **Naming the source member** must be gated on the caller
  being able to view the household — an account can be shared with someone who is not a
  household member. Get this right and test it.
- **Performance:** this makes an account-page read compute a household plan. Measure it.
  If a single request would compute the same household plan more than once (the overview
  handler plans every account), memoise per request. Report the measured before/after cost;
  do not add a cache layer speculatively.

**Acceptance:** API tests for a standalone account (unchanged), an account in a household
with an unconfirmed transfer, the same after confirmation, and the access-control case where
the viewer may see the account but not the household. Plus a **double-count guard**: the sum
of `monthlyIncomeMinor` across an estate must not change when an account starts receiving
inflow.

Owns: `apps/api/src/plan.ts`, `apps/api/src/server.ts`, `apps/api/src/server.test.ts`.
Size **M–L**. Depends: WP-A.

## WP-C · Projection consistency

**Goal:** the bills pot stops projecting itself into the ground.

`packages/domain/src/projection.ts` walks months forward. With WP-A/B a pooled account now
has recurring inflow, and the projection must reflect it or it will show a funded account
draining to nothing.

Decide and document whether inflow is projected as recurring (it is planned monthly, so
probably yes) and what happens when the plan changes mid-horizon. `upcoming.ts` is about due
dates, not funding — confirm it needs no change rather than assuming.

**Acceptance:** projection test for a pooled account showing a stable or rising reserve
rather than a declining one; explicit test that a standalone account's projection is
unchanged.

Owns: `packages/domain/src/projection.ts` + tests. Size **S–M**. Depends: WP-A.

## WP-D · Web: the third status, everywhere it shows

**Goal:** the UI can say "waiting on you to move money" instead of "you are short".

- `PlanTable.tsx:196-203` renders the tri-state. `awaiting_transfer` needs its own
  treatment — **`--needs-you` (amber), not `--alert` (red)**; red means the plan cannot cover
  it. The row tint (`.plan-table tr.at-risk`) needs the same split.
- Account page KPI row: with `monthlyIncomeMinor` £0 and inflow £303.20, the header must
  read honestly — e.g. `no income of its own · £303.20 arriving from Ben this month` — and
  `SHORTFALL` must show `—` rather than `£303.20`. This is the screen that prompted the work;
  it must be unambiguous.
- Accounts index chips (`deriveAttention` in `pages/AccountsPage.tsx`): `unfunded £X` red
  must not fire for an account the household funds. Add the awaiting-transfer tone.
- Use existing tokens and the `.tag-status.*` classes; **no new hex** (a grep test enforces
  that the only hex in `src/` is `FALLBACK_CHART_COLORS`).

**Acceptance:** component tests for all three statuses; a test that a household-funded
account shows no red anywhere; the account page KPI test.

Owns: `apps/web/src/components/PlanTable.tsx`, `apps/web/src/pages/AccountPage.tsx`,
`apps/web/src/pages/AccountsPage.tsx`, `apps/web/src/lib/types.ts`, `apps/web/src/styles.css`,
their tests. Size **M**. Depends: WP-A, WP-B.

## WP-E · The checklist must not nag twice

**Goal:** one outstanding thing produces one row.

`lib/needsYou.ts` derives a `shortfall` row per account shortfall and a `transfer` row per
unconfirmed transfer. Once WP-A/B land, a household-funded account's shortfall goes to zero,
so the `shortfall` row should disappear on its own — **verify that, do not assume it.** The
`transfer` row is the correct single prompt.

Check the `record` rule too: lines that are `awaiting_transfer` are not yet money you have
set aside, and prompting to _record_ a contribution before the transfer exists would be
wrong ordering.

**Acceptance:** a fixture reproducing the screenshot (household funds a bills pot, transfer
unconfirmed) yields exactly one row for it — the transfer — and no shortfall row; after
confirmation, the transfer row goes and no shortfall appears.

Owns: `apps/web/src/lib/needsYou.ts` + test. Size **S**. Depends: WP-A, WP-B.

---

## Waves

| Wave | Packages    | Notes                                                         |
| ---- | ----------- | ------------------------------------------------------------- |
| 1    | WP-A        | foundation, runs alone — everything reads these types         |
| 2    | WP-B        | alone; it owns the API choke point                            |
| 3    | WP-C + WP-D | disjoint (domain projection vs web) — parallel-safe           |
| 4    | WP-E        | needs the real shortfall behaviour from 1–2 to verify against |

Two agents may only run concurrently on disjoint file sets. Never two agents on
`apps/web/src/styles.css` or `apps/web/src/lib/api.ts` at once.

## The regression to fear

The engine currently assumes an account's budget comes from its own income. WP-A relaxes
that. Anything that reconciles income against funding — `leftoverMinor`, `shortfallMinor`,
the household engine's own account rollups, the estate-wide income sums on the overview —
must be checked for the assumption, in the same way the ceiling-rounding change
(`b3b3e10`) found two places silently relying on the share split conserving its total.
**Hunt for that assumption; do not assume it is absent.**
