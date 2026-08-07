# Running a plan with parallel agents

How the `INFLOWS` / `ONE-ENGINE` / `MONTH-CLOSE` / `MINE-AND-OURS` work was executed,
written down so the next orchestrator does not rediscover it. Everything here was
learnt by getting it wrong first.

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

Plus `pnpm coverage` when `packages/domain` is touched, and
`pnpm --filter @finance-planner/data test:int` when a migration is added.

**What the coverage gate actually is.** The thresholds that fail the build live in
`packages/domain/vitest.config.ts` — as of **2026-08-07**: lines **99.9**, functions
**100**, branches **95.5**, statements **99.8**. **Read them from the config, not from
here.** Two separate briefs have now stated this gate wrong from memory, in opposite
directions, and prose is where the rot starts.

They sit deliberately just under what the package holds, so ordinary noise passes and
a real regression fails — `functions: 100` has no slack at all. That is a recent and
hard-won shape. The config's own comment records why: the thresholds **used to be
95/95/80/95 while the package was measuring 99.9/100/95.6/99.9**, and that gap is how
~900 lines of lightly-tested tracing landed in `scope.ts` with CI green, the drop
visible only to someone measuring both sides of the diff. Its conclusion is the
sentence to carry: _a gate below the achieved level is not a gate._ Raise the
thresholds when the figure rises; **never lower them to make a change fit.**

So if a change drops coverage, the gate is supposed to stop you, and the fix is the
test rather than the threshold. Do not be reassured by CI passing on a number you have
not looked at.

The older mistake, for anyone who finds it quoted elsewhere: this section used to name
a floor of "99.87% statements / 95.84% branches — do not ratchet down", which was
never meetable — 95.84% is not a value 571 branches can produce. On `main`'s tree,
measured **2026-08-07**, `packages/domain` held **99.89% statements (969/970), 95.62%
branches (546/571), 100% functions, 100% lines**. Two things about those figures:
they came from `main` and a branch in flight may legitimately report slightly
different ones, so name the tree whenever you write a number down; and the same tree
measured **identically under vitest 4.1.8 and 4.1.10**, so a coverage-tool bump is not
a plausible explanation for a number that has moved. **Date any figure you record
here, and re-measure rather than trusting it.**

`prettier --check` is repo-wide and fatal. A stray untracked file breaks it.

**`pnpm test` can print `FULL TURBO` and tell you nothing.** Turbo caches on content,
so when an agent has just run the suite and reports green, the orchestrator's re-run
over the same tree replays that agent's own result out of the cache in a second or
two. Nothing is re-executed. That is Turbo working correctly and it is **not
independent verification** — it is the agent's claim, read back in the agent's own
handwriting. When the point of the run is to check the agent rather than the code,
force it — but force it at the right layer:

```
pnpm exec turbo run test --force     # correct: turbo re-executes everything
pnpm test -- --force                 # WRONG: forwards --force to vitest, which fails
```

`pnpm test` is `turbo run test`, and `--` hands the flag past turbo to each package's
own test command. Vitest does not take `--force`, so that form exits 1 with
`0 successful, 10 total` and looks exactly like the suite having broken. Both were
tried; only the first does what it says. Watch for `Cached: 0 cached, 10 total` in the summary — that line, not
the word "successful", is the evidence the run happened.

This belongs in the same paragraph as the missing gate above for the same reason: both
are ways of being told green by something that never looked. Use the cache freely when
you are moving between packages and want speed; force it at the wave boundary, before
a push, and any time you would quote the result back to Ben.

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

**There is a second way to hit it, and it does not involve running anything.** One
agent died having written nothing at all: it was reading large source files in
silence, orienting itself before its first edit, and never emitted a line. Reading is
not free — a handful of thousand-line files, taken carefully, is ten minutes. The
first kill is expensive and the second is worse, because an agent that dies before its
first commit resumes with nothing to resume from.

The wording that fixed it, after which nothing stalled again for the rest of that
plan: **emit a line before every file read, not merely between steps**, and **work in
staged commits so a kill costs one step rather than a package**. The second half is
what makes the first half survivable — it turns the watchdog from a thing that
destroys work into a thing that interrupts it.

Put in every brief:

- emit a line of output **before every file read** and after every edit — between
  steps is not often enough;
- **work in staged commits**; a killed agent should lose one step, never a package;
- never run the full suite more than twice in a row;
- **commit before any long final verification**;
- if a browser pass is needed, **do it first, not last**;
- name the long files up front, so an agent knows which reads to narrate.

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

**Do not let agents use `git add` at all. Have them commit by explicit path:
`git commit -- <path> <path>`.** "Stage owned paths explicitly, by name" is not
enough, and the sentence above said exactly that for four plans while being
insufficient. Concurrent agents share one working tree **and one git index**. In
the said-and-done work, one agent staged its three files with `git add` and a
second agent's `git commit` ran before the first's did — sweeping the first
agent's finished work into a commit belonging to a different package, under a
different message. It happened **twice in one wave**, to the same pair. Nothing
was lost, because the code was correct and the tree was shared; what was lost was
the provenance, which is most of what a commit is for.

`git commit -- <paths>` bypasses the index entirely and cannot pick up another
agent's staged work. It costs nothing and removes the whole class. The agent that
diagnosed it put it best: _never `git add`; use `git commit -- <paths>`._

A related consequence worth stating: **a wave's commits are not a reliable record
of which package did what** unless this rule is followed. Verify by file, not by
commit message, when it matters.

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

**There is no `tsx` binary in the _root_ `node_modules/.bin`**, so a harness run as
`tsx harness.ts` from the repo root fails before it does anything and reads like a
missing dependency. `tsx` is a devDependency of the three services, not of the root,
and pnpm links a binary only into the packages that declare it. So the shim does
exist — one per service:

```
./apps/api/node_modules/.bin/tsx  harness.mts
./apps/auth/node_modules/.bin/tsx harness.mts
./apps/calc/node_modules/.bin/tsx harness.mts
```

Use one of those. **Do not write down a `node --import .../.pnpm/tsx@<version>/...`
loader path**, which is what this section used to recommend. That path carries the
resolved version in it, so it is wrong again on the next bump — and it goes stale
faster than that, because a caret range floats to a new patch on an ordinary install
without anything in the repository changing. Two agents recently reported different
`tsx` versions and both were right; they were reading different branches. No version
number is deliberately named here for that reason. The per-app binary has none in it
and survives.

Ports already spent, so the next run picks elsewhere: **4310–4312, 4410–4412 and
4510–4512** across three harnesses in the mine-and-ours work, and **4610–4611, 4620,
4630–4631** across the dependency-refresh harnesses. Three ports per harness, because
auth, api and the static server each need one.

**Name the harness `.mts`, not `.ts`.** The scratchpad has no `package.json`, so a
`.ts` file there is treated as CommonJS and every top-level `await` fails at transform
time with `Top-level await is currently not supported with the "cjs" output format` —
a dozen errors that say nothing about the actual problem, which is the file extension.
`.mts` forces ESM and the same file runs unchanged.

A harness outside the repo also cannot resolve bare specifiers like
`@finance-planner/data` or `jose`: the lookup walks up from the scratchpad and never
reaches the repo's `node_modules`. Import by absolute `file://` URL instead, pointing
straight at the TypeScript source — which is what the workspace packages export anyway:

```
const ROOT = "file:///abs/path/to/worktree";
const { MemoryStore } = await import(`${ROOT}/packages/data/src/memory-store.ts`);
```

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

They are reliable and they will tell you when a brief is wrong. **The count is now
well past thirty across four plans, and every one of them was right.** The
mine-and-ours work alone contributed nine — including two corrections to the
orchestrator's own description of a field it had written the brief about, and one that
stopped `PATCH` and `DELETE` on a shared project being granted to every co-member of
the household it was shared into. Not one was a false alarm. Write briefs that invite
it: _"if a premise here is wrong, say so and serve its intent, not its letter."_

The corollary, learnt the same way: **a brief's `file:line` references are hints to
verify, not facts.** Three had drifted by the time the packages holding them ran, in a
plan whose own line numbers were re-checked when it was written — a file the previous
wave touched moves every reference below the edit, and the plan does not move with it.
Tell agents to grep for the symbol and confirm the line says what the brief claims
before acting on it, and to report the drift rather than quietly working around it.
The same applies to `BACKLOG.md`: an entry is dated evidence about the tree on the day
it was written, and several have been found describing gaps that later work had
already closed.

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
