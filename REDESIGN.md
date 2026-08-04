# Redesign implementation plan — "C in B's skin"

Direction locked 2026-08-04: **"Do the next thing" structure in the "Daylight ledger" skin**,
dark kept first-class, light becoming the default at the end. Visual specs live in the
design-directions artifact (sections 03-B, 03-C, 03½a/b/c); findings referenced as `#1`–`#11`
are its numbered critique. This file is the build plan: each work package (WP) is sized for
one agent, owns an explicit file set, and states its acceptance criteria. Do not start a WP
whose dependencies haven't merged.

**Global definition of done (every WP):**

- `pnpm -w typecheck`, `pnpm lint`, `pnpm test` green; engine coverage gate holds when
  `packages/domain` is touched.
- No new dependencies without explicit approval.
- Stage only owned paths (never `git add -A`); one or two commits per WP; CI green on main
  before a dependent WP starts.
- Match the repo's conventions: minor units, explicit `asOfDate`, Store parity
  (Memory + Pg + contract test) for any data change, plain CSS through design tokens.

**Parallelism rule:** WPs in the same wave own disjoint files and may run concurrently.
Never run two WPs that both touch `apps/web/src/styles.css` or `apps/web/src/lib/api.ts`
at the same time.

---

## WP-0 · Verify the reload-logout bug — GATE, do first when Docker is available

Hard-reload an authenticated route against the compose stack (`make up`, log in, F5 on
`/accounts/:id`). During screenshot capture the silent refresh (`fp_refresh` cookie) did not
restore the session through the `5173 → 4000` dev proxy.

- Reproduces on compose → it is a session bug; fix jumps ahead of all visual work
  (suspects: cookie `Path`/`SameSite` vs the gateway prefix, `COOKIE_PATH` env, the
  auth-service cookie options vs proxied path rewriting).
- Dev-proxy-only → add a note to README's dev section and move on.
  Size S (verify) / M (fix). Owns: nothing until diagnosed.

## WP-1 · Token refactor + dual theme plumbing — FOUNDATION, runs alone

**Goal:** one token set drives both themes; zero visual change in dark.
Spec: artifact 04 ("tokens first"), finding #11.

- `apps/web/src/styles.css`: fold the 23 `rgba()` literals and the stray `#ff8e7d`
  (line 759) into `:root` custom properties with semantic names — surfaces
  (`--ground/--panel/--rule/--shade`), inks (`--ink/--ink-2/--ink-3`), semantics
  (`--funded`, `--needs-you`, `--alert`, `--derived`), member accents. Alpha washes become
  `color-mix(in srgb, var(--token) N%, transparent)` so light doesn't need a second set.
- Add the light palette from the artifact's B mockup (`#FCFCFA` ground family, filled-chip
  tints that survive on white) under `:root[data-theme="light"]`; system preference via
  `@media (prefers-color-scheme: light)` with the explicit attribute winning both ways.
  **Dark stays the default this WP** — light is reachable only via the toggle.
- Theme toggle in `Layout` (next to the privacy toggle; persist as `fp.theme`:
  `dark | light | system`; stamp `data-theme` on `<html>`). Mirror `PrivacyContext`
  as `ThemeContext`.
- Charts: recharts colors are JS-side hex today. Add `apps/web/src/lib/chartColors.ts` —
  reads resolved CSS custom properties (`getComputedStyle(document.documentElement)`),
  re-resolves on theme change via `ThemeContext`; migrate `HouseholdSankey`,
  `ProjectionChart`, `NetWorthChart`, `TagTreemap` to it. No hex literals left in
  components (enforce with a test that greps the component sources).
- Acceptance: dark renders **pixel-identical** (capture-compare Overview + account page
  before/after with the scratchpad capture script), light is complete (no unstyled
  surface, chips legible, charts recolored), toggle + persistence tested.

Owns: `apps/web/src/styles.css`, `apps/web/src/contexts/ThemeContext.tsx` (new),
`apps/web/src/lib/chartColors.ts` (new), chart components (color plumbing only),
`Layout.tsx` (toggle only), tests. Size **M**. Depends: none.

## WP-2 · The "needs you" selector — pure lib, parallel-safe with WP-1

**Goal:** one tested function that turns existing plan data into the checklist.
Spec: artifact 03-C + 03½b; findings #3, #9, #10.

- `apps/web/src/lib/needsYou.ts`:
  `deriveNeedsYou(input) → NeedsYouItem[]` where input carries: household plans
  (+ paydaySchedule + this-month confirmations), account plans (with `contributionsMTD`,
  `latestBalance`, `reservedMinor`), balances staleness threshold (default 10 days),
  upcoming items. Item kinds, in fixed priority order:
  1. `shortfall` — any member/account shortfall > 0 (label names the member + tag group,
     amount = shortfall; meta suggests the two remedies as in the mockup).
  2. `transfer` — planned transfer without a confirmation this month (member, from → to,
     amount, "1 of N done" meta).
  3. `record` — save-up line (non-`monthly_recurring`) with funded > 0 this month and no
     MTD contribution covering it (amount = fundedMonthly).
  4. `checkin` — account whose latest balance is older than the threshold (meta: days +
     next due payment on that account if within 14d).
     Each item: `{kind, label, amountMinor?, meta, href, action?}` where `action` is a typed
     descriptor (`confirmTransfer{...}`, `recordContribution{...}`, `checkin{accountId}`)
     the UI maps to existing endpoints. Deterministic ordering + stable keys.
- Headline math: `deriveHeadline(...)` → `{kind: "shortfall"|"leftover", amountMinor,
sentence}` exactly as the mockups word it (shortfall wins whenever > 0).
- Acceptance: unit tests per rule, ordering, thresholds, empty-state ("nothing outstanding"),
  and the headline sentence for both states.

Owns: `apps/web/src/lib/needsYou.ts` + test. Size **S–M**. Depends: none (types only).

## WP-3 · Plan-page top fold

**Goal:** headline + actionable checklist above the existing sections; nothing deleted yet.
Spec: artifact 03-C; findings #3, #9, #10.

- New `components/Fold.tsx`: headline (red shortfall / green left-over, artifact type
  scale) + `NeedsYouList` rendering WP-2 items with working actions: `transfer` →
  existing confirm endpoint (with undo state), `record` → contribution POST prefilled,
  `checkin` → inline balance input (reuse RealityStrip's control), `shortfall` → link to
  household detail. Optimistic tick + refetch; errors inline by `error.code`.
- Mount at the top of `HouseholdPlanPage` (above the stat row). The stat row's SHORTFALL
  cell now mirrors the headline when > 0 (kills the #10 contradiction).
- Acceptance: component tests (all four kinds actioned, error paths), page test that the
  fold precedes all sections, stat-row consistency test.

Owns: `components/Fold.tsx` + test, `pages/HouseholdPlanPage.tsx`,
`components/MonthScorecard.tsx` only if the close button relocates into the fold meta
(optional, keep if trivial). Size **M**. Depends: WP-1 (tokens), WP-2.

## WP-4 · Accounts index → state table (+ overview API enrichment)

**Goal:** the index answers "which account needs me today". Spec: 03-A/B tables; #1, #2.

- API (`apps/api/src/server.ts`, overview handler only): it already computes full plans;
  enrich each account summary with `latestBalanceMinor`, `latestBalanceDate`,
  `reservedMinor`, `leftoverMinor` (already there), `unrecordedCount`,
  `unrecordedTotalMinor` (funded save-up lines minus MTD contributions). No domain change.
  Extend `server.test.ts`.
- Web `pages/AccountsPage.tsx`: columns → account (member dot + sub-line: ownership
  phrase + salary/shared note) · balance (+ "checked in N d ago" sub, dash + hint when
  never) · left over / mo · attention (chips: `record N · £X` amber, `unfunded £X` red,
  `stale N d` flat; `funded` green only when nothing else). Access chips die — ownership
  becomes the plain phrase (`owner` / `shared with you · can edit`). Row count stated
  once. Whole row is a link with a visible affordance.
- Acceptance: API test for the new fields; component tests for chip logic (each state),
  phrase rendering, and the "two headline numbers" bug being gone (index balance ===
  detail-strip balance source).

Owns: `apps/api/src/server.ts` + test (overview handler section), `pages/AccountsPage.tsx`

- test, `lib/types.ts` (overview DTO fields). Size **M**. Depends: WP-1.
  Parallel-safe with WP-3 (disjoint files) — but WP-3 and WP-4 must not both edit
  `lib/api.ts`; WP-4 needs no `api.ts` change (overview method exists), so declare it frozen.

## WP-5 · Household detail — one table, consequential shares, demoted danger zone

**Goal:** artifact 03½a, verbatim. Findings #7, #8.

- Merge `shared accounts` + `plan accounts` into one table: account (+ dot + sub) ·
  role in plan (chip `shared pot` / `personal · <name>`) · your access (plain phrase) ·
  balance (from accounts data already on the page; add balances fetch if absent).
  Role edits keep the existing PUT (assignment) flow via a row action; access management
  keeps the existing share endpoints behind a row menu — merged table, same operations.
- Shares block: inputs + live consequence line ("splits shared costs 60.0/40.0 … lands as
  Ben £X and Alex £Y into <pot>") computed from the household plan (fetch it here; the
  page currently doesn't) + explicit `save shares` + "✓ saved — plan, transfers and the
  money flow recalculated" confirmation + normalisation note.
- Danger zone → collapsed `<details>` at the very bottom, shaded, with the type-to-confirm
  copy from the mockup.
- Acceptance: tests for the merged table (both chip vocabularies gone), consequence-line
  math (uses plan totals, updates after save), save confirmation state, danger zone
  collapsed by default.

Owns: `pages/HouseholdDetailPage.tsx` + test, `lib/api.ts` (only if a fetch helper is
missing — coordinate: WP-5 is the sole `api.ts` owner in its wave). Size **M**.
Depends: WP-1. Parallel-safe with WP-7.

## WP-6 · Overview de-duplication

**Goal:** fold + doorways; the plan lives on the plan page. Spec 03½b; #9 (dup), #11 (context).

- Commit 1 (additive): mount `Fold` (WP-3, cross-household aggregate — extend WP-2 input
  to merge multiple households + standalone accounts into one item list; headline
  aggregates worst-first) at the top; add household **link cards** (name, members/accounts
  meta, `£X in · £Y required`, state chips, `full plan →`); standalone-accounts table
  reuses WP-4's state columns for non-household accounts only; net worth becomes the
  sentence + current figure with the chart behind a `<details>` disclosure.
- Commit 2 (subtractive): remove the inline `HouseholdPlanView` + duplicated Sankey/tables
  from Overview (component stays — the plan page uses it). UpcomingDigest merges into the
  fold's list (its rows become `record`/dueDate metas) or renders directly beneath it —
  agent's call, document it.
- Acceptance: no Sankey on Overview; card links correct; aggregate headline tested for
  two-household case; net-worth sentence math (cash vs reserved) tested; nothing on the
  page fetches the full household plan lines anymore except the fold's derivation.

Owns: `pages/OverviewPage.tsx` + test, `components/UpcomingDigest.tsx` (merge/retire),
`lib/needsYou.ts` (aggregate extension + tests). Size **M–L**.
Depends: WP-2, WP-3, WP-4 (state columns).

## WP-7 · Account detail — bar list, grid key, derived-date class

**Goal:** artifact 03½c. Findings #3, #4, #5, #6.

- `PlanTable`: TYPE distinguishes `goal · dated` vs `goal · paced`; DUE renders derived
  dates as `~YYYY-MM-DD` in the muted-italic `--derived` style (a date is derived when
  the payment is `fixed_point` with `fixedMonthlyMinor` set and no user `dueDate`);
  monthly rows show `due in N d` in THIS MONTH (data from plan lines' dueDate).
- Replace `TagTreemap` usage on both pages with `TagBarList` (new): ranked rows, single
  accent on the largest, greys descending, `tag · £X/mo · %`; delete the treemap component
  - its tests once both pages migrate. Keep the `groupByTag` lib.
- `ProjectionView`: key line under the grid (`• falls due that month · [swatch] tinted
cell = due month · ~ derived date`), due tint switched to the token that reads on light.
- Acceptance: PlanTable tests for both goal labels + tilde; bar list ordering/accent
  tests; key renders; no `TagTreemap` references remain.

Owns: `components/PlanTable.tsx`, `components/TagBarList.tsx` (new),
`components/TagTreemap.tsx` (delete), `components/ProjectionView.tsx`,
`pages/AccountPage.tsx` + `pages/HouseholdPlanPage.tsx` (treemap swap lines only —
coordinate with WP-3/WP-6 ordering so the page files aren't co-edited; run WP-7 in a
wave where neither is active or scope the swap to a follow-up commit). Size **M**.
Depends: WP-1.

## WP-8 · Flip the default + contrast pass — LAST

- Default theme becomes light for users with no stored preference; dark remains one click
  away and privacy mode unchanged.
- Contrast pass on light across every chart (Sankey link palette, gridline luminance vs
  axis labels — #11), chips, focus rings; fix what the pass finds.
- Regenerate the screenshot set (scratchpad capture script) in both themes; attach to the
  commit message or drop in `docs/` if we want them versioned.
- e2e smoke + full suite; update README feature tour (theme paragraph) + BACKLOG (retire
  the redesign entries this plan completes).

Owns: `styles.css` (default block), README/BACKLOG lines, chart color values. Size **S–M**.
Depends: WP-1…WP-7 merged.

---

## Suggested waves

| Wave | Packages    | Notes                                                              |
| ---- | ----------- | ------------------------------------------------------------------ |
| 0    | WP-0        | whenever Docker is available; result may reprioritise              |
| 1    | WP-1 + WP-2 | disjoint (styles/charts vs one new lib file)                       |
| 2    | WP-3 + WP-4 | plan page vs accounts+api; `api.ts` frozen                         |
| 3    | WP-5 + WP-7 | household detail vs plan-table/charts; see WP-7's page-file caveat |
| 4    | WP-6        | needs 2, 3, 4                                                      |
| 5    | WP-8        | flip + polish                                                      |

Rough total: 2 waves of M work in parallel per wave — comparable to one overnight run.
