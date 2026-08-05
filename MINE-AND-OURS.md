# Implementation plan — mine, and ours

Agreed 2026-08-05, on `main` at `1409e5f`; amended after review with `main` at
`22c1ce6`, where every measured figure below was re-verified to the penny —
including through the fixture correction `22c1ce6` itself made. `MONTH-CLOSE.md`'s
WP-E was in flight as this was first written and has since landed (`4ef73ad`),
so the files it held — `apps/web/src/pages/OverviewPage.tsx`, `AccountPage.tsx`,
`HouseholdPlanPage.tsx`, `components/MonthScorecard.tsx`, `lib/api.ts`,
`lib/types.ts`, `styles.css` — are free, and wave 4's blocker is already
satisfied. Written to be picked up cold; read it in full before starting.
Conventions and the definition of done are inherited from [`REDESIGN.md`](./REDESIGN.md),
[`ONE-ENGINE.md`](./ONE-ENGINE.md) and [`MONTH-CLOSE.md`](./MONTH-CLOSE.md) —
integer minor units, explicit `asOfDate`, Store parity (Memory + Pg + contract
test) for data changes, plain CSS through design tokens, no new dependencies,
stage only owned paths, never `git add -A`.

ONE-ENGINE decisions 1–13 and MONTH-CLOSE decisions 14–18 stand, **except the one
clause decision 19 below supersedes.** This plan adds 19–25 (24 was taken at the
wave 1 boundary, on a seam WP-AB's hunt found; 25 at the wave 4 boundary, on
browser evidence).

**The local gate for every package includes `pnpm build` and
`pnpm exec prettier --check .`** — both are fatal CI jobs. The domain coverage
gate is **99.87% statements / 95.84% branches — do not ratchet down.** Nothing
here may touch the auth service (in-process refresh-token rotation state, pinned
to `replicas: 1`).

Packages are lettered **WP-AB … WP-AI** to avoid colliding with MONTH-CLOSE's
WP-A…WP-F, plus **WP-AJ, WP-AK, WP-AL and WP-AM**, added at the wave 4, wave 5
and wave 6 boundaries from findings the plan did not anticipate — each one
surfaced by the previous package's hunt.

---

## The problem

Three screens print a figure labelled **left over**. Two of them are wrong, and
they are wrong in two different ways.

Measured against `packages/domain/src/estate.fixture.ts`, one account
(`acc-alice-current`), one month:

| surface                                                      | field it prints                           | figure    |
| ------------------------------------------------------------ | ----------------------------------------- | --------- |
| `/accounts` index (`AccountsPage.tsx:327`)                   | `leftoverMinor`                           | £2,501.00 |
| dashboard account table (`OverviewPage.tsx:449`)             | `leftoverMinor`                           | £2,501.00 |
| account page KPI (`PlanTable.tsx:383`)                       | `residualMinor`                           | £2,051.00 |
| account page projection strip (`ProjectionView.tsx:195–217`) | `MonthProjection.leftoverMinor`           | £2,501.00 |
| household page (`HouseholdPlanView.tsx:65`)                  | `householdLeftoverMinor − committedMinor` | £3,575.00 |

The £450 is `committedMinor` — three authored savings movements. A savings pot
makes it starker: **£0.00 on the dashboard, £200.00 on its own page.**

Three things are going on, and only the first is the one that was reported.

**1. `leftoverMinor` is a rollup field printed under a per-account label.** It
means _own income after own bills and after derived transfers out_ — deliberately
before savings movements leave, and deliberately excluding money that arrived. It
is the right answer for a sum over an estate and the wrong one for a person
looking at one account, which is exactly what `PlanTable.leftOverMinor`'s comment
already says. Two lists never got the memo, and there is no residual on the
overview wire for them to read even if they had: `overviewFromPlans`
(`engine.ts:475–480`) builds `AccountSummary` with `leftoverMinor` alone.

**2. The account page disagrees with itself.** The projection strip's footer row
is labelled `left over` and prints `MonthProjection.leftoverMinor`, which is
`plan.leftoverMinor` verbatim (`projection.ts:368`) — £2,501 a few hundred pixels
under a KPI reading £2,051. ONE-ENGINE WP-Q's acceptance reads _"an account's
projection month 1 equals its plan for the same date, asserted directly"_, and it
does — against the field the projection reads. Fifth instance in this repo of a
test asserting the field its component reads.

**3. The dashboard's headline is not the caller's money.** `deriveHeadline`
(`needsYou.ts:849–855`) sums `householdLeftoverMinor` for households and
`leftoverMinor` for standalone accounts. On a household of two that is £3,575, of
which £1,524 is the co-member's. Net worth (`OverviewPage.tsx:504–518`) has the
same shape: it sums over `bucket.accounts`, which is every account the caller can
**see**, including a co-member's shared into the household.

The common cause is not arithmetic. It is that **the app has one boundary — what
is mine and what is ours — and it is drawn in four places by four different
rules**: by household roster, by access, by ownership, and by whichever field a
component happened to reach for.

## The reframing

**One derivation, read at three altitudes, and the boundary is ownership.**

- **An account's** left over is `residualMinor`: `income + arriving − spending − leaving`.
  What is actually in the account when the month has happened.
- **A person's** left over is that, summed over the accounts they **own**.
- **A household's** left over is its members' left overs, added up. That is all it is.

Every figure labelled "left over" anywhere in the product is one of those three,
and each is a plain sum of the one below it, so the rows on a screen add up to the
total above them. Nothing is netted, nothing is reconstructed by algebra, and no
surface derives a fourth.

## Decisions (19–25 — do not relitigate)

19. **Left over is one derivation at three altitudes, and it is not
    free-after-committed.** `residualMinor` per account; a person's is the sum over
    accounts they own; a household's is the sum over its members'. **This
    supersedes ONE-ENGINE decision 13's clause "headline figures show
    free-after-committed"** — correct for one account or one member's budget, and
    wrong at roll-up scale. Two facts, precisely (verified at `22c1ce6`): today's
    `householdLeftoverMinor − committedMinor` is algebraically a residual sum
    already — `household.ts:340` adds each account's committed back and the page
    subtracts the same total, so the two cancel and what prints is Σ residuals
    **over the roster**. The figure is internally consistent and summed over the
    wrong set: the £450 sits in member-owned pots the roster does not hold. And
    for the model this plan builds, the free-after-committed clause stays wrong
    for a second reason: a residual has already netted a movement at both ends —
    sender down by it, receiver up by it — so subtracting `committedMinor` from a
    residual roll-up loses the money entirely. Ownership is the fix for the
    first; never subtracting committed at altitude is the fix for the second. On
    the estate fixture, together, that is the difference between the household's
    £3,575 today and the £4,025 it becomes. The **rest** of decision 13 stands
    untouched: `leftoverMinor` and `committedMinor` keep their meanings on the
    wire to the penny, no field is redefined, and anything new is added alongside
    (the decision-4/13 pattern).
20. **A personal figure counts accounts you own, never accounts you can see.**
    `ownerUserId`, not access. An account a co-member shared into the household is
    theirs and appears in their figure; a shared pot you own is yours, which is
    decision 15 restated one altitude up. The overview's per-currency roll-up
    currently sums every accessible account, and that is the bug, not the label.
21. **Net worth is deleted, not fixed** (Ben, 2026-08-05). The section, the chart,
    the series builder, the history fetch and their tests all go.
    `reservedMinor` **stays** on the wire — `RealityStrip.tsx:27` reads it on the
    account page and it is a legitimate per-account figure. `GET /api/accounts/:id/balances`
    stays and check-ins stay: a balance is a fact about a place, and only the
    roll-up over it was ever the problem.
22. **A project is personal or shared, and shared means into your household.** One
    column on `core.projects`, no `project_shares` table, no permission enum. A
    user belongs to exactly one household (`0011`), so "shared" has exactly one
    possible target and never needs a picker. A user with no household cannot
    create a shared project — 422, named.
23. **The sharing constraint is asymmetric, and only the shared side has one.** A
    **shared** project may hold payments only on accounts shared into the household
    via `auth.account_shares` — access, never
    `household_account_assignments.role` — and that constraint is what makes
    showing every payment with its account name leak nothing, because every viewer
    already has access. A **personal** project may hold any payment on any account
    you own; there is no leak to prevent, and the symmetric rule would have barred
    your own current account from your own private project the moment you shared it.
    Removing an account's share removes that account's payments from shared
    projects (Ben, 2026-08-05). And the direction that rule alone does not reach
    (Ben, 2026-08-05, at review): **a member who leaves keeps their projects,
    never the household's contents.** On leaving — or on the household's deletion
    — every shared project the leaver owns drops its payments on accounts they do
    not own and flips to `personal`. Without this the ex-member keeps a live
    window, payment names and amounts, into the household they left ("you don't
    get to keep any of the household's benefits if you leave" — the
    `removeMember` rule, applied to projects), and a household they later join
    would inherit a still-"shared" project full of stale links, because "shared"
    resolves through the owner's membership on the day it is read. Flipped
    personal, a re-share must pass the personal→shared gate like any other.
24. **Shortfall and the payment count follow left over onto the ownership basis**
    (Ben, 2026-08-05, at the wave 1 boundary). The dashboard headline's shortfall
    figure and its payment count are a person's, counted over the accounts they
    own, exactly as decision 19 does for left over. The headline sentence
    therefore stops naming a co-member who is short; `householdShortfalls` still
    lists that as a checklist row directly beneath it, so the fact moves rather
    than being lost. The alternative — a left over that is yours beside a
    shortfall that is the household's — puts two bases in one sentence, which is
    the disease this plan exists to cure. Found by WP-AB's hunt, and the plan was
    thin in two places it names precisely. First: `shortfallMinor`
    (`needsYou.ts:817–819`) and `paymentCount` (`:856–858`) are both computed by
    the household-vs-standalone partition WP-AG is told to delete, and neither
    appeared in WP-AF's field list, so deleting the partition as planned would
    have stranded both with nothing to recompute them from. Second, one level
    below the bucket decision 20 names: `standaloneAccounts` (`:723–726`) filters
    on household membership alone, never ownership, so a co-member's account
    shared to you and sitting in no household counts as yours. That is fixed
    **for the headline figures only** — `standaloneAccounts` also feeds the
    checklist (`:753`), where an account shared to you is a legitimate row, a
    thing you can act on, and must keep appearing.

25. **A figure that contains somebody else's money says so** (Ben, 2026-08-05, at
    the wave 4 boundary, decided on browser evidence rather than in the
    abstract). WP-AG's browser pass showed Alice's household member row reading
    `INCOME £2,000.00 · THEIR COSTS £300.00 · COMMITTED £100.00 · LEFT OVER
£2,100.00` — a reader doing that row's own arithmetic gets £1,600, and the
    £500 gap is Bob's £400 in a pot Alice owns plus £100 that only moved between
    two of her own accounts. **Every neighbouring cell on that table already
    carries an "incl. £X elsewhere" note for exactly this class of gap** — THEIR
    COSTS, INCOME and COMMITTED all have one — leaving LEFT OVER as the only cell
    without. So the annotation is the table's existing idiom, not a new
    invention, and `inflowArrivals` already itemises the money. Both sites get
    it: the member row's LEFT OVER, and the per-account column footer, which
    reads £2,800 under a KPI of £2,900 because Alice's ISA is an account she owns
    that the household does not hold. Decision 19 made that difference real; this
    makes it legible. **The arithmetic does not change** — this is a labelling
    decision, and WP-AE's reasoning that a residual is a fact about a place
    stands untouched.

## Migration constraints — read before writing any SQL

Unchanged: the cluster re-applies **every** `.sql` file in lexical order on every
sync under `psql -v ON_ERROR_STOP=1`. Every statement idempotent; additive only —
**this plan drops nothing and claims no sanctioned exception**; no
`DELETE`/`TRUNCATE`; mirrored **byte-identically** into
`deploy/helm/finance-planner/files/` (verify with `cmp`); self-contained and
readable. All thirteen existing pairs are identical today; the new migration is
`0014_`.

---

## WP-AB · The red pin: three altitudes, one figure

**Goal:** the identity this plan exists to establish is written down and observed
failing **before** anything implements it, so the work has one objective
completion signal.

On `estate.fixture.ts`, in a new domain test file, assert with no new production
code:

- for each member, their left over is `Σ ScopeAccountPlan.leftoverMinor` over the
  accounts whose `ownerUserId` is theirs — Alice £2,501.00, Bob £1,524.00 (GBP);
- the household's figure equals their sum, £4,025.00;
- `householdFreeMinor`'s current derivation
  (`householdLeftoverMinor − committedMinor`) returns **£3,575.00**, and the
  assertion that it equals £4,025.00 **fails**.

Landed as `it.fails` (vitest: passes while the assertion fails, fails the moment
it passes), so CI stays green while the divergence stands and the tree documents
that it is known. This divergence assertion can never come true on its own —
decision 19 changes no existing field's meaning, so
`householdLeftoverMinor − committedMinor` reads £3,575.00 forever. Its job is to
make the divergence undeniable and dated, not to turn green (MONTH-CLOSE WP-A's
pattern, not ONE-ENGINE WP-O's), and **WP-AE replaces it**: the same three
figures, asserted against the fields WP-AE publishes, as a plain `it`, as part
of WP-AE's acceptance. Record the two diverging figures and the commit they were
measured at in the test's comment.

**Acceptance:** the assertion demonstrably fails at `22c1ce6` (first measured at
`1409e5f`; re-verified identical through the fixture correction) with both
figures recorded; the file passes CI as landed; no production code is touched;
`pnpm build` and `prettier --check .` pass.

Owns: `packages/domain/src/mine.test.ts` (new file — nothing else). Size **S**.
Depends: none — wave 1.

## WP-AC · The project leak, closed

**Goal:** the two cross-user holes in the projects surface are shut, independently
of whether the sharing feature is ever built.

Neither is hypothetical, and together they compose:

- `POST /api/accounts/:id/payments` (`server.ts:1245`) and
  `PATCH /api/payments/:paymentId` (`:1264`) pass `body.projectId` straight
  through. Nothing checks the project belongs to the caller; `createPaymentBody`
  validates shape only and the DB FK checks existence only. **Anyone can attach a
  payment on their own account to anyone else's project.**
- `GET /api/projects/:id` (`server.ts:2007–2011`) gathers
  `listPaymentsForProject` — which has no access filter at all
  (`pg-store.ts:1292–1295`) — and hydrates each payment's account with a bare
  `store.getAccount(aid)`, not `requireAccess`. So the victim's project page then
  prints the attacker's account name, currency and figures.

Fix both: a payment's `projectId` must name a project the caller owns (422 with
the project named otherwise), on create and on patch; and the detail route names
an account only when the caller has `view` on it, falling back to an absence
rendered as an absence — the gate `planInflowSources` already applies, applied
here. Amounts are never gated; names are. Add the `Project` subject to
`packages/policies` rather than a fourth hand-rolled
`project.ownerUserId !== userId`, which `server.ts:1977` has been asking for.

**Acceptance:** a payment created or patched with another user's `projectId` is
refused 422; a project detail response names only accounts the caller may see and
still reports every payment's amount; the three existing ownership 404s still
hold; `pnpm build` and `prettier --check .` pass.

Owns: `apps/api/src/server.ts`, `server.test.ts`, `packages/policies/*`,
`packages/contracts` (payment body only). Size **M**. Depends: none — wave 1,
disjoint from WP-AB and WP-AD.

## WP-AD · Migration 0014 + store: a project that is personal or shared

**Goal:** `core.projects` can say which it is, and the Store can read and write it
and clean up after a share that goes away.

- `0014_shared_projects.sql`: `ADD COLUMN IF NOT EXISTS visibility text NOT NULL
DEFAULT 'personal'`, plus a guarded `ADD CONSTRAINT` limiting it to
  `('personal','shared')`. Additive, idempotent under re-application, drops
  nothing. Note in the file why there is no `household_id` column: a user belongs
  to exactly one household (`0011`), so "shared" resolves through the owner's
  membership at read time and a stored household id would be a second copy of a
  fact that can change underneath it.
- Store: `Project.visibility`; `NewProject` carries it; a new
  `listProjectsForUser(userId)` — owned projects plus shared projects owned by a
  co-member of the caller's household. `listProjectsForOwner` is **not deleted
  here, and is not superseded**: it answers a different question ("what do I
  own"), and its two callers — `server.ts:1982`, held by WP-AC in this very
  wave, and `portability.ts:211`, which must stay owner-scoped because a backup
  must not carry a co-member's shared project — are files this package does not
  own. Deleting it here fails this package's own `pnpm build` gate in files it
  cannot touch; a red build from a deletion is a result only when the deleter
  owns the callers. WP-AH swaps the one caller that changes and settles the
  method's fate. A new `clearProjectLinksForAccount(accountId)` nulls
  `payments.project_id` for payments on that account that sit in a **shared**
  project.
- Call it from the three places that already enumerate what dissolves:
  `deleteAccountShare`, `removeMember` (`store.ts:277–304`) and `deleteHousehold`
  (`store.ts:246–251`). All three currently say nothing about projects, correctly,
  because nothing linked them — decision 23 links them.
- And decision 23's leaving rule, which those three do not cover because it runs
  the other way: on `removeMember` — and per member on `deleteHousehold` — every
  **shared** project the leaver owns drops its payments on accounts the leaver
  does not own, and flips to `personal`. The three sites above dissolve what the
  household held of the leaver; this dissolves what the leaver held of the
  household.
- Memory + Pg + contract test for every path above.
- Mirror `0014` byte-identically into `deploy/helm/finance-planner/files/` and
  `cmp` it in the package's gate.

**Acceptance:** the migration applies cleanly **twice in a row** against a
database carrying 0001–0013; existing rows read back as `personal`; a shared
project is visible to a co-member and invisible to a stranger; deleting a share,
removing a member and deleting a household each clear that account's links in
shared projects and leave personal ones alone; a leaver's own shared project
drops its payments on accounts they do not own and reads back `personal`, and
their payments on their own accounts survive in it; `listProjectsForOwner` still
exists and `pnpm build` passes against unmodified callers; `pnpm build` and
`prettier --check .` pass.

Owns: `db/migrations/0014_*.sql`, `packages/data/*`,
`deploy/helm/finance-planner/files/` (migration mirror only). Size **M**.
Depends: none — wave 1, disjoint files.

## WP-AE · The pass publishes a person's left over

**Goal:** the domain answers "what is left over for this person" once, and every
altitude is a sum of the one below it.

- `AccountSummary` (`engine.ts:377–382`) gains `residualMinor` and `ownerUserId`,
  passed through from the plan. `CurrencyOverview.leftoverMinor` keeps its
  meaning; report at the end whether anything still reads it, and delete it if
  nothing does. WP-AB's hunt found its **five siblings** in the same boat:
  `overviewFromPlans` (`engine.ts:475–480`) sums `monthlyIncomeMinor`,
  `bufferMinor`, `totalRequiredMinor`, `totalFundedMinor` and `shortfallMinor`
  over `accessibleAccounts` (`server.ts:1366, 1428`) by the identical access
  basis, and the web reads `bucket.currency` and `bucket.accounts` and none of the
  six. **Report the evidence for all six; delete only `leftoverMinor`, which is
  the one this plan sanctions.** Taking five more fields off the wire is a
  data-format change and is Ben's to approve, not a package's to take by
  extension — but leaving five access-summed figures on the wire once the sixth
  goes is worse than either, so it gets settled with evidence in hand.
- `leftoverForUser(plan, userId)` — new, pure, exported, deliberately shaped like
  `closeForUser` (`scope.ts:1094`): one
  `{ currency, leftoverMinor, shortfallMinor, paymentCount }` per currency
  partition the user appears in, each summed over the accounts they own —
  `Σ ScopeAccountPlan.leftoverMinor`, `Σ ScopeAccountPlan.shortfallMinor`, and the
  count of plan lines. No arithmetic the pass has not already done. It keeps the
  name the plan fixed for it even though it now carries three figures; the other
  two are **decision 24**, and they are added here rather than in a later wave
  because reopening the domain files costs a whole wave in a plan this serialised.
- `HouseholdMemberPlan` gains `personalLeftoverMinor` — that member's figure — and
  `HouseholdPlan` gains `membersLeftoverMinor`, their sum. `leftoverMinor`,
  `householdLeftoverMinor` and `committedMinor` all keep their present meanings on
  the wire; these are added alongside (decision 13's surviving half).
- `MonthProjection` gains `residualMinor` — the month's
  `ScopeAccountPlan.leftoverMinor`, passed through — so WP-AG's projection strip
  can print the month's residual rather than reconstructing it by algebra, which
  the reframing forbids. `projection.ts` is owned here for exactly this; a
  package that ships without touching it has not finished.
- **WP-AB's pin is replaced here** — the same three figures asserted against the
  new fields, as a plain `it`. The `it.fails` divergence assertion is deleted
  with the replacement; it could never come true (WP-AB says why) and its date
  is in the comment.

**Acceptance:** on the estate fixture Alice reads £2,501.00, Bob £1,524.00 and the
household £4,025.00, to the penny, in GBP; **and the same figures are pinned on
the cross-owner fixture "the regression to fear" orders built**, because the
estate fixture alone cannot catch the wrong basis: on it, the ownership sums and
the old roster basis (`residual + committed` over roster accounts) coincide —
£2,501 / £1,524 / £4,025 both ways, verified at `22c1ce6` — since every authored
movement is Alice's, fully funded, into a pot of hers that spends nothing. An
implementation that wired the new fields to the roster basis would pass the
estate pin to the penny; only an authored movement crossing owners tells the two
apart. The EUR partition is reported separately and never added in; a solo user
with one account plans and reports byte-identically to today (pin it); the
ONE-ENGINE identity
`totalFundedMinor + leftoverMinor === monthlyIncomeMinor − bufferMinor` still
holds — no existing field moved; domain coverage does not drop below
99.87 / 95.84; `pnpm build` and `prettier --check .` pass.

Owns: `packages/domain/src/engine.ts`, `scope.ts`, `household.ts`, `projection.ts`,
`types.ts`, `index.ts`, their tests, and the flip of `mine.test.ts` (sequential
hand-off — WP-AB's agent is done by then). Size **L**. **Coverage gate applies.**
Depends: WP-AB.

## WP-AF · API: the overview is yours

**Goal:** every figure the dashboard reads is the caller's own money, computed by
the pass rather than assembled by the browser.

- `GET /api/overview`: each account summary gains `residualMinor` and
  `ownerUserId`; each currency bucket gains
  `you: { leftoverMinor, shortfallMinor, paymentCount }` from `leftoverForUser`,
  summed across the planned scopes the caller appears in. The second and third
  are **decision 24** — the headline's shortfall and payment count move onto the
  ownership basis with its left over, and they ship as fields rather than being
  assembled in the browser, which is this package's whole point. That
  sum is safe and exact — `closeScope` pulls in every account an owner owns
  (`plan.ts:482–485`), so all of a caller's accounts are in one scope with them.
- The household plan response carries `personalLeftoverMinor` per member and
  `membersLeftoverMinor` for the household.
- Access rules preserved exactly: member names gated on household membership,
  amounts never gated — asserted again.
- **The digest tells you to make a co-member's transfers** (WP-AE's hunt;
  verified in source at the wave 2 boundary). `notify.ts:68–86` builds `mine`
  from **accessible** accounts, so a co-member's account shared to you is in it
  and its outgoing movements land in your daily email as things for you to do.
  The comment at `:77–78` already states the intended rule — _"money leaving
  somebody else's account is not on it"_ — so the code simply does not do what it
  says. One predicate: `from.ownerUserId === userId`. It is the assumption this
  plan hunts, in an email the reader cannot correct afterwards, which is why it
  is not deferred.
- **The household projection strip is on the roster basis**
  (`projection.ts:556–572`, `householdProjectionFromScope`).
  `HouseholdMonthProjection.leftoverMinor` sums `MonthProjection.leftoverMinor`
  over the roster — the projection analogue of `householdLeftoverMinor`, one
  altitude up from the account-page disagreement this plan opens with. The moment
  WP-AG prints `membersLeftoverMinor` on the household page, that page's strip
  contradicts its own headline. `householdProjectionFromScope` is handed
  `AccountProjection`s, which carry no owner, so the fix needs an additive
  `ownerUserId` on that type — which is why `packages/domain/src/projection.ts`
  and its test move into this package's ownership and the **domain coverage gate
  applies here**. The doc comment directly above that function reads _"two
  surfaces reporting one figure differently is the defect ONE-ENGINE.md exists to
  end"_; shipping WP-AG without this would create exactly that.

**`CurrencyOverview.leftoverMinor` is kept, and the question is closed.** The
plan listed it as superseded **"if nothing still reads it"**, and that condition
is now demonstrably false: `apps/api/src/server.test.ts:4048–4049` reads it, and
the ONE-ENGINE rollup identity is _stated_ over the bucket in
`inflows.invariant.test.ts:269, 271, 279, 327, 384–385, 409` and
`engine.edge.test.ts:443` — a pin this plan keeps **verbatim**. No single package
owns both sets of callers, and the plan's own rule is that a red build from a
deletion is a result only when the deleter owns them. Its five siblings
(`monthlyIncomeMinor`, `bufferMinor`, `totalRequiredMinor`, `totalFundedMinor`,
`shortfallMinor`) are equally unread by the web and equally kept. Nothing here is
deleted; the access-basis roll-up simply stops being what any screen reads.

**Acceptance:** on the estate fixture, Alice's overview reports
`you.leftoverMinor` £2,501.00 GBP and the account rows' `residualMinor` sum to it;
Bob's reports £1,524.00 and contains none of Alice's; the household response
reports £4,025.00; a second currency is a second bucket and is never added in; an
account shared **to** the caller appears in their account list and **not** in
their `you` figure (decision 20, pinned); `pnpm build` and `prettier --check .`
pass.

Owns: `apps/api/src/plan.ts`, `server.ts`, `plan.test.ts`, `server.test.ts`,
`apps/api/src/notify.ts` + its test, and `packages/domain/src/projection.ts` +
its test (both added at the wave 2 boundary, above). Size **M→L**. **Coverage
gate applies**, because it now touches the domain. Depends: WP-AC (same file),
WP-AE.

## WP-AG · Web: one left over, and no net worth

**Goal:** every screen prints the same derivation, and the figure that could not
be made honest is gone.

- `/accounts` index and the dashboard's account table print `residualMinor`
  through **one shared helper** — `PlanTable.leftOverMinor`, extracted so a fourth
  surface cannot be added wrong, including its rule that an account with no income
  and nothing in it shows an em dash rather than a claim of £0.
- The account page's projection strip prints the month's residual —
  `MonthProjection.residualMinor`, WP-AE's field, never a reconstruction — so
  the two figures on that page agree.
- `deriveHeadline` reads `you.leftoverMinor`, `you.shortfallMinor` and
  `you.paymentCount`, and nothing else. The household-vs-standalone partition
  (`needsYou.ts:814–858`) that existed only to avoid double counting **is
  deleted** — a per-owner figure has nothing to de-duplicate — and per
  **decision 24** that deletion now takes the shortfall and the payment count
  with it, both of which the partition also computed (`:817–819`, `:856–858`).
  The shortfall sentence stops naming a co-member who is short; the checklist row
  beneath it does not, and `standaloneAccounts` (`:723–726`) keeps feeding
  `deriveNeedsYou` (`:753`) unchanged — an account shared to you is a legitimate
  thing to be asked to act on, and only the _figures_ move to ownership. Decide
  and record whether the headline keeps its `Math.max(0, …)`
  floor: a residual is deliberately signed, and a negative one names the one thing
  to do (consolidate), which is the argument `ScopeAccountPlan.leftoverMinor`
  already makes for not flooring.
- The household page prints `membersLeftoverMinor`, and its per-member column
  prints `personalLeftoverMinor`, so the rows add to the total on screen.
- **Net worth is deleted** (decision 21): the section, `netWorthTotals`,
  `netWorthSentence`, `NetWorthChart.tsx`, `lib/networth.ts`, `networth.test.ts`,
  the `histories` fetch, the lazy import, the trend disclosure and every
  assertion for them. Folded into this package rather than given its own because
  it owns `OverviewPage.tsx`, and two agents on that file is the thing this repo
  forbids.
- Tokens only, no new hex; the grep test stands.
- **Four seams WP-AF left you, verified in source at the wave 3 boundary.** The
  first two are the difference between this package changing the screens and
  changing nothing on them:
  - **`ProjectionView.tsx:208, 213` prints `m.leftoverMinor` and is shared by
    _both_ the account page and the household page** (`HouseholdPlanPage.tsx:190`).
    It must read `residualMinor` for accounts and `membersLeftoverMinor` for
    households, or WP-AE's and WP-AF's projection work is invisible.
    `lib/projection.ts:22` (`ProjectionMonthLike`) already carries per-shape
    optional fields and `movedMinor` (`:51`) is the exact precedent: add both
    optionals and read `residualMinor ?? membersLeftoverMinor ?? leftoverMinor`.
    **`apps/web/src/lib/projection.ts` is therefore added to this package's
    ownership.**
  - **`lib/types.ts:550` (`CurrencyOverviewDto`) needs `you`, and `:864`
    (`HouseholdMonthProjectionDto`) needs `membersLeftoverMinor`.** These types are
    hand-written rather than wire-derived, so **typecheck catches neither
    omission** — the field simply reads `undefined` at runtime. This is the fourth
    instance in this repo of that exact trap.
  - **`needsYou.ts:903–906` (`settledTransfers`) counts `h.plan.transfers.length`
    over the whole household**, so the headline tells Alice "all 5 transfers
    settled" when three are Bob's. It is decision 24's unnamed third sibling, on
    the same sentence as the shortfall and the payment count. No API change is
    needed: `TransferDeparture.memberUserId` (`packages/domain/src/types.ts:146`,
    _"the member whose money this is"_) is already on the wire and `needsYou`
    already reads the array — filter it.
  - **`NeedsYouInput` (`needsYou.ts:142–152`) carries no caller identity at all** —
    no `userId`, no `me`. Thread one in: the settled-transfers filter above needs
    it, and so does decision 24's ownership filter, because the account rows now
    carry `ownerUserId` from WP-AF but there is nothing to compare them against.
- **`HouseholdMonthProjection.leftoverMinor` is kept and is _not_ your figure.**
  WP-AF established it is a **third** derivation, not the projection analogue of
  `householdLeftoverMinor`: it sums `MonthProjection.leftoverMinor`
  (own-income-after-own-bills) and reads **£4,705** on the estate against members'
  **£4,025**, pinned at `projection.test.ts:1621`. WP-AF added
  `HouseholdMonthProjection.membersLeftoverMinor` **alongside** it, named to match
  `HouseholdPlan.membersLeftoverMinor` so that "the household page prints
  `membersLeftoverMinor`" covers the strip and the headline with one rule. Print
  the new field; do not redefine the old one.

**Acceptance:** an account's figure is identical on its own page, the accounts
index and the dashboard, asserted in one test over one fixture; the projection
strip's month 1 equals the KPI above it; the headline equals the sum of the
caller's account rows; the household total equals its member rows; no net worth
anything remains, by grep; `pnpm build` and `prettier --check .` pass.

**And it is measured in a real browser** — 1280px and 390px, light and dark, all
three screens, figures read off the screen and recorded. Three defects in this
project were found only that way, this one included.

Owns: `apps/web/src/pages/OverviewPage.tsx`, `AccountsPage.tsx`,
`HouseholdPlanPage.tsx`, `components/PlanTable.tsx`, `ProjectionView.tsx`,
`HouseholdPlanView.tsx`, `lib/needsYou.ts`, `lib/types.ts`, `lib/api.ts`,
`styles.css`, their tests; deletion of `components/NetWorthChart.tsx`,
`lib/networth.ts`, `lib/networth.test.ts`. Size **L**.
Depends: WP-AF, **and MONTH-CLOSE's WP-E must have landed.**

## WP-AJ · A figure that is not all yours says whose it is

**Added at the wave 4 boundary.** Three findings that all say the same thing —
the product asserts money is yours when it is not — and all of which need
`apps/web/src/lib/needsYou.ts` or `HouseholdPlanView.tsx`, which WP-AH does not
own. Given its own package rather than inflated into WP-AH, which is already **L**
with a browser pass and two new test files, and is the riskiest work left.

- **The checklist prints a falsehood** (WP-AG, screenshotted):
  `transfer · Bob current → House pot · £400.00 · **between your own accounts**`.
  `movementItems` (`needsYou.ts:642`) derives from the receiving account's
  arrivals, so the **row** is defensible — Alice can confirm the money arrived in
  her pot — but the **wording** asserts something untrue. This is
  `notify.ts:77–78`'s defect on a second surface, and WP-AG could not fix it
  honestly: `PlanInflowSourceDto` carries the sender's **name** (access-gated)
  but no `ownerUserId`, so the browser cannot tell your own account from a
  co-member's. **It needs an additive `ownerUserId` on the wire**, which is why
  this package owns `server.ts` and `plan.ts` as well. Amounts are never gated;
  an owner id is not a name.
- **Decision 25's two annotations**: the member row's LEFT OVER gains
  "incl. £X that arrived from <member>", and the per-account column gains a
  footer naming the money held in accounts the household does not hold. Match the
  existing "incl. £X elsewhere" cells exactly — same component, same tokens, no
  new hex.
- Report whether the dashboard headline needs the same treatment. It is one
  figure rather than a row of components, so the argument is weaker; decide with
  the screen in front of you and say which way and why.

**Acceptance:** the checklist never describes a co-member's account as your own,
proven by a test that fails before the fix; both annotations appear and read
correctly at 1280px and 390px, light and dark, with the figures recorded; the
annotation is derived from `inflowArrivals`, never recomputed; every figure is
unchanged — this package moves no arithmetic; `pnpm build` and
`prettier --check .` pass.

Owns: `apps/web/src/lib/needsYou.ts`, `components/HouseholdPlanView.tsx`,
`pages/OverviewPage.tsx`, `lib/types.ts`, their tests; `apps/api/src/server.ts`,
`plan.ts`, `server.test.ts`, `plan.test.ts`. Size **M**. Depends: WP-AG.

## WP-AK · The last two places the words are wrong

**Added at the wave 5 boundary**, from WP-AJ's hunt. Both are the same defect
WP-AF and WP-AJ already fixed twice: an honest row under false surrounding
words. Small, and its files are disjoint from WP-AH's **writes**, so the two run
concurrently.

- **`apps/api/src/notify.ts:201`** — the digest section heading `"Money to move
between your own accounts"` is unconditional. WP-AF fixed the **sender** side
  (`from.ownerUserId !== userId`) but `movementLines` never filters the
  **destination**, so a movement out of your account into a co-member's pot
  shared to you lands under a heading that is false for it. It is WP-AJ's
  `leaving for somebody else's account` branch on the one surface a reader cannot
  correct afterwards, which is why it is not deferred. Reuse WP-AJ's four
  readings (`needsYou.ts:594–637`) rather than inventing a second vocabulary for
  the same four cases.
- **`apps/web/src/components/MovementDrawer.tsx:39`** — help text reading
  _"priority only means something for money moving between your own accounts."_
  An authored inflow can be sourced from a co-member's account — the cross-owner
  fixture does exactly that — so the sentence is inaccurate in the same way.
  Lower stakes: explanatory copy, not a figure. Its assertion is at
  `AccountMovements.test.tsx:410`.

**Acceptance:** the digest heading is true of every line beneath it, proven by a
test that fails before the fix; the drawer's help text is accurate for a movement
sourced from a co-member's account; no figure anywhere changes; `pnpm build` and
`prettier --check .` pass.

Owns: `apps/api/src/notify.ts` + `notify.test.ts`,
`apps/web/src/components/MovementDrawer.tsx` +
`components/AccountMovements.test.tsx`. **May read but never edit**
`apps/web/src/lib/types.ts` and `lib/api.ts` — WP-AH is changing both
concurrently. Size **S**. Depends: WP-AJ.

## WP-AL · The settled-transfer count is two bases in one sentence

**Added mid-wave-6**, from WP-AK's hunt, and it was **live**. `settledTransfers`
(`needsYou.ts:997–1010`) was two terms on two bases: the household term correctly
filtered `t.memberUserId === input.userId` — decision 24's own fix — while the
account term reduced `inflowArrivals` over every **accessible** account with no
ownership filter. So Alice was told that Bob's movement between two of Bob's
accounts was a transfer of hers that settled, in the same sentence whose payment
count was ownership-based. `mine()` already existed ten lines above, and the
account term sat outside the `userId === undefined` guard, so the sentence made an
ownership claim while `GET /api/users/me` was still in flight.

Fixed by hoisting `mine()` to function scope and adding `&& mine(a)` — the whole
non-comment diff. While the caller is unknown both terms go to zero and the clause
disappears, which is the honest answer. **Nothing caught this because no fixture
put a co-member-owned account carrying arrivals into `input.accounts`**; the test
that believed it covered the in-flight path passed only because its fixture had no
accounts at all. That is this repo's standing failure mode, and the new
`settledPot(accountId, ownerUserId)` helper exists to end it.

## WP-AM · The last of the possessives

**Added mid-wave-6** to end the hunt deliberately rather than by exhaustion.

- **`FlowPage.tsx`** — the preset button "everything you own" selected every
  **accessible** account, so every aggregate on the page covered a co-member's
  money under a button claiming ownership. Now filtered to `a.owner`, matching the
  idiom `AccountsPage.tsx:252` already used. Nothing is lost: the household
  buttons beside it give the wider view and the chips add any visible account back
  by hand.
- **`AccountMovements.tsx`** — `outboundNote` keeps rendering for a viewer but
  stops telling them to consolidate somebody else's income; `duplicateFeedNote`
  drops the unprovable authorship claim and gates its "delete it" instruction on
  the access that decides whether the ✕ exists. **The figure was correct**: traced
  through `scope.ts:978, :918–920, :1321–1324`, `derived ≡ transferInMinor` for
  every caller — only the sentence was wrong.
- **`PlanTable.tsx`** — the empty state is three-way on ownership _and_ ability,
  so a view-only reader is not told to add a payment they cannot add.

## WP-AH · Projects: personal or shared, end to end

**Goal:** a project can be shared into your household, and what it may contain
follows from decision 23.

- Contracts: `createProjectBody` / `updateProjectBody` gain
  `visibility: enum(["personal","shared"]).default("personal")`; `ProjectDto`
  follows.
- `GET /api/projects` lists via `listProjectsForUser`. `GET /api/projects/:id`
  admits a co-member of the owner's household when the project is shared, and
  keeps the 404 otherwise. `PATCH`/`DELETE` stay owner-only.
- The constraint, enforced on both sides of the join: filing a payment into a
  **shared** project requires that payment's account to be shared into the
  household (422, naming the account); flipping a project personal→shared 422s and
  **names every payment that does not qualify** rather than silently unlinking;
  shared→personal is always allowed. Creating a shared project with no household
  is 422.
- The join's third mutation, named so nobody finds it later:
  `PATCH /api/payments/:paymentId` moving a payment to another account while its
  `projectId` names a **shared** project re-runs the shared-side check against
  the destination (422, naming the account) — or the move quietly smuggles an
  unshared account's payment into a shared project around both gates above.
- Web: a personal/shared control on `ProjectsPage`, an owner and a visibility
  badge on `ProjectDetailPage`, and `NewPaymentDrawer`'s project `<select>`
  offering shared projects and refusing the combinations the API refuses, before
  the round trip.
- Both project pages get their **first** test files; neither has one today while
  every neighbouring page does. Fixtures shaped like the estate — a household of
  two — never a lone user, which is the shape that let five audits miss a live
  defect.
- `portability.ts`, owned here now: `visibility` deliberately does **not**
  round-trip (Ben, 2026-08-05, at review). The export maps four project fields
  and the import creates from the same four, so an imported project reads back
  `personal` — and that is correct, not a gap: "shared" resolves through the
  owner's membership on the day it is read, so exporting it would auto-share a
  restored project into whatever household the importer belongs to by then — a
  surprise, not a restoration. Write the comment saying so beside the export
  mapping (`:211`), next to the one `projectId` already has. The export stays
  **owner-scoped** — a backup must not carry a co-member's shared project.
- **Two seams WP-AC left you, named with `file:line` because a finding that lands
  in a report and not in a brief is a finding lost:**
  - `ProjectDetailPage.tsx:118` renders `{p.accountName}` bare and
    `lib/types.ts:197` declares `accountName: string`, but WP-AC's fix now omits
    the field when the caller may not be told the name. The web types are
    hand-written rather than wire-derived, so **typecheck does not catch this** —
    the cell renders empty. Make the type optional and give it the honest
    fallback `{p.accountName ?? "another account"}`, the phrasing
    `PlanTable.tsx:328` already uses. Both files are yours; do them together.
  - **The `Project` policy subject needs its second arm the moment you swap
    `server.ts:2062` to `listProjectsForUser`.** `PROJECT_OWNER_ACTIONS`
    (`ability.ts:76`) grants only the owner, so filing a payment into a
    **co-member's shared project** will 422 the instant the UI can offer one —
    `NewPaymentDrawer.tsx:462` can only offer your own today, which is the only
    reason the gate is unreachable. That set is the one place to widen, and it is
    a set rather than a comparison for exactly this. `requireProjectForPayment`
    (`server.ts:494`) returns the `Project` so decision 23's shared-side check
    need not fetch it twice.
- Settle `listProjectsForOwner` (deferred from WP-AD, whose files could not
  reach its callers): swap `server.ts:1982` to `listProjectsForUser`, then
  either keep the owner method with `portability.ts:211` named as its caller, or
  move portability onto `listProjectsForUser` filtered to
  `ownerUserId === userId` and delete it — whichever reads better, reported per
  the standing rule either way.

**Acceptance:** a shared project appears in a co-member's list and a stranger gets
404; a payment on an unshared account is refused entry to a shared project, named;
moving a payment in a shared project to an unshared account is refused the same
way; a personal project accepts any payment on any account the caller owns,
including one on an account shared into the household; unsharing an account
removes its payments from shared projects and leaves personal ones alone, and a
leaver's shared projects come back personal and stripped of non-owned payments
(WP-AD's store paths, through HTTP); an exported-then-imported shared project
reads back `personal`, asserted in `portability.test.ts` with the estate shape;
`pnpm build` and `prettier --check .` pass; measured in a browser at both widths
and both themes.

Owns: `apps/api/src/server.ts`, `server.test.ts`, `portability.ts`,
`portability.test.ts`, `packages/contracts`,
`apps/web/src/pages/ProjectsPage.tsx` + test (new),
`ProjectDetailPage.tsx` + test (new), `components/NewPaymentDrawer.tsx` + test,
`lib/api.ts`, `lib/types.ts`. Size **L**. Depends: WP-AD, WP-AF, WP-AG (files).

## WP-AI · Closing the books

**Goal:** the repository's documentation stops describing what this work deletes.

- `README.md`: any feature-tour mention of net worth goes; the projects section
  says a project is personal or shared.
- `BACKLOG.md`: retire whatever entries this work executed — including the two
  project entries at `:163–164` and `:267–268` if they are now moot — and add the
  net-worth removal as a decision taken rather than a feature lost.
- Commit `MINE-AND-OURS.md` as the plan of record (deliberately untracked until
  this package), noting it continues MONTH-CLOSE's decision sequence at 19 and
  supersedes one clause of ONE-ENGINE decision 13.

### What to book in `BACKLOG.md`, gathered across waves 5–6

Four packages in a row each found the next instance of _"the product says money
is yours when it is not"_ (WP-AF, WP-AJ, WP-AK, WP-AL), and WP-AM swept the
product once more to end the chain deliberately rather than by exhaustion.
Everything below was **found, verified and left unfixed on purpose**. Book it;
do not fix it here.

- **`apps/web/src/components/MemberTagBars.tsx:62, :85`** — `title` and legend
  read "elsewhere in your plan · £X" on **every** member's bar, and the component
  takes no `userId`, so a co-member's bar claims their money is yours. Its own
  `aria-label` three lines above correctly says `Bob: …`, so the accessible name
  and the tooltip disagree. **Dead code today** — imported by nothing but its own
  test — which is the only reason it is not fixed. Anyone who renders this
  component ships the defect.
- **`apps/web/src/components/AccountMovements.tsx:419`** — "nothing you
  authored." Live and user-visible, but renders only when there are zero authored
  rows from anybody, so it is literally true for every reader — imprecise rather
  than false. Left deliberately.
- **`apps/web/src/pages/AccountPage.tsx:225–238`** (WP-AH) — the payment project
  chip resolves against `listProjects()`, which now carries co-members' shared
  projects, so a payment on your account filed by a co-member into their shared
  project now names and links it. A strict improvement and safe (`proj ? … :
null`), but **nothing asserts it**. Wants a test.
- **Stale internal comments** repeating _"another account you own"_ where the real
  predicate is `requireAccess(…, "edit")` — a co-member's account qualifies. This
  is the belief that kept getting re-implemented one function away, which is why
  it is worth clearing: `packages/contracts/src/index.ts:179–180`;
  `apps/web/src/lib/types.ts:276, :347, :1084`;
  `apps/web/src/lib/needsYou.ts:207, :647, :1011`;
  `apps/web/src/components/Fold.tsx:177`; `apps/web/src/lib/api.ts:404`;
  `packages/domain/src/types.ts:351`; `packages/domain/src/flow.ts:44`;
  `apps/api/src/portability.ts:43`; `packages/data/src/entities.ts:284`;
  `apps/api/src/server.ts:985, :1962`.
- **Do not "clean up" these four** — they are **correct as written** and narrate
  defects this plan fixed: `apps/web/src/components/MovementDrawer.tsx:40, :97`,
  `apps/web/src/lib/needsYou.ts:612`, `apps/api/src/notify.ts:83`. Book this
  warning with the list above, or the next sweep will delete the explanations.

**Acceptance:** no document describes net worth or owner-only projects as current;
every item above is booked with its `file:line` and its severity (live / dead code
/ internal comment); `MINE-AND-OURS.md` is tracked; `prettier --check .` passes.

Owns: `README.md`, `BACKLOG.md`, `MINE-AND-OURS.md`. Size **S**. Depends: WP-AH,
WP-AM.

---

## Waves

| Wave | Packages                      | Notes                                                      |
| ---- | ----------------------------- | ---------------------------------------------------------- |
| 1    | WP-AB + WP-AC + WP-AD         | disjoint: domain pin vs API leak vs migration + store      |
| 2    | WP-AE                         | alone; owns the pass, takes WP-AB's pin and flips it green |
| 3    | WP-AF                         | alone; owns the API choke point                            |
| 4    | WP-AG                         | alone; MONTH-CLOSE WP-E's hold has lifted (`4ef73ad`)      |
| 5    | WP-AJ                         | alone; added at the wave 4 boundary (decision 25)          |
| 6    | WP-AH + WP-AK + WP-AL + WP-AM | disjoint writes; AL and AM added mid-wave from hunts       |
| 7    | WP-AI                         | documentation closes the books; nothing runs beside it     |

WP-AJ runs **before** WP-AH rather than after: both need `server.ts` and
`lib/types.ts` so they cannot overlap, and WP-AJ is the smaller of the two and
completes this plan's spine — what is mine and what is ours. If the work is cut
short, the right thing to have finished is the boundary, not the projects
feature.

Two agents may only run concurrently on disjoint file sets. Never two agents on
`apps/web/src/styles.css` or `apps/web/src/lib/api.ts` at once, and never two on
`apps/api/src/server.ts` — which is why WP-AC, WP-AF and WP-AH are in three
different waves despite being three unrelated jobs.

**At every wave boundary,** the orchestrator re-opens each finding any agent
dismissed as "premise false" and re-tests it against the premise as it then
stands — ONE-ENGINE's standing rule, carried forward. A dismissal is dated
evidence about a past tree, never a settled fact about the current one.

## Superseded code is deleted, not left lying around

`netWorthTotals`, `netWorthSentence`, `buildNetWorthSeries`, `seriesCurrencies`,
`NetWorthChart`, and the household-vs-standalone partition in `deriveHeadline`.
`CurrencyOverview.leftoverMinor` **was** on this list under the condition "if
nothing still reads it"; at the wave 2 boundary that condition resolved to
**false** and it is kept — see WP-AF for the callers and why no package owns them
all. Its five siblings are kept with it.
`listProjectsForOwner` is deliberately **not** on this list: it is not
superseded — it answers "what do I own", the export needs that question asked,
and its fate is settled in WP-AH with its callers in hand, not in WP-AD by
reflex (see both). Each package reports, per symbol it supersedes: deleted, or
kept with the reason and the name of whoever still calls it. "Nothing calls it
any more, so I left it" is not an acceptable answer, and a red build from a
deletion is a result rather than a problem — **when the deleter owns the
callers**, which is the condition that moved this one to WP-AH.

## Pinned tests: kept, added, deliberately re-pinned

- **Kept verbatim:** the solo-user byte-identical pin; the three-way parity fixture
  (`parity.test.ts`); the externally-funded byte-identical pin
  (`inflows.invariant.test.ts:188`); the ONE-ENGINE rollup identity.
- **Added:** the three-altitude identity (WP-AB, red first, green by WP-AE); an
  account shared **to** the caller is in their list and not in their figure; one
  account's left over is identical on three screens.
- **Deliberately re-pinned, once, in WP-AG:** every OverviewPage assertion that
  named a net worth figure — they are deleted with the feature, not re-baselined.
  Any _other_ pinned test that fails is a defect in the work.

## The regression to fear

**A co-member's money parked in your account.** Summing residuals over the
accounts one person owns is exact only because a transfer that leaves their estate
is subtracted where it leaves and added where it lands. When a co-member transfers
into an account **you** own and the money is not fully spent there, the remainder
sits in your residual and therefore in your personal figure — genuinely in your
account, genuinely not your money. On the estate fixture it happens to vanish
(Bob's £476 into the house pot is entirely consumed by the pot's bills), which is
exactly the kind of coincidence that lets a defect through — and it is no
accident that a **derived** transfer cannot produce the case: the pass derives
transport equal to what the destination cannot pay from its own income, so the
bills consume it by construction (verified at `22c1ce6` by shrinking the pot's
bills — the transport shrank with them). Only an **authored** movement crossing
owners reaches it. **Build that fixture** — a co-member's authored movement into
a pot you own, not fully spent there — decide what the figure should say, and
pin it. It is load-bearing twice over: it is also the only shape that
distinguishes the ownership basis from the old roster basis (WP-AE's
acceptance says why the estate fixture cannot). `engine.ts:434–443` already
names this case in prose as the one no netting can fix; this is the first plan
whose figures depend on it.

The household total is **not** at risk from it: the pound is added to your figure
and subtracted from theirs, so their sum still counts it once. Only the personal
figure moves.

And the standing instruction, which has found the live defect in every plan so
far: **hunt for the assumption rather than assuming its absence.** The assumption
this time is _"a figure on my dashboard is about my money."_ Every roll-up in the
product — the overview buckets, the digest, `needsYou`, the upcoming list, the
projection totals — either counts accounts by ownership after this work or is a
place it is incomplete. If you find one this plan does not name, report it before
coding around it.
