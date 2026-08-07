# Implementation plan — said, and done

Fifteen open issues on the board, read in full and verified against `main` at
`76ee2f2` on **2026-08-07**. One (#42) was already fixed before it was filed and
is closed with its evidence; the rest are planned below. One (#56) is a rule in
a dashboard nobody here can reach — so this plan takes the half that is ours,
which is the request volume the rule is firing on.

Every `file:line` in this document is a **hint to verify**. Three references in
the last plan had drifted by the time the packages holding them ran, and two in
the issues themselves are already wrong — #69 names lines 848 and 886, and the
call sites are at 857, 872, 897 and 912. Grep for the symbol, confirm it says
what this document claims, and **report the drift rather than working around
it.**

---

## The surfaces that disagree

| surface                                              | what it says                                                       | what is true                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/RealityStrip.tsx:83-87`     | "balance is **£222.94** short of what the plan has set aside"      | `reservedMinor` is `Σ alreadySavedMinor` (`apps/api/src/server.ts:208`) — cumulative, not this month's      |
| same screen, same moment                             | **£46.39** arriving · **£1,306.98** left over · goals on track     | the banner reads neither figure; `234.64 − 11.70 = 222.94` is the whole computation (`RealityStrip.tsx:28`) |
| `apps/web/src/lib/flow.ts:117-127`                   | pot funded from **`elsewhere`**                                    | the sending account is drawn in the same diagram; `FlowPage.tsx:57` reshapes a plan instead of asking       |
| `apps/auth/src/server.ts:337`                        | `rl(3)` on `/auth/register`                                        | **0 requests throttled** — the plugin registers after every route it should have seen (`:126-128`)          |
| `apps/api/src/server.ts:2035`                        | confirmation keyed to `body.month`                                 | validated against `scopeForHousehold(store, id, **today()**)` at `:2050`; same shape at `:2146` and `:2273` |
| `deploy/helm/finance-planner/values-prod.yaml:20-21` | `auth: replicas: 1`, "raise only once that state lives on the row" | `templates/scaling.yaml:2` ranges over **every** service at `minReplicas: 2` (`values.yaml:80`)             |
| `apps/web/src/lib/api.ts:332,338`                    | `listContributions`, `deleteContribution`                          | called from **nowhere**. A recorded contribution is write-only from the UI                                  |

Ben's £222.94 reproduces exactly, and that is the point: **every figure here is
arithmetically correct.** Not one of these is a calculation bug.

## The reframing

**Recording that something happened is not the same fact as it having
happened — and this codebase keeps storing the first and reading back the
second.**

A rate limit is registered but never applied. A digest claims the day before it
sends. A confirmation is written for one month and validated against another. A
contribution is recorded and never shown again. A movement between two accounts
on screen is drawn as arriving from nowhere. A chart declares one replica and
renders an autoscaler for six. A test waits for the thing it is not asserting.

Every package below closes the gap between a claim and the thing it claims.

## Decisions (26–35, continuing MINE-AND-OURS' numbering — do not relitigate)

Still binding from earlier plans, carried forward explicitly because packages
here touch all four: **ONE-ENGINE decision 10** (the pass partitions by currency
and nothing derived crosses one), **decision 13** (`leftoverMinor` keeps its
meaning to the penny on every surface), **MONTH-CLOSE decision 14** (a close is
a user's; the account- and household-scoped ones are deleted), and
**MINE-AND-OURS decisions 21 and 22** (net worth is deleted and is not to be
rebuilt; a project is personal or shared).

26. **`reservedMinor` is a cumulative already-saved total, not a monthly
    reserve.** `apps/api/src/server.ts:208` sums `alreadySavedMinor` across every
    line, which accumulates across months. The headline will count money still
    arriving (decision 27), and on Ben's own figures **that alone does not
    silence the banner**: `234.64 − (11.70 + 46.39) = 176.55`. That residue is
    expected. It is the real question the screen has never asked — _money was
    recorded as saved into this account and the account does not hold it_ — and
    it must be **explained on screen, not floored away**. A package that makes
    the number zero by clamping has failed.
27. **"Short" means the month cannot cover it** (Ben, 2026-08-07): warn on
    `reserved > balance + arriving`, not `reserved > balance`.
28. **Unconfirm requires exactly what confirm requires** (Ben, 2026-08-07). The
    stricter side wins, and this **removes an ability co-editors on a shared
    destination account have today**. That is intended, not a regression.
29. **An import file with duplicate account names is refused, naming the
    duplicate** (Ben, 2026-08-07). `apps/api/src/portability.test.ts:400`
    currently blesses the opposite — it is deleted by the package that reverses
    it, not left passing beside the new rule.
30. **A recorded contribution is editable** (Ben, 2026-08-07): a real
    `PATCH /api/contributions/:contributionId`, not delete-and-re-record.
31. **The household flow page asks the server rather than reshaping a plan it
    already has.** `api.flow()` already exists and already itemises movement by
    movement (`FlowPage.tsx:59`). `householdFlow` is **deleted**, not left as a
    second derivation — the two-engine split is what `ONE-ENGINE.md` exists to
    end, and its module comment at `apps/web/src/lib/flow.ts:35-44` documents the
    `elsewhere` bucket as deliberate, which is precisely why it must go rather
    than be patched.
32. **Atomicity comes from a compound `Store` method, not a general transaction
    primitive.** `packages/data/src/store.ts` has 93 methods and no transaction
    concept anywhere; introducing one is a larger change than every defect here
    combined. The house precedent is the compensating-delete loop at
    `apps/api/src/server.ts:1337-1341`. **If `PgStore` turns out to have no
    usable transaction handle, say so and stop** — do not invent one.
33. **auth is excluded from the HPA; the rotation state stays in process.**
    Moving it to the session row is the `BACKLOG.md` entry and is **not in
    scope**. This plan makes the chart stop contradicting the service.
34. **#56 (Cloudflare rate limiting) is half a repository problem, and that half
    is in scope.** The rule itself lives in a dashboard — no Cloudflare config,
    no ingress annotations
    (`deploy/helm/finance-planner/templates/ingress.yaml` carries none) — and
    only Ben can change it. But **a rate limit trips on request volume, and the
    volume is ours.** Every page holds six or seven `useAsync` calls before the
    components underneath it fetch anything of their own, and
    `AccountMovements.test.tsx:80` records five more from that section alone. The
    question "is the rule too tight" cannot be answered without the number on the
    other side of it, and nobody has measured it. WP-BA does. The issue stays
    open until the traffic is understood, not until this plan lands.
35. **#42 is already fixed and should be closed.** `4ef73ad` landed the
    user-level scorecard at 2026-08-05T12:28Z — **87 minutes before the issue was
    filed**. On today's tree `apps/web/src/pages/AccountPage.tsx` has no close
    control, `AccountPage.test.tsx:171` asserts it "neither offers a close nor
    asks anything about one", and `MonthScorecard` sits on the Overview
    (`OverviewPage.tsx:283`). Its durable replacement is WP-AZ.

### Added mid-flight, 2026-08-07, after wave 2 landed

36. **A flow diagram draws an account the viewer cannot see as an anonymous
    node — it does not refuse** (Ben, 2026-08-07). WP-AS routed the household
    flow page to `/api/flow` per decision 31, and `/api/flow`
    (`apps/api/src/server.ts:1856`) gates **per account**: it throws
    `404 Account not found` if the caller lacks `view` on any one of them.
    `/api/households/:id/plan` (`:1936`) gates only on **membership**, and says
    so deliberately — _"Any member can view the joint plan, regardless of
    per-account share grants — it is the household's shared financial picture by
    design."_ So a member of a household holding an **assigned-but-unshared**
    account — a configuration `HouseholdDetailPage` offers directly, share
    (`:776`) and assign (`:682`) being separate controls — lost the diagram
    entirely. The answer is neither the refusal nor a membership gate that names
    the account: **the node keeps its money and loses its name.** Totals still
    balance, and #43 stays fixed — an account you _can_ see is drawn by name,
    which was the whole complaint. WP-BB.
37. **The household plan must apply the arrival it records.** WP-AS surfaced it:
    the chart draws `holiday · £500.00` arriving with £500 left over, while the
    table beside it prints LEFT OVER `£0.00`, same account, same date.
    `packages/domain/src/household.ts:382` computes
    `leftoverMinor: availableLeftoverMinor + committedMinor` and
    `movementInMinor` is not in it, though the invariant at `:271` names it.
    **Decision 13** — `leftoverMinor` keeps its meaning to the penny on every
    surface — is what makes this a defect rather than a difference of opinion.
    Pre-existing; WP-AS made the two figures sit side by side. WP-BC.
38. **The projection is #45's unfixed other half.** WP-AT found it in a browser
    after fixing the banner: `projectedBalanceMinor` returns **`-22294`** for
    Ben's account — literally −£222.94, the issue's own figure — drawn as a
    12-month line on an account with £2,000/mo income that is not overdrawn.
    `packages/domain/src/projection.ts:418` (`sim.balance += setAside - paidOut`)
    pays month 1's goals out in full while crediting only that month's set-aside,
    and **never credits the £234.64 already recorded as saved**. It is the exact
    mirror of the banner's error: the banner treated the record as money that
    ought to be in the account; the projection treats it as money that never
    existed. Same assumption, opposite sign. The plan's "surfaces that disagree"
    table named only `RealityStrip.tsx:28` for #45, which is why this half was
    missed. WP-BD.

**Also found stale, and worth deleting from `BACKLOG.md`:** the entry "A derived
transfer you confirmed does not survive an export" is no longer true.
`derivedTransferConfirmations` is carried end to end —
`packages/contracts/src/index.ts:633`, `apps/api/src/portability.ts:113`, `:178`,
`:359`, `:374` — and `portability.ts:53` narrates the fix. WP-AV deletes the
entry.

## Deletion belongs to the package that supersedes

Every package that replaces something **deletes it in the same commit**, and
reports per symbol: deleted, or kept with the name of whoever still calls it.
"Nothing calls it any more, so I left it" is not an acceptable answer. A red
build from a deletion is a **result** — it inventories the callers better than
any grep.

Named deletions this plan owes: `householdFlow` and its tests (WP-AS);
`apps/api/src/portability.test.ts:400` (WP-AV); the stale `BACKLOG.md` export
entry (WP-AV); every pin file's `it.fails`, flipped by the package named on it.

## The red pins

**One pin file per defect**, so that the packages flipping them never co-own a
file. Each lands as `it.fails` with the observed figures **in a comment in the
test itself**, against commit `76ee2f2`. CI stays green while the defect stands
and the tree documents that the disagreement is known. This repo has done it
three times before — `packages/domain/src/parity.test.ts:38`,
`mine.test.ts:32`, `flow.test.ts:420` — follow their shape.

**The plan's one objective completion signal: no `it.fails` remains in any
`*.pin.test.*` file.**

---

## WP-AN · The pins, written first and seen red

**Goal:** five failing tests exist, each naming the package that will flip it,
each carrying the figure observed on `76ee2f2`.

- `apps/api/src/pins/confirm-month.pin.test.ts` — #50. Confirm a transfer for a
  **past** month against a plan whose shape differs from today's; assert the
  amount booked comes from that month. Flipped by **WP-AO**.
- `apps/api/src/pins/unconfirm-rights.pin.test.ts` — #47. A co-editor on the
  receiving account who is _not_ `memberUserId` un-confirms; assert 403.
  Flipped by **WP-AO**.
- `apps/api/src/pins/confirmation-ledger.pin.test.ts` — #49. Delete a
  contribution carrying a `transferConfirmationId`; assert it is refused (or that
  the confirmation goes with it — WP-AP decides which, and the pin asserts the
  invariant "confirmation and its rows are one fact", not the mechanism).
  Flipped by **WP-AP**.
- `apps/web/src/pins/flow-elsewhere.pin.test.tsx` — #43. A household of two
  current accounts and a pot fed by an authored movement from one of them;
  assert the ribbon runs **account → pot**, not `elsewhere → pot`. Flipped by
  **WP-AS**.
- `apps/web/src/pins/headline-short.pin.test.tsx` — #45. Ben's exact figures —
  balance £11.70, reserved £234.64, arriving £46.39 — asserting the banner does
  **not** say £222.94. Record all four in the comment. Flipped by **WP-AT**.

The fixture each pin builds is described in **The regression to fear** below;
read that section before writing them, because what these fixtures must _not_
avoid is the whole point.

**Acceptance:** `pnpm test` is green with five tests reported as expected
failures. Each file names its flipping package in a header comment. Running any
one with `it` instead of `it.fails` fails, and the agent has **seen** that and
says so in its report.

Owns: `apps/api/src/pins/*` (new), `apps/web/src/pins/*` (new), and any vitest
`include` globs those directories need. Size **M**. Depends: none.

---

## WP-AO · What a confirm handler checks

**Goal:** a confirmation is validated against the month it is for, and undoing
one takes the same right as making it.

- **#50.** Three handlers take a month and validate against `today()`:
  `POST /api/households/:id/transfers/confirm` (`:2027`, month at `:2035`,
  `today()` at `:2050`); `POST /api/inflows/:inflowId/confirm` (`:2131`,
  `today()` at `:2146`); `POST /api/accounts/:id/transfers/confirm` (`:2257`,
  `today()` at `:2273`). Derive the as-of date from the requested month.
  `closeAsOfDate(month)` at `:154` already does exactly this arithmetic for
  closes and already refuses a future month — **reuse it or say why not**.
- **#47, decision 28.** Confirm requires `body.memberUserId === userId`
  (`:2265`) — unconfirm requires only `edit` on the receiving account (`:2354`,
  `:2374`). Make the delete paths carry the create paths' rule. The household
  route at `:2104` keeps its own admin rule; **this must not become a way around
  it**, and the comment at `:2349-2352` says so already.
- The authored-movement confirm at `:2143-2144` takes `edit` on the receiving
  account and only `view` on the source. Decision 28 is about confirm/unconfirm
  symmetry, **not** about tightening `view`→`edit` here. Leave it, and report if
  you believe the pin cannot pass without it.

**Acceptance:** `confirm-month.pin.test.ts` and `unconfirm-rights.pin.test.ts`
are plain `it` and pass. Confirming a transfer into a month whose plan differs
from today's books that month's amount. A co-editor who is not the member gets
403 from both unconfirm routes. Confirming a **future** month is refused with the
same code closes use.

Owns: `apps/api/src/server.ts` (confirm region, ~`:2027-2400`),
`apps/api/src/server.test.ts`, the two pin files above.
Size **L**. Depends: WP-AN. **Choke point: `apps/api/src/server.ts` — runs alone.**

---

## WP-AP · One fact, one write

**Goal:** a confirmation and the contribution rows it generates are written
together, unwound together, and cannot be taken apart from the side.

- **#48, decision 31.** `POST /api/accounts/:id/transfers/confirm` (`:2300-2338`)
  and the household twin create the confirmation, then append contributions in a
  loop. Add one compound `Store` method — `createTransferConfirmation` plus its
  contributions, succeeding or failing as a unit. `MemoryStore` gets it for free;
  `PgStore` does it in one transaction; `store-contract.ts` proves both agree,
  including the **partial-failure** case.
- **#49.** `DELETE /api/contributions/:contributionId` (`:1252-1261`) checks
  `edit` on the account and deletes anything. Guard rows carrying a
  `transferConfirmationId`: either refuse them (pointing the caller at unconfirm)
  or unwind the confirmation with them. **Refusing is the recommendation** — the
  unconfirm route already exists and already does the unwind correctly, and two
  ways to undo one fact is how this class of defect started.
- **#46 (API half), decision 30.** Add `PATCH /api/contributions/:contributionId`
  — amount, month, note — beside the delete, with its body schema in
  `packages/contracts/src/index.ts` next to `createContributionBody` (`:380`).
  A contribution under a confirmation is **not** patchable either; same guard,
  same reason.

**Acceptance:** `confirmation-ledger.pin.test.ts` is plain `it` and passes. A
contract test drives the compound method's failure path and asserts **no**
confirmation row survives it. A `PATCH` moves a hand-recorded contribution's
amount and the account plan moves with it. A `PATCH` or `DELETE` on a
confirmation-generated row is refused, and un-confirming still removes it.

Owns: `apps/api/src/server.ts` (contribution region ~`:1226-1262` and the two
confirm handlers' write step), `apps/api/src/server.test.ts`,
`packages/data/src/{store,memory-store,pg-store,store-contract}.ts`,
`packages/contracts/src/index.ts`, `apps/api/src/pins/confirmation-ledger.pin.test.ts`.
Size **L**. Depends: WP-AO.
**Choke points: `apps/api/src/server.ts` and `packages/contracts/src/index.ts` — runs alone.**

---

## WP-AR · A recorded contribution is visible, and correctable

**Goal:** the account page lists what has been recorded this month and lets a
mistake be fixed.

- `apps/web/src/lib/api.ts:332` (`listContributions`) and `:338`
  (`deleteContribution`) are typed, tested and **called from nowhere**. Wire them
  up and add the `PATCH` method beside them.
- The record action already exists in two places —
  `apps/web/src/pages/AccountPage.tsx:121` and
  `apps/web/src/components/Fold.tsx:193`. The list belongs where the recording
  happens; do not add a third surface.
- A row generated by a transfer confirmation renders as such and offers no edit,
  matching WP-AP's guard. It must not offer an action the API will refuse.

**Acceptance:** record a contribution, see it listed with its amount and month,
change the amount, see the plan move. A confirmation-generated row shows its
origin and offers no edit or remove control. Driven **in a real browser** at 1280
and 390, not only in jsdom — `ORCHESTRATION.md` names three defects found only
that way.

Owns: `apps/web/src/pages/AccountPage.tsx`, `apps/web/src/lib/api.ts`, one new
component + test, `apps/web/src/pages/AccountPage.test.tsx`.
Size **M**. Depends: WP-AP.

---

## WP-AS · The household flow draws the accounts it is already drawing

**Goal:** a pot fed by a movement from an account on screen shows a ribbon from
that account.

- `FlowPage.tsx:57` — `if (householdId) return api.householdPlan(householdId).then(householdFlow)`.
  The next line already does the right thing for a plain scope:
  `api.flow(scopeKey.split(","))`. Resolve the household's account ids and take
  that path.
- **Decision 31: delete `householdFlow`** (`apps/web/src/lib/flow.ts:68-149`),
  its tests in `flow.test.ts:122-300`, and `HouseholdSankey.tsx` +
  `HouseholdSankey.test.tsx` if nothing else consumes them — **check, and report
  per symbol**. `visibleFlow`, `totalInflowMinor` and `parseAccountIds` stay;
  they are used by the scope path.
- **The trap:** `MAX_FLOW_ACCOUNTS` (`apps/api/src/server.ts:1847`) caps a
  diagram. A household above the cap currently renders via the reshaping path
  and will start 422-ing. Find the cap's value, decide what the page says, and
  **do not silently truncate the account list to fit**.
- Second trap: the flow endpoint plans the scope server-side. A household whose
  accounts span two currencies hits `ONE-ENGINE.md` decision 10 — report what the
  page does rather than making it up.

**Acceptance:** `flow-elsewhere.pin.test.tsx` is plain `it` and passes. Opening
`/flow?household=…` draws account→pot ribbons for authored movements, node
totals still balance, and the diagram is verified **in a real browser** against
a household of two. `householdFlow` does not exist.

Owns: `apps/web/src/pages/FlowPage.tsx`, `apps/web/src/lib/flow.ts`,
`apps/web/src/lib/flow.test.ts`, `apps/web/src/components/HouseholdSankey.tsx`
(+ test), `apps/web/src/pins/flow-elsewhere.pin.test.tsx`.
Size **M**. Depends: WP-AN.

---

## WP-AT · The headline says what it means

**Goal:** the banner stops firing on a month that can cover itself, and starts
saying the thing it has never said.

- `RealityStrip.tsx:28` is `reserved − latest.balanceMinor`. Decision 27: the
  test is `reserved > balance + arriving`. The arriving figure the page already
  prints is `plan.allocatedInflowMinor` (`PlanTable.tsx:380`) — **use that field,
  not a new derivation.**
- **Decision 26 is the substance of this package.** `reservedMinor` is
  `Σ alreadySavedMinor` (`apps/api/src/server.ts:208`), cumulative across months.
  On Ben's figures the gap is still £176.55 after arriving money is counted, and
  that is a **true and previously unsaid** thing: money recorded as saved into
  this account, which the account does not hold. Say it, in words that name
  which of the two it is. Do not clamp it to zero.
- `latest.asOfDate` is already printed at `:52`. A balance checked in three weeks
  ago is a third explanation for the same gap; decide whether the banner is
  entitled to fire on a stale one, and **say what you decided in the code**.

**Acceptance:** `headline-short.pin.test.tsx` is plain `it` and passes. An
account whose arriving money covers the gap shows no banner. Ben's exact figures
produce a sentence a person can act on, and a test asserts its wording. Verified
**in a real browser**.

Owns: `apps/web/src/components/RealityStrip.tsx` (+ test),
`apps/web/src/pins/headline-short.pin.test.tsx`.
Size **M**. Depends: WP-AN.

---

## WP-AU · Two tests that wait on the wrong thing

**Goal:** no assertion in the file is made about the loading state.

- `apps/web/src/components/AccountMovements.test.tsx`. The issue names lines 848
  and 886; **the tree says 857, 872, 897 and 912** — four `findByText(/a month
already arrives here/)` waits on a note rendered from the synchronous `plan`
  prop, followed by synchronous queries for rows that only arrive from
  `GET …/inflows`.
- The file's own `mounted()` helper (`:78-96`) warns about exactly this and is
  called **once in the entire file**. Route every affected site through it.
- `:912`'s `queryByText(...).toBeNull()` is the dangerous one: had the row simply
  not arrived, it would have **passed for the wrong reason**. It needs a positive
  anchor that only exists after the fetch resolves, then the absence assertion.
- Audit the whole file, not only the four. Count the `mounted()` call sites
  before and after and report both numbers.

**Acceptance:** every asynchronous assertion is gated on something the fetch
produces. `pnpm exec turbo run test --force` green, with `Cached: 0 cached` in
the summary — the cached run proves nothing here.

Owns: `apps/web/src/components/AccountMovements.test.tsx`.
Size **S**. Depends: none.

---

## WP-AV · A backup that cannot be restored faithfully is refused

**Goal:** import stops guessing, and a confirmation's contributions come back
tied to it.

- **#52, decision 29.** `apps/api/src/portability.ts:304` resolves
  `fromAccountName` through a first-match map. Names are unique in neither schema
  nor product. Refuse a file carrying duplicate account names, with an error
  naming the duplicate. **Delete `portability.test.ts:400`** ("resolves a repeated
  account name to the first of them") in the same commit — decision 29.
- Check the map's other consumers first: `:141`, `:169` and `:359` all read it.
  The refusal belongs at the point the file is validated, once, not at three call
  sites.
- **#51.** Imported contributions arrive with `transferConfirmationId: null`.
  Carry the tie: the export needs each contribution to name the confirmation that
  produced it, keyed the way the confirmation itself is (two accounts, a month, a
  member) rather than by an id that will not survive. **Additive to the export
  schema only** — a file written before this change must still import, and a test
  must prove it does.
- **Delete the stale `BACKLOG.md` entry** "A derived transfer you confirmed does
  not survive an export": `derivedTransferConfirmations` has been carried end to
  end since `portability.ts:53` was written.

**Acceptance:** a duplicate-name file is refused, naming the duplicate, and
nothing is written. A round trip of a household of two — export, wipe, import —
restores confirmations whose contributions unwind with them, proven by
un-confirming after the restore and seeing the rows go. An export file from
before this change still imports.

Owns: `apps/api/src/portability.ts`, `apps/api/src/portability.test.ts`,
`packages/contracts/src/index.ts` (export schema only), `BACKLOG.md`.
Size **L**. Depends: WP-AP. **Choke point: `packages/contracts/src/index.ts`.**

---

## WP-AW · The auth service is actually rate-limited

**Goal:** `/auth/register` throttles at 3, and a test proves it.

- `apps/auth/src/server.ts:126-128` registers `@fastify/rate-limit` without
  `await`; every route is declared in the same synchronous block from `:337`.
  avvio defers the plugin to `ready()` while `app.post(...)` runs its `onRoute`
  hooks immediately, so the plugin's hook is installed after the last route it
  should have seen.
- **`global: true` is not the fix** — the issue measured it at 0 throttled.
  Either `await` the registration before declaring routes, or move the routes
  into an encapsulated plugin registered after it.
- **The test must drive a real route past the limit** and assert both the 429 and
  the `x-ratelimit-*` headers. A test asserting the plugin is registered passes
  today. Every existing test passes `rateLimit: false` (`:76`, `:334`), which is
  why nobody saw this — decide whether that stays the default and **say why**,
  because leaving it reopens the gap the next time registration order changes.
- Login, register, password-reset and the OIDC callback are all currently
  unthrottled. This is the auth service; treat it accordingly.

**Acceptance:** four requests to `/auth/register` in one window — three accepted,
one 429 with correct headers. The back-to-back-login tests that motivated
`rateLimit: false` still pass.

Owns: `apps/auth/src/server.ts`, `apps/auth/src/server.test.ts`.
Size **M**. Depends: none.

---

## WP-AX · The digest claims the day only once it has sent

**Goal:** a transient SMTP failure leaves the day retryable.

- `apps/api/src/notify.ts:263-274`. `tryLogNotification` claims
  `(user, date, kind)` at `:267`, then `buildDailyDigest` at `:268`, then
  `sendDigest` at `:270`. A throw in either leaves the slot claimed and the day
  permanently dropped.
- **The claim is still the duplicate-prevention gate** and must stay one — the
  comment at `:255-257` is correct about why. Move the _release_, not the claim:
  claim first, and un-claim on failure; or claim, send, and only then commit.
  Whichever you pick, a **second replica must still not double-send** — that
  property is load-bearing and is asserted by existing tests.
- `:269`'s `if (!body) continue` deliberately claims the day for an **empty**
  digest. That is correct and is not a failure. Keep it, and keep the test that
  covers it.

**Acceptance:** a mailer that throws once then succeeds delivers the digest on
the retry, in the same day. A mailer that always throws does not send twice when
the pass runs twice. Both existing tests — one digest per day, empty digests
claim the day — still pass unchanged.

Owns: `apps/api/src/notify.ts`, `apps/api/src/notify.test.ts`.
Size **M**. Depends: none.

---

## WP-AY · The chart stops contradicting the service

**Goal:** no HPA is rendered for auth, in any values combination.

- `deploy/helm/finance-planner/templates/scaling.yaml:2` ranges over
  `.Values.services` and emits an HPA for each; `values.yaml:78-82` has
  `autoscaling.enabled: true, minReplicas: 2`. `values-prod.yaml:20-21` pins
  `auth.replicas: 1` — a Deployment field an HPA overrides.
- **Decision 33: exclude auth, do not move the rotation state.** A per-service
  opt-out is the shape (`autoscaling: false` on the service entry), so the
  exclusion is visible in `values.yaml` rather than hidden in a template
  condition.
- Say why in the values file, next to the existing note at `values-prod.yaml:17-19`.
- The PodDisruptionBudget at `:28-40` also ranges over every service and sets
  `minAvailable: 1` — on a one-replica auth that blocks voluntary eviction
  entirely. Report what you find; fix it only if it is one line.
- `.github/workflows/ci.yml:93-98` runs `helm lint` and pipes `helm template` to
  `/dev/null`, so it asserts nothing about content. Assert the absence: render
  both values files and grep for an auth HPA.

**Acceptance:** `helm template` with default values and with `values-prod.yaml`
renders HPAs for api, calc and web and **none** for auth. CI fails if one
reappears.

Owns: `deploy/helm/finance-planner/templates/scaling.yaml`,
`deploy/helm/finance-planner/values.yaml`,
`deploy/helm/finance-planner/values-prod.yaml`, `.github/workflows/ci.yml`.
Size **S**. Depends: none.

---

## WP-AZ · The spec that would have caught #42

**Goal:** a client method pointing at a route that no longer exists fails CI.

- This is the durable half of decision 35. `1409e5f` deleted six close routes
  while `apps/web/src/lib/api.ts` still called all six; the account page and the
  household plan page fetched 404s on load and **CI stayed green through it**.
  `BACKLOG.md` calls this its sharpest entry and names the smallest useful
  version: a spec that logs in, opens an account, and opens a household.
- `apps/web/e2e/smoke.spec.ts` is 16 lines and loads the SPA. Extend that suite
  rather than starting a parallel one.
- **Fail the spec on any 4xx or 5xx the page fetches**, not only on missing text.
  That assertion is the entire point — the pages in `1409e5f` rendered.
- Boot the stack the way `ORCHESTRATION.md` says: auth and api in **one**
  process over a shared injected `MemoryStore`, non-default ports, `dist` served
  statically, **every response header forwarded including `getSetCookie()`**.
  Ports 4310–4312, 4410–4412, 4510–4512, 4610–4611, 4620 and 4630–4631 are
  already spent; pick elsewhere. Do the browser pass **first, not last**.

**Acceptance:** the spec logs in, opens the Overview, an account and a household,
and fails on any non-2xx the pages request. Deleting a route the client still
calls turns it red — **demonstrated by actually doing it and reverting**, not
asserted.

Owns: `apps/web/e2e/`, the `e2e` job in `.github/workflows/ci.yml` if it needs a
step.
Size **M**. Depends: WP-AR, WP-AS. **Shares `ci.yml` with WP-AY — runs after it.**

---

## WP-BA · How many requests a real session actually makes

**Goal:** the number exists. Nobody can say whether a rate-limit rule is too
tight without knowing what a legitimate session sends it, and nobody has
counted.

This is decision 34's half of #56. **Measure first, and do not change a line
until the measurement exists** — the fix is worth nothing if the traffic turns
out to be reasonable and the rule is simply wrong.

- **Count it in a browser**, not in jsdom. Playwright's `page.on("request")`
  over the harness `ORCHESTRATION.md` describes; no source change is needed to
  measure. Report, per page: requests on cold load, requests on a warm
  navigation back to it, and the total for a realistic session — Overview →
  Accounts → an account → a household → flow.
- **What the counting will find, to verify rather than assume.** `OverviewPage`
  holds five `useAsync` calls plus a sixth that fans out **per household** to
  `householdPlan` + `listTransferConfirmations`, and it cannot start until `me`
  resolves (`householdKey` at `apps/web/src/pages/OverviewPage.tsx:118-136`) — so
  it is two serial waves, not one. `HouseholdPlanPage` and `HouseholdDetailPage`
  hold seven each, `AccountPage` six, and `AccountMovements` fires five more of
  its own beneath it (`AccountMovements.test.tsx:80-83`).
- **The amplifier, and the most likely cause of a burst.**
  `apps/web/src/lib/api.ts:105` retries once on 401 after `tryRefresh()`. The
  refresh itself is single-flight (`refreshInflight`, `:82`), so a burst of N
  requests against an expired access token produces **one** refresh — but all N
  still retry. Seven requests become fifteen. Confirm the arithmetic against a
  real expired token; if it holds, that is a burst arriving at Cloudflare in one
  window and it happens on **every** page load after an idle spell.
- **`refetchAll` (`OverviewPage.tsx:141-146`) re-fires four, plus two per
  household**, on any quick-add. Check whether anything can trigger it twice.
- Fix only what the numbers justify, and say what you did not fix and why. A
  page that genuinely needs seven reads needs them; **collapsing reads into a new
  aggregate endpoint is not in scope** and would want a plan of its own.

**Acceptance:** a table of per-page and per-session request counts, cold and
warm, measured in a real browser and **posted to issue #56** so the dashboard
rule can be judged against it. The 401-burst multiplier is confirmed or refuted
with a figure. Any change lands with a before/after count, and the e2e spec from
WP-AZ still passes.

Owns: `apps/web/src/lib/api.ts`, `apps/web/src/lib/useAsync.ts`,
`apps/web/src/pages/OverviewPage.tsx`, and a measurement harness in the
**scratchpad, never in the repo**.
Size **M**. Depends: WP-AR (shares `apps/web/src/lib/api.ts`), WP-AZ (its
harness and spec).
**Choke point: `apps/web/src/lib/api.ts` — runs alone.**

---

## WP-BB · An account you cannot see is drawn, not refused

**Goal:** decision 36. A household flow renders for every member, with
accounts the viewer lacks `view` on appearing as an unnamed node carrying its
real amounts.

- `apps/api/src/server.ts:1856` throws `404 Account not found` for any id the
  caller cannot `view`. For a **household** scope that is the wrong answer —
  `/api/households/:id/plan` shows the same member the same money in aggregate,
  by design and by comment.
- **Anonymise, do not omit.** Dropping the account unbalances every total that
  reader can check; the diagram's own `elsewhere` bucket is the precedent for a
  node with money and no name. #43 must stay fixed: an account the viewer **can**
  see is still drawn by name.
- Decide where the anonymising happens — the endpoint knows the ability, the page
  knows the household. **Say why**, and do not let the client be the only thing
  hiding a name it was sent.

**Acceptance:** a member of a household containing an assigned-but-unshared
account opens `/flow?household=…` and sees a diagram whose nodes balance, with
that account unnamed. The same household opened by someone who **can** see the
account draws it by name. Verified **in a real browser** with both viewers.

Owns: `apps/api/src/server.ts` (flow region ~`:1830-1900`),
`apps/api/src/server.test.ts`, `apps/web/src/pages/FlowPage.tsx`,
`apps/web/src/lib/flow.ts` (+ tests). Size **M**. Depends: WP-AP (frees
`server.ts`). **Choke point: `apps/api/src/server.ts`.**

---

## WP-BC · The household plan applies the arrival it records

**Goal:** decision 37. The household plan's `leftoverMinor` and the flow
endpoint's agree to the penny for the same account on the same date.

- **Establish which figure is right before changing either.** The invariant at
  `packages/domain/src/household.ts:271`, `ONE-ENGINE.md` decision 10 and
  decision 13 are the authorities. It is genuinely possible `/api/flow` is the
  wrong one.
- The shape the fixtures avoid: **an authored movement.** Every household
  fixture in the tree feeds its pot by a _derived_ transfer, which is the one
  case this code gets right — which is exactly why it survived.

**Acceptance:** a test that **fails against the parent commit**, demonstrated
not asserted. Chart and table agree **on a real screen**. `pnpm coverage` still
passes — thresholds come from `packages/domain/vitest.config.ts`, and a drop is
fixed with a test, never a lowered threshold.

Owns: `packages/domain/src/household.ts` (+ tests), and the household plan web
view only if the fix needs it. Size **M**. Depends: none.

---

## WP-BD · The projection credits money already saved

**Goal:** decision 38. `projectedBalanceMinor` stops returning a negative
balance for an account that is not overdrawn.

- `packages/domain/src/projection.ts:418` — `sim.balance += setAside - paidOut`
  pays month 1's goals out in full while crediting only that month's set-aside.
  `alreadySavedEndMinor` is 0.
- **The mirror of WP-AT.** Read `RealityStrip.tsx`'s new wording first: WP-AT
  decided how this codebase talks about the gap between money recorded as saved
  and money held. This package must not contradict it.

**Acceptance:** Ben's account projects a balance a person would recognise, and a
test pins the figure. Verified **in a real browser** — this defect was found on
a chart, and the unit tests passed throughout.

Owns: `packages/domain/src/projection.ts` (+ tests). Size **M**. Depends: none —
but **not started without Ben's sign-off**; it is scope this plan did not carry.

---

## Waves

| Wave | Packages                                      | Notes                                                                                                    |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | WP-AN                                         | **alone** — nothing can flip a pin that does not exist yet                                               |
| 2    | WP-AS + WP-AT + WP-AU + WP-AW + WP-AX + WP-AY | six-way disjoint: web/flow · web/RealityStrip · one web test file · auth · api/notify · helm             |
| 3    | WP-AO + WP-BC                                 | AO **alone** on `apps/api/src/server.ts`; BC entirely inside `packages/domain` — disjoint                |
| 4    | WP-AP + WP-BD                                 | AP owns `server.ts` **and** `packages/contracts` **and** all four data files; BD is `projection.ts` only |
| 5    | WP-AV + WP-AR + WP-BB                         | portability+contracts · web account page+`lib/api.ts` · `server.ts` flow region+`lib/flow.ts`            |
| 6    | WP-AZ                                         | alone; needs AR and AS on screen, and AY's `ci.yml` edit already in                                      |
| 7    | WP-BA                                         | **alone** — owns `apps/web/src/lib/api.ts`, and needs AZ's harness to measure with                       |

Waves 1 and 2 have landed — `main` at `97e6a19`, five pins written and the two
web ones already flipped. Waves 3–5 changed shape when decisions 36–38 were
added mid-flight; the choke-point rule did not. `apps/api/src/server.ts` still
has exactly one owner per wave: **AO in 3, AP in 4, BB in 5.**
`packages/domain` is a second, softer choke point, because its coverage gate
measures the whole package — so **BC and BD are deliberately one wave apart**,
and neither is measuring the other's diff.

**Choke-point files, never co-owned:** `apps/api/src/server.ts` (2657 lines,
wanted by four issues), `packages/contracts/src/index.ts`,
`apps/web/src/lib/api.ts`, `apps/web/src/styles.css`,
`.github/workflows/ci.yml`. A package owning one runs alone in its wave; the
Notes column says so, and that is not to be re-parallelised later.

Checked against the `Owns` lists rather than the shape: wave 2's six sets are
`apps/web/src/{pages/FlowPage,lib/flow,components/HouseholdSankey}` ·
`apps/web/src/components/RealityStrip` ·
`apps/web/src/components/AccountMovements.test` · `apps/auth/src/server` ·
`apps/api/src/notify` · `deploy/helm/**` + `ci.yml`. No file appears twice.
Wave 5's two are `apps/api/src/portability*` + `packages/contracts` +
`BACKLOG.md` against `apps/web/src/{pages/AccountPage,lib/api}` — disjoint.
Waves 1, 3, 4, 6 and 7 are single packages, so there is nothing to check.

**Note `apps/web/src/lib/api.ts` is claimed twice** — by WP-AR in wave 5 and
WP-BA in wave 7. Two waves apart, so it holds; do not move either package
without re-checking that.

**Seven waves.** Waves 3 and 4 are single packages on one large file and are the
long pole; everything cheap is deliberately front-loaded into wave 2 so the
board shortens early. WP-BA is last because it is the only package that needs
another one's harness to do its own job.

---

## The regression to fear

**What must provably not move:** the solo single-account case. Nothing in this
plan is about a lone user with one account, and every figure on that path must
be identical before and after. `packages/domain/src/estate.fixture.ts` and its
`ESTATE_CONFIRMATION_SHAPES` exist because a fixture went stale silently once;
if a package changes what path that fixture takes, the shapes assertion is
supposed to catch it and the fix is the code, not the assertion.

**What will move, and is meant to:** a co-editor on a shared destination account
loses the ability to un-confirm somebody else's movement (decision 28). An import
file that used to restore now refuses (decision 29). A household above
`MAX_FLOW_ACCOUNTS` changes behaviour (WP-AS). Those three are the only intended
user-visible losses; anything else that moves is a defect.

**What shape the fixtures avoid.** Every fixture in this repository plans
**today**, in a household of two, with distinct account names and round numbers.
This plan's live defects are all in the gaps that leaves:

- **A past month.** #50 is precisely about a month that is not now, and there is
  no fixture whose plan differs between two months. WP-AN's `confirm-month` pin
  **must build one** — a payment that started, or an amount that changed, so that
  today's plan and the target month's plan give different answers. A pin whose
  two months agree proves nothing and will pass on the broken code.
- **Two accounts with the same name.** Nothing in the tree has them; #52 is
  invisible without them. WP-AV builds the awkward file.
- **A stale balance check-in.** `latest.asOfDate` is printed but no fixture ages
  it. WP-AT decides what the banner does with a three-week-old balance.
- **A failing mailer.** Every notify test has a mailer that works. WP-AX builds
  one that throws once.
- **An expired access token.** Every test and every fixture starts with a fresh
  one, so nothing in the tree has ever exercised the 401-retry path at
  `apps/web/src/lib/api.ts:105` under a burst — which is exactly the shape #56
  reports. WP-BA measures it with a real expired token, in a real browser.

Ben's £222.94 and the `elsewhere` ribbons were both found on a real screen in
seconds, and neither had a failing test. That is this project's pattern and it
has not changed.

**The standing instruction, which finds more than any audit: hunt for the
assumption rather than assuming its absence, and name the assumption.** For this
plan the assumption is stated once and every package should test it against its
own files:

> **that writing a record and the event it records are the same fact.**

Where you find another place holding it — a claim read back as an event, a
registration read back as an application, a wait read back as an arrival — say
so, whether or not it is in your package.

**At every wave boundary, re-open the findings dismissed in the last one.** A
dismissal is dated evidence about a past tree, never a settled fact about the
current one. One of the fifteen issues this plan started from was already false
when read against `main`, one `BACKLOG.md` entry with it, and two issues had
drifted line numbers. The same will be true of findings inside this plan.

A second lesson from writing it, worth carrying: **#56 was nearly dropped as
"out of scope, no repository footprint", and that was wrong.** The rule lives in
a dashboard, but the traffic it fires on is ours and had never been counted. An
issue whose fix is somewhere else is not an issue whose _cause_ is somewhere
else — check which one you have before closing anything.
