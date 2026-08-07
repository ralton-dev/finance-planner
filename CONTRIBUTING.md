# Contributing

Thanks for your interest. This is a personal-scale project, but contributions
are welcome — bug reports, small fixes, and well-motivated features all
land the same way.

## Reporting bugs / suggesting changes

Open a [GitHub issue](https://github.com/ralton-dev/finance-planner/issues)
with:

- What you expected to happen
- What actually happened
- Steps to reproduce (smallest reliable repro wins)

If it's a security-relevant issue, please use GitHub's private vulnerability
reporting instead of opening a public issue.

## Local setup

See [`README.md`](./README.md) for the three local-dev modes and prerequisites
(Node 24, pnpm 10, Docker). The short version:

```bash
npm i -g corepack                          # Node 25+ no longer bundles it
corepack enable
pnpm install
cp .env.example .env
make up                                    # postgres, redis, services
pnpm --filter @finance-planner/web dev     # web on :5173
```

## Branching + PR flow

Trunk-based. Branch off `main`, push, open a PR. `main` is branch-protected:

- 1 approving review required
- Linear history (squash-merge or rebase-merge, no merge commits)
- All required status checks green:
  `build-test` · `integration` · `e2e` · `helm` · `stack-smoke` ·
  `docker (web/api/auth/calc)`
- No force-push, no deletion, conversation resolution required

If your change crosses obvious code/test/doc boundaries, prefer **one PR per
slice** over a single mega-PR — easier to review and revert.

## What good looks like

The CI matrix is the floor. To not have to think about it locally:

```bash
pnpm format          # prettier --write .
pnpm lint            # eslint
pnpm typecheck       # tsc --noEmit across workspaces
pnpm test            # unit + component (MemoryStore-backed)
pnpm coverage        # engine: ≥99.9% lines / ≥95.5% branches (gated)
pnpm --filter @finance-planner/data test:int   # integration vs real Postgres
pnpm --filter @finance-planner/web test:e2e    # Playwright
```

### Tests per feature

Tests are completed **with** the feature, not after. A PR isn't done until:

- New pure logic has unit tests (engine + utils).
- New / changed API endpoints have integration coverage (api/auth use
  Fastify's `inject`; data uses Testcontainers).
- New UI components with meaningful states (loading / empty / error /
  at-risk vs on-track) have RTL component tests.
- Any user-visible journey change extends a Playwright spec.

The engine is the heart of the product and is held to a higher coverage bar.
The thresholds sit just under what the package actually holds — currently
99.9/95.5 — so ordinary noise passes and a real regression fails. They were
once set far below the achieved figure, which is how a large, lightly-tested
addition landed with CI green and the drop visible only to somebody measuring
both sides of the diff. A gate below the achieved level is not a gate. Don't
lower it — extend it, and raise the numbers when the figure rises.

### Style

- TypeScript strict (no `any` without a good reason). Prefer narrow types
  at the boundary; trust them inwards.
- Comments: only when the **why** is non-obvious. Don't paraphrase the code.
- Money is **always** integer minor units (pennies). Never floats.
- Dates are **always** date-only ISO strings (`YYYY-MM-DD`). The engine never
  reads the wall clock — it takes an explicit `asOfDate`.
- Permission checks: use `packages/policies` (`ability.can(action, subject(kind, obj))`),
  not inline role checks. The 404-vs-403 leak rule lives in `hasAnyAccess`.

### Commit messages

Prose, not Conventional Commits. Lead with what changed and why; the diff
explains the how. Examples in `git log`. Squash before merge if the PR has
work-in-progress commits.

## Where the work happens

- The maths: [`packages/domain/src/engine.ts`](./packages/domain/src/engine.ts)
- The data model: [`packages/data/src/schema.ts`](./packages/data/src/schema.ts)
- The API surface: [`apps/api/src/server.ts`](./apps/api/src/server.ts)
- Auth flows: [`apps/auth/src/server.ts`](./apps/auth/src/server.ts)
- Authorisation rules: [`packages/policies/src/ability.ts`](./packages/policies/src/ability.ts)
- The UI shell: [`apps/web/src/components/Layout.tsx`](./apps/web/src/components/Layout.tsx)

## What's on the deferred list

Before proposing a "big new feature", check [`BACKLOG.md`](./BACKLOG.md) — it
catalogues things deliberately not built in v1, with a one-line note on
where each one's seam lives. Picking off backlog items is one of the most
useful contributions.

## License

By contributing, you agree your changes are licensed under the project's
[MIT License](./LICENSE).
