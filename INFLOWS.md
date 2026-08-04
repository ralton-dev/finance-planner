# Implementation plan — inflows as a first-class primitive

Agreed 2026-08-04, after WP-A landed and while WP-B was in flight. Written to be
picked up cold; read it in full before starting. Conventions and the definition of
done are inherited from [`REDESIGN.md`](./REDESIGN.md) — integer minor units,
explicit `asOfDate`, Store parity (Memory + Pg + contract test) for data changes,
plain CSS through design tokens, no new dependencies, stage only owned paths, never
`git add -A`.

**This supersedes [`HOUSEHOLD-CONTEXT.md`](./HOUSEHOLD-CONTEXT.md).** That plan is not
wrong — it is too narrow. Everything it built stays. What changes is the _boundary_
it assumed.

---

## The reframing

`HOUSEHOLD-CONTEXT.md` treats the household as the thing that funds an account. That
is one case of a general truth, mistaken for the whole.

**The unit of planning is the user, not the account and not the household.** The plan
is computed over the entire set of accounts a person owns, as one system. Money enters
that system from outside, is committed to obligations, and moves _between_ accounts
internally. An account is a **location** money sits in — a constraint on where an
obligation can be paid from — not a self-contained planning universe.

Two consequences, both load-bearing:

1. **`computePlanForAccount` treating an account as closed is a view, not the
   calculation.** No account is closed.
2. **Household is an attribution layer, not a calculation boundary.** It answers _whose
   money is this, who bears this cost, how does a shared cost split_ — never _may this
   account participate in the plan_. Today household membership gates participation,
   which is why a standalone savings pot is invisible to the planner. That is the bug
   behind this work.

"Not in a household" must mean "no sharing rules apply", never "excluded from the plan".

## The shape being built

An **inflow** becomes a first-class record you create on an account, symmetric with an
expense. It has a source:

- **`external`** — salary, gift, interest. This is what `core.incomes` already is.
- **`account`** — another account the same user owns. This is _you moving your own
  money_, not income.

An account-sourced inflow is one record with two faces. On the receiving account it
reads as money arriving; on the sending account it reads as money leaving. Same row,
opposite columns — ordinary double entry. It is **not** two independently-authored
records that can drift.

Account-sourced inflows enter the engine with their own **priority**, with one rule:
they are always funded **after** every expense on the sending account. A pot can never
starve a real bill.

## The invariant that must be asserted, not assumed

At the whole-machine level, moving money between two accounts you own **nets to zero**.
It is income-shaped and expense-shaped only from each account's _local_ view.

> **Total money in comes only from `source: external`.** Everything else is
> redistribution of money already counted.

Get this wrong and the machine inflates income by every internal movement — and a chain
(current → pot → ISA) inflates it repeatedly. This looks correct on a single-account
fixture and lies at scale. `HOUSEHOLD-CONTEXT.md` decision 3 and its double-count guard
were an instance of this invariant; generalise them rather than re-deriving them.

## Decisions already taken (do not relitigate)

Carried forward from `HOUSEHOLD-CONTEXT.md` and still binding:

1. Planned-but-unconfirmed movements count as funded for the arithmetic, but carry a
   distinct status so the contingency is visible.
2. The fix lives in the plan itself, never in presentation. Two sources of truth is the
   defect class being avoided.
3. Own income and arriving inflow stay separate fields. Never fold inflow into
   `monthlyIncomeMinor`.
4. `onTrack` keeps its meaning ("the plan covers it"). New axes are added alongside.

New, and equally binding:

5. **`incomes` becomes `inflows(source: external)`.** Not a parallel concept — a
   unification. An inflow from an account you own is not income.
6. **Account-sourced inflows always rank after expenses** on the sending account. This
   is deliberate and is not to be "improved" into free interleaving without asking.
7. **Household stops being the source of inflow.** It becomes one _producer_ among
   several. The household allocation path built in WP-B is kept and generalised, not
   deleted.

## What in-flight work to keep

- **WP-A (landed, `bb1ad6f`) — keep entirely.** `AllocatedInflow`, the
  allocated/confirmed split, `awaiting_transfer`, and the own-vs-inflow funding split
  are all boundary-agnostic. They are exactly the right primitive; only their _producer_
  was household-shaped.
- **WP-B (in flight) — let it finish, then generalise.** Its central insight is correct
  and worth keeping: `buildAccountInput` / `loadAccountInputs` is the choke point, and
  inflow must be supplied there once rather than at each call site. WP-F below widens the
  producer from "the household allocated this" to "an authored inflow says this". Do not
  stop WP-B mid-flight to rewrite it; a coherent finished state is a better base than a
  half-built one.
- **WP-C, WP-D, WP-E — still valid, wider than written.** Read every occurrence of
  "household-funded account" in them as "account receiving inflow". Their acceptance
  criteria hold; their scope grows.

---

## Migration constraints — read before writing any SQL

`HOUSEHOLD-CONTEXT.md` said no schema change was expected and to stop and report if one
proved necessary. **This work does require schema changes**, so that instruction is
lifted — but these rules are absolute, because of how migrations are deployed:

The cluster applies migrations through an ArgoCD PreSync Job that runs
**every `.sql` file, in lexical order, on every single sync**, under
`psql -v ON_ERROR_STOP=1` with `set -e`.

Therefore:

- **Every statement must be idempotent.** `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`. One
  bare `CREATE` succeeds on first run and then **wedges every future deploy**.
- **`ALTER TABLE ... RENAME TO` is not idempotent** and will break the second sync. If
  `incomes` → `inflows` is done as a rename, it must be guarded, e.g. inside a
  `DO $$ BEGIN IF EXISTS (SELECT FROM information_schema.tables WHERE ...) THEN ... END
IF; END $$;` block. Prefer create-new + backfill + leave the old table in place over a
  bare rename; dropping the old table is a separate, later, deliberate migration.
- **No `DROP` / `DELETE` / `TRUNCATE`** in this work. Additive only.
- Migrations are mirrored by hand into the deploy repo, so keep them self-contained and
  readable; do not depend on application code having run first.

Number the new migration `0008_` and upward.

---

## WP-F · Inflows as authored records

**Goal:** an inflow is a thing the user creates on an account, with a source, replacing
income as the sole way money arrives.

- Schema: `inflows` carrying at minimum the owning `account_id`, a `source` discriminator
  (`external` | `account`), a nullable `source_account_id` (required when
  `source = 'account'`, null otherwise — enforce with a `CHECK`), amount, recurrence, and
  a `priority` meaningful only for `source = 'account'`.
- Backfill every existing `core.incomes` row as `inflows(source: 'external')`. Reads move
  to `inflows`; the old table stays in place untouched for now.
- A `source = 'account'` row is authored once and read from both sides: arriving on
  `account_id`, leaving on `source_account_id`.
- A self-referencing inflow (`source_account_id = account_id`) is invalid — reject it.

**Acceptance:** an account with only external inflows plans byte-identically to the same
account with the equivalent `incomes` today (pin it); an account-sourced inflow appears on
both accounts with opposite signs; the estate-wide sum of money in is unchanged by adding
any number of account-sourced inflows (**the invariant — assert it directly**); the
`CHECK` rejects a source-less account inflow and a self-reference.

Owns: `db/migrations/0008_*.sql`, the Store interfaces + Memory/Pg implementations +
contract test, `packages/domain/src/types.ts`. Size **L**. Depends: WP-B.
**Coverage gate applies.**

## WP-G · The estate graph

**Goal:** plans stop being per-account computations and become one ordered pass over the
accounts a user owns.

- An account's funding may now depend on another account's surplus, so plans must be
  computed in dependency order rather than independently.
- **Cycles must be detected and reported, not deadlocked or silently truncated.**
  A → B → C → A is a user error the UI has to be able to explain. Decide the behaviour
  (reject at authoring time, or detect at compute time and surface) and document it.
- Sending-account ordering: fund all expenses first, then account-sourced inflows in
  their own priority order, from whatever remains. Decision 6 — do not interleave.
- Revisit "there is no circularity" in `HOUSEHOLD-CONTEXT.md`. That claim held when
  funding flowed only from a household downward. It does not hold for a general graph;
  requirements still do not depend on income, but _funding order_ now does.

**Acceptance:** a three-account chain funds correctly in one pass; a cycle is reported
with the accounts involved rather than hanging or stack-overflowing; a single standalone
account is unchanged; the sending account's expenses are all funded before any outbound
inflow is, even when the inflow has the higher priority number.

Owns: `packages/domain/` plan orchestration + tests, `apps/api/src/plan.ts`.
Size **L**. Depends: WP-F. **Coverage gate applies.**

## WP-H · Standalone confirmations

**Goal:** "I moved the money" works without a household.

`core.transfer_confirmations.household_id` is `NOT NULL`, which makes a standalone
movement impossible to confirm — the single constraint that blocks the whole standalone
case today.

- Relax it so a confirmation may be scoped to an account-sourced inflow with no household,
  mirroring how `core.month_closes` already handles exactly this with
  `CHECK ((household_id IS NULL) <> (account_id IS NULL))`. Follow that precedent.
- Dropping `NOT NULL` is idempotent-safe (`ALTER COLUMN ... DROP NOT NULL` can be re-run),
  but confirm the unique constraint still behaves with nulls — `UNIQUE (household_id,
month, from_account_id, to_account_id, member_user_id)` treats nulls as distinct in
  Postgres, which would permit duplicate standalone confirmations. Fix that deliberately
  with a partial unique index.

**Acceptance:** a standalone pot's inflow can be confirmed and un-confirmed; the
contribution rows it implies are cleaned up on un-confirm as they are today; duplicate
standalone confirmations for the same month are rejected; existing household confirmations
are untouched.

Owns: `db/migrations/0009_*.sql`, confirmation Store paths + tests,
`apps/api/src/server.ts`. Size **M**. Depends: WP-F.

## WP-I · Diagrams over any scope

**Goal:** the transfer/Sankey view stops being a household feature.

Today the flow diagram and related graphics are reachable only inside a household, so the
most interesting pictures — where money actually goes across everything you own — cannot
be drawn.

- Diagram scope becomes a **user-defined set of accounts**, not a household. A household
  is one convenient preset, not the mechanism.
- Accounts must be **excludable** from a given diagram. A noisy or irrelevant account
  should be hidable without deleting it or removing it from the plan — visibility is a
  presentation concern and must not alter any computed figure.
- Scope should be nameable and re-openable rather than reconstructed by hand each visit.
- The underlying flow data already exists: `household.ts` derives transfers as
  "funded obligations that cross account boundaries" and calls it the Sankey input.
  Generalise that derivation to an arbitrary account set; do not write a second one.

**Acceptance:** a diagram renders for a set spanning two households plus a standalone pot;
hiding an account changes only the picture and provably not any plan figure (assert a plan
snapshot is identical either side of a visibility toggle); a household preset reproduces
today's diagram exactly.

Owns: the flow-derivation module + tests, the diagram components + tests, whatever store
holds saved scopes. Size **M–L**. Depends: WP-G.

---

## Waves

| Wave | Packages         | Notes                                                              |
| ---- | ---------------- | ------------------------------------------------------------------ |
| 0    | WP-B             | already in flight — let it land unchanged                          |
| 1    | WP-F             | schema + store; everything downstream reads these types            |
| 2    | WP-G + WP-H      | disjoint (domain orchestration vs confirmation store)              |
| 3    | WP-C, WP-D, WP-E | as written, re-read with "receiving inflow" for "household-funded" |
| 4    | WP-I             | needs the general graph from WP-G to draw anything wider           |

Two agents may only run concurrently on disjoint file sets. Never two agents on
`apps/web/src/styles.css` or `apps/web/src/lib/api.ts` at once.

## The regression to fear

`HOUSEHOLD-CONTEXT.md` warned that the engine assumes an account's budget comes from its
own income, and to hunt that assumption rather than assume it absent. That warning now
applies **one level up**: the codebase assumes the household is the only cross-account
context. Every place that reaches for a household to answer a question about _money
movement_ — rather than about _attribution_ — is a place this reframing breaks.

Hunt for it. `household_id NOT NULL` on `transfer_confirmations` is the one already found;
treat it as evidence of a pattern, not as the only instance.
