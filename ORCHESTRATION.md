# Running a plan with parallel agents

How the `INFLOWS` / `ONE-ENGINE` / `MONTH-CLOSE` work was executed, written down so the
next orchestrator does not rediscover it. Everything here was learnt by getting it
wrong first.

The shape: a plan document defines work packages with owned file lists, acceptance
criteria and a wave table. One agent per package. Packages in a wave run concurrently
**only** on disjoint file sets. The orchestrator briefs, verifies, pushes and watches
CI at every wave boundary — and writes no implementation code itself.

---

## The verification gate

Run **all of these** before pushing. The last two are fatal CI jobs and were missing
from the gate for a whole day, during which `main` was red for six consecutive pushes
while being reported green:

```
pnpm -w typecheck && pnpm lint && pnpm build && pnpm exec prettier --check . && pnpm test
```

Plus `pnpm coverage` when `packages/domain` is touched (floor: **99.87% statements /
95.84% branches** — do not ratchet down), and
`pnpm --filter @finance-planner/data test:int` when a migration is added.

`prettier --check` is repo-wide and fatal. A stray untracked file breaks it.

## Reading CI, correctly

`gh run watch --exit-status` exits **0 when the run has already completed**, whatever
its conclusion. `gh run list --limit 1` returns the most recently _created_ run, which
is often CodeQL rather than CI. Both mistakes were made; both hid red builds.

Verify by run id, and read the conclusion:

```
gh run view <id> --json status,conclusion --jq '"\(.status) \(.conclusion)"'
gh run view <id> --json jobs --jq '.jobs[] | select(.conclusion=="failure" or .conclusion=="cancelled") | .name'
```

An **empty** conclusion means still running, not failed. A `cancelled` run usually
means a later push superseded it — check whether `build-test` passed before the cancel
rather than assuming either way.

CI runs `e2e`, `integration` and `stack-smoke`, which the local gate does not. Wait for
green before starting a wave that builds on the last one. Note `e2e` is a single
16-line smoke test: it once stayed green through a commit where two pages threw 404s.
**CI green does not mean the app works.**

## The watchdog

Agents are killed after **600 seconds without output**. More than ten died this way,
every one running something long and silent at the _end_ of a package — repeated test
suites, a browser harness, a step-by-step gate.

Put in every brief:

- emit a line of output between every step;
- never run the full suite more than twice in a row;
- **commit before any long final verification**;
- if a browser pass is needed, **do it first, not last**.

A killed agent loses nothing. Resume it with `SendMessage` — it picks up from its
transcript with context intact. Trim its scope to "commit what you have and report";
re-entering the thing that killed it kills it again.

## Freezes

Declare frozen files in **both** directions — each concurrent agent must know what the
other owns. A one-directional freeze let an agent find files changing under it, run
`git stash` to investigate, and come within a whisker of destroying another agent's
uncommitted work.

Every brief gets: **never run `git stash`, `git checkout --`, `git restore`, or
`git add -A`.** Stage owned paths explicitly, by name.

Expect to see the other agent's failures in a whole-repo run. Tell agents to check
whether a failure is theirs before reacting to it.

## Booting the app

In DB-less dev mode the api and auth services each create **private** `MemoryStore`s,
so household routes 404 across processes. Boot both in **one** process sharing an
injected store:

- auth `buildServer({ store, env, rateLimit: false })` on a scratch port;
- api `buildServer({ store, env: { ...authUrl: "http://127.0.0.1:<authPort>" } })` with
  `registerAuthProxy` left **on**.

Use **non-default ports** (not 5173 / 4000 / 8080). Build `dist` and serve it
statically — Vite's proxy is hardcoded. **Forward every response header including
`getSetCookie()`**: a harness that dropped `set-cookie` silently 401'd every navigation
and cost an agent its whole browser pass.

## The scratchpad

Session scratchpads are **shared across sessions**. Useful — one agent reused another's
boot script and saved twenty minutes — but two hazards:

- **ports**, when agents boot concurrently. Tell each which are already in use.
- **stale harnesses** written against an API shape that has since changed. An agent
  investigating through one is investigating a fiction.

Prefix files per package. **Never write scratch work into the repo**: one agent left a
probe file that broke workspace typecheck for the agent beside it.

## Migrations

The cluster applies **every** `.sql` file in lexical order **on every sync** under
`psql -v ON_ERROR_STOP=1` with `set -e`. Therefore:

- every statement idempotent — `IF NOT EXISTS`, `CREATE OR REPLACE`, guarded `DO $$`
  for anything without an `IF NOT EXISTS` form (`ADD CONSTRAINT` has none);
- **additive only**; no `DROP` / `DELETE` / `TRUNCATE` except by a sanctioned exception
  named in a plan and granted by Ben;
- mirrored **byte-identically** into `deploy/helm/finance-planner/files/` — verify with
  `cmp`, and say you did. A migration that exists only in `db/migrations/` never runs;
- proven to apply **twice in a row** against a database carrying every earlier
  migration. This is the gate that matters most.

Two traps found the hard way:

- **A constraint or unique index is validated against existing rows; a trigger is not.**
  Where a rule cannot be proven true of data already in the database, use a trigger — it
  constrains the next write without risking a failed apply that would wedge every future
  deploy. `0011` and `0012` do this.
- **Dropping a constraint is not enough if an earlier migration re-adds it by name.**
  `0009` guards `transfer_confirmation_scope` by name, so `0010` had to re-add under the
  same name or every later sync would have re-added the old predicate, validated it
  against rows that now violate it, and killed the deploy. Check whether the earlier file
  guards by name or by `CREATE TABLE IF NOT EXISTS` — the answer decides the shape.

**Sanctioned `DROP CONSTRAINT` exceptions granted so far: `0010` and `0013`.** A third
needs asking.

## What agents are good at, and where they need pushing

They are reliable and they will tell you when a brief is wrong. **More than twenty
corrected a brief across this work and every one was right**, including catches that
prevented a migration wedging every future deploy and a field that would have changed
nothing on its own. Write briefs that invite it: _"if a premise here is wrong, say so
and serve its intent, not its letter."_

Ask every package to **hunt for the assumption rather than assuming its absence**, and
name the assumption. Every plan's live defect was found this way, or by Ben on a real
screen — never by a passing test.

Demand:

- **a test that fails before the fix**, demonstrated, not asserted;
- **measurement** for anything performance-shaped — an instrumented `MemoryStore` proxy
  is the house technique;
- **a real browser** for any layout or figure claim. Three defects were found only that
  way, including a page printing the wrong field after the domain was already correct;
- **deletion** of what a change supersedes, in the same commit. A red build from a
  deletion is a result — it inventories the callers better than any grep.

## The failure this project keeps having

Every fixture was once a user with no household assignments. A parity test built
precisely to catch cross-surface disagreement, plus five field-by-field audits, all
passed while a live defect sat in production — Ben found it in thirty seconds on his own
accounts page.

`packages/domain/src/estate.fixture.ts` exists to end that: a household of two with
hand-set shares, salaries, a shared pot with its own income, an unassigned bills pot,
authored movements, mixed confirmed states, two currencies. It then went stale
_silently_ — a figure drifted, a seeding branch quietly took a different path, no
contributions were booked, every test still passed — and now carries
`ESTATE_CONFIRMATION_SHAPES` asserting each intended path is actually taken.

**Ask of every plan: what shape do its fixtures avoid?**

## Re-open dismissed findings at every wave boundary

A finding dismissed as "premise false" is dated evidence about a past tree, never a
settled fact about the current one. The defect that caused `ONE-ENGINE.md` existed
because a correct dismissal outlived its premise and nothing re-opened it. In work whose
whole purpose is changing premises under previously-correct code, this is load-bearing.
