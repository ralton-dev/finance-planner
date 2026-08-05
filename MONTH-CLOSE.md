# Implementation plan — closing a month is something a person does

Agreed 2026-08-05, on `main` at `21ec4e1`, tree clean, nothing in flight. Written
to be picked up cold; read it in full before starting. Conventions and the
definition of done are inherited from [`REDESIGN.md`](./REDESIGN.md) and
[`ONE-ENGINE.md`](./ONE-ENGINE.md) — integer minor units, explicit `asOfDate`,
Store parity (Memory + Pg + contract test) for data changes, plain CSS through
design tokens, no new dependencies, stage only owned paths, never `git add -A`.
ONE-ENGINE decisions 1–13 stand; this plan adds 14–18.

**The local gate for every package includes `pnpm build` and
`pnpm exec prettier --check .`** — both are fatal CI jobs, and main was red for
six consecutive pushes because a gate omitted them. The domain coverage gate is
**99.87% statements / 95.84% branches — do not ratchet down.** Nothing here may
touch the auth service (in-process refresh-token rotation state, pinned to
`replicas: 1`).

---

## The problem

A month close is a scorecard — _you earned X, planned Y, set aside Z_ — and the
system currently asks that question of two locations and never of a person.

The two producers of the one `MonthClose` DTO already disagree about what a
field means. The account close (`server.ts:896`) writes
`incomeMinor: plan.monthlyIncomeMinor + plan.confirmedInflowMinor` — money that
_arrived_ counts — behind a nineteen-line comment defending the addition and
asserting the household close is right not to make it. The household close
(`server.ts:1914`) writes `plan.monthlyIncomeMinor` alone. The same
`MonthScorecard` component renders both, so a household holding a fed bills pot
freezes income £0 against a contributed figure fed entirely by transfers — a
scorecard row that can never say anything.

That comment is the evidence, not the bug. It has to _redefine income_ to make
a location scorecard mean anything, then hold the opposite definition correct
one scope over — two meanings of one field, each right for its scope, which is
the signature of a question asked at the wrong altitude. The reasoning was sound
when the household was a calculation boundary. `ONE-ENGINE.md` ended that:
**the unit of planning is the user**, a household is an attribution layer, and
closing a month is freezing the plan — so it inherits the unit. Check-in stays
per-account because a _balance_ genuinely is a fact about a location; a
scorecard is not.

Everything a per-user close needs already exists. `ScopeMemberPlan
.obligationMinor` / `.fundedMinor` are the planned figure per member, split by
`splitByShares` wherever the accounts sit. `core.contributions.user_id` —
_"whose money / who recorded it"_ — is set by all three creation sites
(`server.ts:812`, `:1590`, `:1827`). A member's `monthlyIncomeMinor` is
scope-wide since `f3acef8`, with the `elsewhere*` fields naming its halves. A
per-user close is very nearly a **view of the pass plus a sum over the
contributions ledger** — which is what a close should be: freeze the view,
never invent a second computation.

One real gap: **the pass cannot see account ownership.** `ScopeAccountInput`
carries `memberUserId` ("set when `role === "personal"`") and no owner field, so
`scope.ts:486` attributes income by household _role_ and a shared pot's own
external income belongs to nobody. The comment that justified that behaviour
lived on `computeHouseholdPlan` and died when WP-S deleted it; the behaviour
outlived its justification. `core.accounts.owner_user_id` is `NOT NULL` — every
account has exactly one owner, a "joint" account is one person's account shared
into a household — so there is never an orphan and never an excuse.

## Decisions (14–18, continuing ONE-ENGINE's numbering — do not relitigate)

14. **A month close is per user, per currency.** One row per
    `(user, month, currency)`; one action closes every currency partition the
    user has at once. The account close and the household close are **deleted**
    — handlers, endpoints, client methods, UI. Not kept, not hidden: superseded
    code is deleted, not left. Check-in (balance snapshots) stays per-account.
15. **External income counts for the account's owner, whatever the account's
    role.** The pass gains a required `ownerUserId` per account; the role filter
    at `scope.ts:486` dies. A shared pot's salary-like income joins its owner's
    income and budget exactly as a personal account's does. Transfers — derived
    or authored — are never income (standing invariant, restated). Decision 11
    is untouched: a member's transfer _source_ is still chosen among their
    personal-role accounts. The `0c35284` netting — transport is the funded
    obligation less what the destination pays from its own income — is what
    keeps owned-income-sitting-elsewhere from travelling, and is pinned as part
    of this work.
16. **A close freezes its figures.** Nothing recomputes history: a later
    `contributionShareBp` renegotiation, account move, or plan change must not
    rewrite an existing scorecard row. (Already the model; restated because
    per-user rows freeze share-split attribution.)
17. **Alpha grant (Ben, 2026-08-05).** No close rows exist and nothing matters
    for legacy data: no migration of old rows, no handling for
    null-`user_id` contributions beyond a comment noting the column predates
    the writers that set it.
18. **Second sanctioned exception (Ben, 2026-08-05).** Migration `0013` may
    replace the `month_close_scope` CHECK (`0004_reality_loop.sql:69`, a
    genuine XOR) via a guarded `DO $$` block, re-added **under the same name**
    as an exactly-one-of-three predicate — `0010`'s technique, the cost WP-R
    predicted in ONE-ENGINE wave 1. Only that constraint. Nothing else in this
    plan drops anything.

## Migration constraints — read before writing any SQL

Unchanged: the cluster re-applies **every** `.sql` file in lexical order on
every sync under `psql -v ON_ERROR_STOP=1`. Every statement idempotent; additive
only, bar decision 18; no `DELETE`/`TRUNCATE`; mirrored **byte-identically**
into `deploy/helm/finance-planner/files/` (verify with `cmp`); self-contained
and readable. The new migration is `0013_`.

---

## WP-A · The estate-shaped fixture, and the red pin

**Goal:** the fixture this repo has never had — one shaped like the owner's real
estate — and a specification of the divergence, written first and observed red.

Every fixture in this repo was a user with no household assignments, which is
why a purpose-built parity test and five field-by-field audits all missed a
defect the owner found in thirty seconds on his own screen. So, first, a
reusable fixture builder: **a household of two members with hand-set shares;
personal assigned accounts carrying salaries; a shared pot with external income
of its own; an unassigned bills pot fed by a derived transfer; authored savings
movements to several destinations; mixed confirmed states; and an account in a
second currency.** Exported for every later package's tests — WP-C plans it,
WP-D closes months over it, WP-E renders it.

Second, the red pin, in its own API-level test file: seed that estate, close
the month through **both existing producers**, and assert one scorecard
semantic — the sum of every account close's `incomeMinor` across the household
equals the household close's `incomeMinor`. It does not: the account producer
counts confirmed arrivals, so the sum double-counts every funded transfer.
Landed as `it.fails`, observed failing at `21ec4e1`, with the diverging figures
recorded in a comment. **This pin is deleted by WP-D along with the handlers it
condemns** — its job is to make the defect undeniable and dated, not to turn
green.

**Acceptance:** the fixture builder exercises every feature listed above and is
imported by at least one existing-style test to prove it composes; the pin
demonstrably fails at `21ec4e1` and passes CI as landed (`it.fails`); no
production code is touched.

Owns: `packages/domain/src/estate.fixture.ts` (new),
`apps/api/src/close.divergence.test.ts` (new) — nothing else. Size **S–M**.
Depends: none.

## WP-B · Migration 0013 + store: a close a user owns

**Goal:** `core.month_closes` can hold a per-user, per-currency row, and the
Store can write and read it.

- `0013_user_month_closes.sql`: `ADD COLUMN IF NOT EXISTS user_id` (FK to the
  users table with `ON DELETE CASCADE`, matching the table's existing FK
  precedent) and `ADD COLUMN IF NOT EXISTS currency text`.
- The decision-18 swap: replace `month_close_scope` with _exactly one of_
  `household_id` / `account_id` / `user_id` non-null, guarded `DO $$`,
  idempotent under re-application, same constraint name. Note why the name
  matters: `0004` creates the table `IF NOT EXISTS`, so nothing re-adds the old
  predicate — but a _renamed_ constraint would leave two on the table if the
  swap ever half-runs.
- A user close must name its currency:
  `CHECK (user_id IS NULL OR currency IS NOT NULL)` (new constraint, plain
  guarded add — not part of the exception).
- Uniqueness for the new scope, the same way `0004` did for the old two:
  `CREATE UNIQUE INDEX IF NOT EXISTS month_closes_user_month_currency_unique ON
core.month_closes (user_id, month, currency) WHERE user_id IS NOT NULL`.
- Store: `MonthCloseScope` gains the `{ userId }` variant; `NewMonthClose`
  carries `userId` and `currency`; Memory + Pg + contract test cover create,
  get-by-scope, list, delete, and the duplicate rejection.
- Mirror `0013` byte-identically into `deploy/helm/finance-planner/files/` and
  `cmp` it in the package's gate.

**Acceptance:** the migration applies cleanly **twice in a row** against a
database carrying 0001–0012; a user close rejects a duplicate
`(user, month, currency)`; a user close with no currency is rejected by the
CHECK; both legacy scopes still round-trip through the contract test unchanged.

Owns: `db/migrations/0013_*.sql`, `packages/data/*`,
`deploy/helm/finance-planner/files/` (migration mirror only). Size **M**.
Depends: none.

## WP-C · Ownership in the pass, and the close as a view

**Goal:** the pass knows who owns each account, income follows ownership
(decision 15), and the close's figures are a pure derivation over the pass —
required fields required from birth, no optional-with-deprecation seam.

- `ScopeAccountInput.ownerUserId: string` — **required, not optional.** This
  package owns the construction site too: `apps/api/src/plan.ts`'s scope loader
  supplies it from `Account.ownerUserId` (`NOT NULL` in the schema) in the same
  change, so there is never a caller that can omit it. That is why `plan.ts` is
  in this package and not WP-D's.
- Member income becomes external income summed over accounts they **own**, all
  roles; the `role === "personal"` filter at `scope.ts:486` dies. Decision 11
  (transfer source selection) keeps its personal-role rule, untouched.
- The `elsewhere*` identities on `HouseholdMemberPlan` are re-asserted under
  the new attribution — a shared pot on the roster owned by a member now lands
  in their `householdIncomeMinor`, and every
  `household* + elsewhere* === total` identity must still hold exactly.
- **Pin the `0c35284` netting** on the estate fixture: a shared pot with £50
  external income and £40 of obligations derives £40 less transport in total,
  and no transfer delivers the pot money it already holds.
- `closeForUser(plan, contributions, userId)` (new, pure, exported): returns
  one `{ currency, incomeMinor, plannedMinor, contributedMinor }` per currency
  partition the user appears in — income from `ScopeMemberPlan
.monthlyIncomeMinor`, planned from `.obligationMinor`, contributed from the
  ledger rows carrying that `userId`, bucketed by their account's currency. No
  arithmetic the pass has not already done, plus one sum the ledger already
  supports.

**Acceptance:** on a fixture with **no** shared-account income the whole
`ScopePlan` is byte-identical before and after this package (the decision-15
regression guard — attribution changed, nothing else may); on the estate
fixture the pot owner's income and budget gain the pot's income, the netting
pin holds, and **the close identity holds per currency: Σ over members of
`closeForUser(...).incomeMinor` === the partition's income**; `plan.ts`
compiles with the field required (`pnpm build` in the gate proves the whole
tree does); domain coverage does not drop below 99.87 / 95.84.

Owns: `packages/domain/src/scope.ts`, `household.ts`, `types.ts`, `index.ts`,
their tests, `apps/api/src/plan.ts` + `plan.test.ts`. Size **M–L**. Depends:
WP-A (fixture), WP-B (nothing at compile time, but the identity names its
columns — read it).

## WP-D · API: my closes, and the deletion

**Goal:** closing is a self-scoped action, and the two location-scoped
producers are gone.

- Contracts: `closeMonthBody` stays month-only; `MonthCloseDto` gains
  `userId` and `currency`.
- `POST /api/me/closes` — closes the authenticated user's month: one row per
  currency from `closeForUser` over the user's own scope plan, `409
already_closed` if any row for the month exists (the action is atomic — all
  partitions or none). `GET /api/me/closes` lists the caller's rows and no one
  else's. `DELETE /api/me/closes/:closeId` re-opens, own rows only.
- **Delete** `POST/GET/DELETE /api/accounts/:id/close(s)` (`server.ts:868–921`)
  and `/api/households/:id/close(s)` (`server.ts:1890–1938`), and WP-A's red
  pin file with them — the pin dies with the code it condemned.
- Hunt the deleted surface's shadows: the digest (`notify.ts`), the backup
  (`portability.ts`), the demo seed — anywhere a close is written, read, or
  mentioned. Report anything found that this plan does not name.

**Acceptance:** on the estate fixture, `POST /api/me/closes` writes exactly the
rows `closeForUser` derives, per currency, to the penny; the per-currency
member-sum identity holds through the HTTP surface; a second close of the same
month 409s and writes nothing; a user cannot list or delete another user's
rows; the old routes are 404s and `server.test.ts` no longer references them;
`pnpm build` and `prettier --check .` pass.

Owns: `apps/api/src/server.ts`, `server.test.ts`, `packages/contracts`
(close body/DTO), deletion of `apps/api/src/close.divergence.test.ts`. Size
**M**. Depends: WP-B, WP-C.

## WP-E · Web: one scorecard, where the person is

**Goal:** the scorecard renders once, for the user, and the location pages stop
offering closes.

- `MonthScorecard` gets one producer: the caller's closes from
  `/api/me/closes`, rendered on the Overview — one card per currency, close and
  re-open actions inline.
- `AccountPage` and `HouseholdPlanPage` lose their close UI and fetches
  entirely; check-in stays where it is.
- `lib/api.ts` swaps the two old client call families for the `me/closes`
  three; `lib/types.ts` follows the DTO.
- Tokens only, no new hex; the grep test stands. One agent at a time on
  `styles.css` and `lib/api.ts`, as always.

**Acceptance:** component tests for the per-currency cards, close, re-open, and
the 409 path; account and household pages render no close affordance and issue
no close fetches; a fixture-shaped state (two currencies) shows two cards;
`pnpm build` and `prettier --check .` pass.

Owns: `apps/web/src/components/MonthScorecard.tsx` + test, `pages/OverviewPage
.tsx` + test, `pages/AccountPage.tsx` + test, `pages/HouseholdPlanPage.tsx` +
test, `lib/api.ts`, `lib/types.ts`, `styles.css`. Size **M**. Depends: WP-D.

## WP-F · Closing the books

**Goal:** the repository's documentation stops describing location-scoped
closing, and none of it depends on anyone remembering.

- `README.md`: the feature tour describes closing as a per-user action; any
  mention of closing a household's or account's month goes.
- `BACKLOG.md`: retire whatever entry tracks this work; add nothing new without
  cause.
- Commit `MONTH-CLOSE.md` as the plan of record (untracked until this package),
  noting it continues ONE-ENGINE's decision sequence at 14.

**Acceptance:** no document describes account- or household-scoped closing as
current; `MONTH-CLOSE.md` is tracked; `prettier --check .` passes.

Owns: `README.md`, `BACKLOG.md`, `MONTH-CLOSE.md`. Size **S**. Depends: WP-E.

---

## Waves

| Wave | Packages    | Notes                                                     |
| ---- | ----------- | --------------------------------------------------------- |
| 1    | WP-A + WP-B | disjoint (fixture + pin vs migration + store)             |
| 2    | WP-C        | alone — it owns the pass **and** the loader that feeds it |
| 3    | WP-D        | alone; deletes the old producers and WP-A's pin with them |
| 4    | WP-E        | needs the real DTOs from WP-D to render against           |
| 5    | WP-F        | documentation closes the books; nothing runs beside it    |

Two agents may only run concurrently on disjoint file sets. Never two agents on
`apps/web/src/styles.css` or `apps/web/src/lib/api.ts` at once.

**At every wave boundary,** the orchestrator re-opens each finding any agent
dismissed as "premise false" and re-tests it against the premise as it then
stands — ONE-ENGINE's standing rule, carried forward. A dismissal is dated
evidence about a past tree, never a settled fact about the current one.

## The regression to fear

**Decision 15 is not scorecard-only.** Attributing income by ownership changes
member _budgets_ wherever a shared account carries external income — funding
order, derived transfers, `elsewhere*` identities, and every figure downstream
of a member's budget move with it. The guards are named in WP-C: a fixture with
no shared-account income must plan **byte-identically**, and the estate fixture
must satisfy the netting pin and the close identities. Any figure that shifts
without shared-account income in the fixture is a defect, not a consequence.

And the standing instruction, which has found the live defect in every plan so
far: **hunt for the assumption rather than assuming its absence.** The
assumption this time is _"a scorecard is about a place"_ — every read, write,
or render of a month close that names an account or a household is either
deleted by this work or is a place it is incomplete. If you find one this plan
does not name, report it before coding around it.
