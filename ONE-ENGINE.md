# Implementation plan — one engine, scoped

Agreed 2026-08-04, after the INFLOWS work landed (`bb1ad6f..ed5b44a`). Written to be
picked up cold; read it in full before starting. Conventions and the definition of
done are inherited from [`REDESIGN.md`](./REDESIGN.md) — integer minor units,
explicit `asOfDate`, Store parity (Memory + Pg + contract test) for data changes,
plain CSS through design tokens, no new dependencies, stage only owned paths, never
`git add -A`.

**This supersedes the two-engine architecture, not [`INFLOWS.md`](./INFLOWS.md).**
Everything INFLOWS built stays — the inflow primitive, the ordered pass, cycle
detection, standalone confirmations, the flow page. What changes is that there stop
being two funding engines for one estate. INFLOWS decisions 1–7 remain binding,
with decision 6 narrowed as described below.

---

## The defect that forced this

A household plan cannot see money leaving one of its accounts to an account outside
the household. `HouseholdAccountInput` carries `incomes` and `payments` and nothing
else (`household.ts:38–48`); `buildHouseholdInput` never calls
`listOutboundInflows` (`plan.ts:694–737`). Measured in a browser: the same account
reads **£2,793 left over** on the household page and **£2,093** on the flow diagram
— the difference being exactly one £700/month authored movement the household
engine has never heard of.

The blindness is symmetric. The estate pass funds authored movements without
knowing the household has claimed money out of the same sending account —
`flow.ts:238–243` says so in a comment and floors residuals at zero to cope, which
is a presentation patch over a plan defect (the class decision 2 exists to forbid).

Neither engine has a bug. `computeHouseholdPlan` (member budgets, global priority
order, **derived** transfers) and `computeAccountPlan` + `computeEstatePlan`
(per-account funding, **authored** movements last) are each internally correct.
They share the arithmetic primitives (`requiredMonthlyForPayment`,
`monthlyIncomeMinor`, `splitByShares`) and duplicate everything above them: two
funding loops, two leftover derivations (`engine.ts:358` vs `household.ts:420`),
two "money crossing an account boundary" concepts (`Transfer` vs
`EstateMovement`) that `flow.ts` has to merge and documents as "disjoint by
construction". The defect is the two engines disagreeing, and it recurs for as
long as there are two. This is `HOUSEHOLD-CONTEXT.md`'s opening sentence — _"an
account assigned to a household is planned twice, by two engines that never
speak"_ — one level up.

## The reframing

**One funding pass over a scope; everything else is a view of it.**

A scope is a set of accounts and the members whose money they are. A household is
a scope with sharing rules. A solo user is **a household of one at a 100% share** —
same pass, degenerate attribution. The pass:

1. **Attribution.** Every active payment on every in-scope account becomes
   obligations attributed to members: `splitByShares` for shared scope, the bearer
   (or owning member) for personal, buffers as today (personal buffers reduce the
   member's budget; a shared pot's buffer is an obligation at `RESERVE_PRIORITY`).
2. **Expense funding.** Obligations fund from pooled member budgets in **one
   global priority order** — household-shared and personal intertwined, exactly as
   `computeHouseholdPlan` already does for assigned accounts, now for every
   in-scope account.
3. **Derived transfers.** Funded obligations that cross account boundaries become
   the transfers each member must make, from their source account. This is how an
   expense-bearing account with no income gets fed — household or not, authored by
   nobody.
4. **Savings.** Authored movements fund **last**, per sending account, from what
   the expenses and derived transfers left, in their own priority order, through
   the estate machinery unchanged: dependency-ordered, iterative, cycles detected
   and broken with the edge named (`estate.ts`).
5. **Views.** `AccountPlan`, the household plan (shares, bearers, per-member
   summaries, the committed bucket), the flow, the projection — all read the one
   pass. The account page and the household page show the same numbers because
   they are the same numbers, not because two computations were reconciled.

## Decisions already taken (do not relitigate)

Carried from INFLOWS (1–7 stand; renumbered references below are to that file):

- **6, narrowed.** "Account-sourced inflows always rank after expenses on the
  sending account" survives with its real meaning exposed: authored movements are
  _savings_, and savings rank after _every_ expense — not just the sending
  account's own. The pinned movement-at-priority-1-loses-to-bill-at-99 test keeps
  passing.

New, and equally binding:

8. **Expenses beat savings, always.** Personal and household-shared expenses share
   one priority space and intertwine; a bill on either side can outrank a bill on
   the other; every one of them is funded before any authored movement, whatever
   the movement's priority.
9. **Transport for expenses is derived; authored movements are savings only.** An
   in-scope account with obligations and no income gets its feed derived by the
   pass — the user never authors "£300 to the bills pot"; the plan says £303.20.
   The authoring primitive (WP-F/WP-K) stays, its job narrowed to savings.
10. **Planning is per currency.** Derived transfers never cross a currency;
    obligations with no same-currency source anywhere in scope report an honest
    shortfall. (Authored cross-currency movements are already refused with a 422.)
11. **A member's transfers originate from their highest-external-income personal
    account, per currency** — today's `memberSource` rule (`household.ts:224`),
    promoted from accident to decision. A member with several personal accounts
    has all derived claims land on that one.
12. **No netting between a derived feed and an authored movement into the same
    account.** The movement arrives as savings on top; the UI flags the
    duplication and prompts deletion. Users who authored bill-covering movements
    before this lands will see both until they act — accepted (Ben, 2026-08-04).
    Netting inside the engine would put savings money inside expense arithmetic
    and was rejected.
13. **`leftoverMinor` keeps its meaning everywhere; `committedMinor` is added
    alongside** (the decision-4 pattern): per member and per account, the funded
    savings movements out. Headline figures show free-after-committed; no existing
    field changes meaning.

**Sanctioned exception (Ben, 2026-08-04):** migration `0010_` may replace the
`transfer_confirmation_scope` CHECK constraint via a guarded `DO $$` block —
technically a `DROP CONSTRAINT`, normally forbidden. It touches no data, must be
idempotent under re-application on every sync, and is the only DROP of any kind in
this work. Nothing else is exempted.

Nothing here touches the auth service. It keeps refresh-token rotation state
in-process and stays pinned to `replicas: 1`.

## Migration constraints — read before writing any SQL

Unchanged from INFLOWS: the cluster re-applies **every** `.sql` file in lexical
order on every sync under `psql -v ON_ERROR_STOP=1`. Every statement idempotent;
additive only (bar the sanctioned exception above); no `DELETE`/`TRUNCATE`;
mirrored **byte-identically** into `deploy/helm/finance-planner/files/`;
self-contained and readable. The new migration is `0010_`.

---

## WP-O · The specification test, written first and seen red

**Goal:** the test that would have caught this defect exists **before** the engine
rewrite it specifies, and the whole plan has one objective completion signal.

One fixture: an account inside a household with an authored savings movement.
Three figures asserted equal to the penny: the household plan's figure for the
account, the flow residual, and the account plan. Written against the current
tree, it **must be observed to FAIL at `d25680e`** — the production instance of
this failure read £2,793 on the household page against £2,093 on the flow diagram,
one £700/month movement apart. Record the fixture's own failing numbers in the
test's comment.

Landed as `it.fails` (vitest: passes while the assertion fails, fails the moment
it passes), so CI stays green across waves 1–2 while the defect stands and the
tree itself documents that the disagreement is known. WP-P, WP-Q and WP-S turn
the underlying assertion green; WP-S flips it to a plain `it` as part of its
acceptance. Written after the fix it would be a regression test; written first
and seen red, it is the specification.

**Acceptance:** the assertion demonstrably fails at `d25680e` with the failing
figures recorded; the file passes CI as landed; no production code is touched.

Owns: `packages/domain/src/parity.test.ts` (new file — nothing else). Size **S**.
Depends: none — wave 1, disjoint from WP-P's and WP-R's files.

## WP-P · The scope pass

**Goal:** one funding pass, as described in the reframing. `computeHouseholdPlan`'s
structure — obligations, member budgets, global priority order, derived transfers —
generalised into it; `computeEstatePlan`'s machinery — dependency order, cycle
detection and naming, movement statuses, confirmed-arrival clamps — becomes its
final phase, feeding savings from post-expense residuals.

- The scope input carries members (defaulting to the owner at 100% when no
  household applies), accounts with roles and currencies, payments with
  scope/bearer, external inflows, authored movements, and confirmations.
- Partition by currency first (decision 10); run the pass per partition.
- Derived transfers cannot cycle (they radiate from `memberSource`); authored
  movement edges can, and keep the existing DFS, determinism, and
  `broken_cycle`/`unknown_source` reporting.
- The per-member and per-account summaries gain `committedMinor` (decision 13).

**Acceptance:** a household bill at priority 5 beats a personal bill at priority
10 and vice versa, from one member budget (intertwining, both directions); a
standalone expense pot with no income gets a derived transfer equal to its
obligations, without any authored row; a savings movement at priority 1 loses to
any expense at priority 99 — the existing pinned test, kept verbatim; a solo user
with one account and no movements plans **byte-identically** to today (pin it);
the externally-funded byte-identical pin in `inflows.invariant.test.ts` keeps
passing; the estate-wide money-in invariant (external only) holds with derived
transfers present; a two-currency scope derives transfers only within each
currency and reports the stranded obligation as shortfall; a movement loop is
still detected, named, and broken deterministically.

Owns: `packages/domain/src/household.ts`, `estate.ts`, `types.ts`, `index.ts`,
their tests, `inflows.invariant.test.ts`. Size **XL** — runs alone. **Coverage
gate applies** (≥95% lines / ≥80% branches; currently 100 / 93.23 — do not ratchet
down).

## WP-R · Migration 0010 + store: confirming a derived solo transfer

**Goal:** "I moved the money" works for a transfer the pass derived for a user with
no household — the one confirmation case 0009 could not reach, because a derived
solo transfer has neither a `household_id` nor an `inflow_id` and the
`transfer_confirmation_scope` CHECK requires one of them.

- `0010_derived_confirmations.sql`: replace `transfer_confirmation_scope` under
  the sanctioned exception — guarded `DO $$` block, idempotent on every re-run —
  with a comment explaining why the "scoped to nothing" concept dissolved: a
  derived confirmation is scoped by `(from_account_id, to_account_id, month,
member_user_id)`, columns every row already carries NOT NULL.
- Close the uniqueness hole the same way 0009 did for its case: a partial unique
  index over `(from_account_id, to_account_id, month, member_user_id)` `WHERE
household_id IS NULL AND inflow_id IS NULL`.
- Store: read and write paths for derived-solo confirmations (Memory + Pg +
  contract test). Existing household and inflow-scoped paths untouched.
- Mirror the migration byte-identically into
  `deploy/helm/finance-planner/files/`.

**Acceptance:** the migration applies cleanly **twice in a row** against a
database that has 0001–0009 applied; a derived solo transfer can be confirmed and
un-confirmed with contribution rows following as they do today; a duplicate
derived confirmation for the same month is rejected; every existing confirmation
shape still round-trips through the contract test.

Owns: `db/migrations/0010_*.sql`, `packages/data/*`,
`deploy/helm/finance-planner/files/` (migration mirror only). Size **M**.
Depends: none — runs in wave 1 alongside WP-P, disjoint files.

## WP-Q · The views

**Goal:** every derived surface reads the one pass.

- `computeAccountPlan` is demoted to a view: same `AccountPlan` shape on the wire,
  produced from the pass's funding decisions — per-line funded amounts, the
  own/inflow split, `funded | awaiting_transfer | at_risk` statuses from the
  confirmation overlay. The account-local funding loop goes away.
- `flow.ts` reads one derivation. The `allocations` merge parameter and
  `householdAllocations`' reason to exist go away; derived transfers and savings
  movements are edges of the same pass, ribbons meet exactly, and the residual
  floor at `flow.ts:243` becomes defensive rather than load-bearing (keep it,
  assert it never fires in the fixtures).
- `projection.ts` re-based: months walk the pass, so a sending account's
  projection can never diverge from its plan; derived feeds recur the way
  household allocations do today.

**Acceptance:** a solo single account's `AccountPlan` is byte-identical to WP-P's
pin through the view too; the flow for a household preset carries the same nodes
and totals as today's _plus_ the committed movements (this deliberately re-pins
the verbatim Sankey capture — see below); an account's projection month 1 equals
its plan for the same date, asserted directly; a pooled account projects a stable
reserve; no view recomputes funding — grep-level assertion that `flow.ts` and
`projection.ts` contain no funding loop of their own.

Owns: `packages/domain/src/engine.ts`, `flow.ts`, `projection.ts`, their tests;
may extend `types.ts` (sequential hand-off from WP-P — never concurrent). Size
**L**. Depends: WP-P. **Coverage gate applies.**

## WP-S · API: one loader, one pass

**Goal:** the API builds one scope and reads views of it; the parallel loaders die.

- One scope loader replaces the `buildHouseholdInput` / `loadAccountInput` pair:
  seeds → closure over funding edges _and_ household assignment (planning one
  account may mean planning its household and its senders — both already true
  today, via two different code paths). `PlanContext` survives, re-keyed by scope.
- `resolveAccountInflow` and `householdAllocations` collapse into pass outputs.
- Every endpoint reads views: account plan, overview, upcoming, projection, flow,
  household plan (+ payday schedule — `splitTransfersByPayday` now serves solo
  users' derived feeds too, for free), the digest (`notify.ts`), the what-if
  preview.
- Confirmation endpoints gain the derived-solo case on WP-R's store paths.
- Access rules preserved exactly: member names gated on household membership,
  amounts never gated — the rule `plan.ts` applies today, asserted again.

**Acceptance:** **WP-O's specification test goes green here** — flip it from
`it.fails` to a plain `it`, and assert the same three-way parity once more at the
endpoint level (household plan response, flow response, account plan response,
one fixture, to the penny); API tests for a standalone pot gaining a derived feed (no authored row, transfer
prompt present, lines `awaiting_transfer` not `at_risk`); the access-control case
(viewer sees account, not household); the digest renders committed movements; the
overview's income sum is unchanged by any number of derived transfers
(double-count guard, re-asserted).

Owns: `apps/api/src/plan.ts`, `server.ts`, `server.test.ts`, `plan.test.ts`,
`notify.ts`, `notify.test.ts`, and the flip of WP-O's
`packages/domain/src/parity.test.ts` (sequential hand-off — WP-O's agent is done
by then). Size **L**. Depends: WP-O, WP-P, WP-Q, WP-R.

## WP-T · Web: the same numbers, everywhere you look

**Goal:** the views the user sees match the model Ben stated: an account shows
every movement touching it, in and out, household or personal; a household shows
its accounts' movements as a single **committed** bucket, not itemised.

- Household plan page: the committed bucket (decision 13), headline leftover as
  free-after-committed, existing fields' meanings untouched.
- Account page: complete in/out movement picture regardless of which plan derives
  each movement.
- `needsYou`: a derived-transfer row for a solo pot (one row, no shortfall row —
  the WP-E property re-asserted for the new producer); the decision-12 duplication
  flag ("this movement duplicates the derived feed — delete it?"); the `record`
  ordering rule re-checked for derived feeds.
- Flow page / `HouseholdSankey`: re-pin the verbatim household capture
  deliberately — the picture gains committed movements, which is the point. Note
  the re-pin in the test with a comment naming this plan.
- Tokens only, no new hex; the grep test stands. One agent at a time on
  `styles.css` and `lib/api.ts`, as always.

**Acceptance:** component tests for the committed bucket and the duplication flag;
the solo-pot fixture yields exactly one `needsYou` row; the household preset flow
snapshot re-pinned with the movement edges present and every node's ribbons
meeting; no red anywhere for an account whose feed is derived and merely
unconfirmed.

Owns: `apps/web/src/pages/*`, `components/*`, `lib/*` (including `types.ts`,
`needsYou.ts`, `flow.ts`), `styles.css`, their tests. Size **M–L**. Depends: WP-S.

## WP-U · Closing the books

**Goal:** the repository's own documentation stops describing the architecture
this work deletes, and none of it depends on anyone remembering.

- `BACKLOG.md`: retire the entry that carries this defect first in Product,
  marked `SHIP-BLOCKING` ("a new plan is being written for it" — this was that
  plan, and by this wave it has been executed).
- `README.md`: the architecture section describes the two-engine split as the
  design, and the feature tour describes authored movements as how you feed a
  pot — decision 9 changed that. Bring both in line with the scope pass.
- Commit `ONE-ENGINE.md` itself as the plan of record (it is deliberately left
  untracked until this package), noting that it supersedes the engine split the
  way `INFLOWS.md` superseded `HOUSEHOLD-CONTEXT.md`.

**Acceptance:** no document in the repo describes two funding engines as the
current design; the backlog entry is retired with a pointer here; `ONE-ENGINE.md`
is tracked.

Owns: `README.md`, `BACKLOG.md`, `ONE-ENGINE.md`. Size **S**. Depends: WP-T.

---

## Waves

| Wave | Packages           | Notes                                                       |
| ---- | ------------------ | ----------------------------------------------------------- |
| 1    | WP-O + WP-P + WP-R | disjoint (spec test vs domain pass vs migration + store)    |
| 2    | WP-Q               | alone; takes the types hand-off from WP-P                   |
| 3    | WP-S               | alone; it owns the API choke point; flips WP-O's test green |
| 4    | WP-T               | needs the real DTOs from WP-S to render against             |
| 5    | WP-U               | documentation closes the books; nothing runs beside it      |

Two agents may only run concurrently on disjoint file sets. Never two agents on
`apps/web/src/styles.css` or `apps/web/src/lib/api.ts` at once.

## At every wave boundary: re-open the dismissed findings

This defect exists because a correct dismissal outlived its premise. In wave 2 of
the INFLOWS work, WP-B raised `household.ts:420`'s second `leftoverMinor`; WP-G
answered "premise false, nothing to reconcile" — **correct for the code as it
then stood** — and nothing re-opened the finding once WP-F/WP-G/WP-K made
movements authorable and the premise changed.

So, at the end of every wave, the orchestrator re-opens **each finding any agent
dismissed as "premise false"** and re-tests it against the premise as it stands
after that wave. A dismissal is dated evidence about a past tree, never a
settled fact about the current one. In a plan whose entire purpose is changing
premises underneath previously-correct code, this is load-bearing, not
bureaucracy.

## Superseded code is deleted, not left lying around

This plan replaces one engine with another. Every package that supersedes something
**deletes it in the same commit that replaces it** — the account-local funding loop,
`computeHouseholdPlan` and its private helpers, `householdAllocations`,
`resolveAccountInflow`, `buildHouseholdInput`, the `allocations` merge parameter,
whichever of the two `leftoverMinor` derivations loses. A superseded function left
in the tree is not harmless: it compiles, it keeps its tests passing, it reads as
a live alternative to the next person, and it is how the two-engine split survived
long enough to cause this work.

Preferring deletion also makes the compiler do the finding. Removing
`computeHouseholdPlan` turns every stale caller into a build error, which is a
better inventory of the switchover than any grep — **a red build from a deletion is
a result, not a problem.** Land the deletion and fix the callers in the same
commit.

Each package reports, per symbol it superseded: deleted, or kept with the reason
and the name of whoever still calls it. "Nothing calls it any more, so I left it"
is not an acceptable answer.

## Pinned tests: kept, added, deliberately re-pinned

- **Kept verbatim:** externally-funded account byte-identical
  (`inflows.invariant.test.ts:188`); savings movement at priority 1 loses to a
  bill at priority 99; cycle detection determinism.
- **Added:** solo single account byte-identical through pass _and_ view; the
  three-way parity fixture (household figure === flow residual === account plan —
  WP-O's specification test, red first, green by WP-S); and the direction the
  existing pin does not cover, which is the bug decision 9 exists to fix: **a
  standalone expense pot's priority-1 rent must not lose to the sending account's
  priority-99 gym membership**. The kept pin guards savings losing to expenses;
  this one guards expense transport _not_ losing to them. Both directions need a
  pin or the next refactor silently re-breaks one.
- **Deliberately re-pinned, once, in WP-Q/WP-T:** the household Sankey verbatim
  capture — the picture gains committed movements. Any _other_ pinned test that
  fails is a defect in the work, not a candidate for re-pinning.

## The regression to fear

**Tight-month reordering.** Accounts that used to fund from local income in local
priority order now fund through the member's global order. On a constrained
fixture a _different bill_ can go short than before — that is the feature, and it
is also a change to every figure downstream of `fundedMonthlyMinor`: chain
arrivals, confirmed-arrival clamps, the digest, `needsYou`, the overview netting.
The solo-single-account case must provably not move at all; everything else must
move only for the reasons decisions 8–13 name.

And the standing instruction, which found this defect and every one before it:
**hunt for the assumption rather than assuming its absence.** The assumption this
time is _"there are two engines."_ Every place that merges, reconciles, clamps,
or floors between two derivations of the same money — `flow.ts`'s merge and
floor, `householdAllocations`, the two leftover fields, the overview's netting —
is either deleted by this work or is a place it is incomplete. If you find one
this plan does not name, report it before coding around it.
