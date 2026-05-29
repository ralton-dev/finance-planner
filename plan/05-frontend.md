# Frontend (React + TypeScript)

> Consumes the `api` REST surface (`04-backend-services.md`). Shares DTO/Zod
> types from `packages/contracts` and can import the pure engine from
> `packages/domain` for instant optimistic previews.

## 1. Stack

| Concern | Choice | Notes |
|---------|--------|-------|
| Build | Vite | Fast dev server, simple prod build to static assets. |
| Language | TypeScript (strict) | |
| Routing | React Router | |
| Server state | TanStack Query | Caching, mutations, invalidation mirrors API. |
| Forms | React Hook Form + Zod resolver | Reuse `packages/contracts` schemas. |
| Styling | Tailwind CSS + a component lib (shadcn/ui) | Fast, consistent, accessible. |
| Charts | Recharts (or visx) | Breakdown bars, timelines, progress rings. |
| Money formatting | `Intl.NumberFormat` per account currency | Always render from minor units. |
| Testing | Vitest + React Testing Library; Playwright (E2E) | |

## 2. Information architecture / screens

```
/login, /register                  Auth
/                                  Overview (all accounts)
/accounts                          Account list / management
/accounts/:id                      Account detail (breakdown + plan)
/accounts/:id/payments/new         Add payment (category-aware form)
/accounts/:id/incomes/new          Add income
/households                        Households & sharing management
/settings                          Profile, currency defaults
```

### 2.1 Overview screen (all accounts)
The "see an overview of all the accounts" requirement.
- Top KPI row (per currency): total monthly income, total required savings,
  total leftover, total shortfall.
- Per-account summary cards: income, required, leftover/shortfall, # at-risk goals.
- Aggregate chart: stacked bar of committed vs. leftover; list of at-risk goals
  across all accounts (sorted by how late they're projected).

### 2.2 Account detail screen
The "see each account's breakdown" requirement.
- Header: balance, monthly income, leftover/shortfall badge.
- **Plan table** (one row per payment): name, category chip, amount, due/target
  date, **required £/month**, **funded £/month**, progress (`already_saved` vs
  `amount`), on-track ✓ / at-risk ⚠ with projected date.
- Drag-to-reorder priority (writes `priority` via reorder endpoint).
- Income list with frequencies.
- Timeline view: upcoming payments on a calendar/Gantt-style strip.

### 2.3 Add/edit payment form (category-aware)
Single form that adapts to the four categories:
- `monthly_recurring`: amount only.
- `yearly_recurring`: amount + month/day due.
- `custom_recurring`: amount + interval + unit + anchor date.
- `fixed_point`: amount + due/target date.
- Common: name, priority, already-saved, account, notes.
- Live preview panel computes the required monthly contribution **client-side**
  using `packages/domain` so the user sees impact before saving.

## 3. State & data fetching

- **Server state** via TanStack Query: query keys mirror resources
  (`['account', id, 'plan']`, `['overview']`). Mutations invalidate the affected
  account plan + overview.
- **Optimistic UI**: on payment/income edits, recompute the plan locally with the
  shared engine for instant feedback, then reconcile with the server snapshot.
- **Auth state**: access token in memory, refresh token in httpOnly cookie;
  silent refresh on 401. (Token storage approach flagged in open questions.)
- Minimal global client state (theme, current household context) via a small
  context/store (Zustand if needed).

## 4. Component structure

```
apps/web/src/
├── app/                 router, providers (QueryClient, auth, theme)
├── features/
│   ├── auth/
│   ├── accounts/        list, detail, cards, plan table
│   ├── payments/        category-aware form, row, priority reorder
│   ├── incomes/
│   ├── overview/        KPIs, aggregate charts, at-risk list
│   └── households/      sharing UI, member management
├── components/          shared UI (from packages/ui or shadcn)
├── lib/                 api client (typed via contracts), money/date utils
└── hooks/               useAccountPlan, useOverview, useAuth, ...
```

## 5. Money & date handling (frontend rules)

- Never store money as floats; pass `*_minor` integers to/from the API.
- Format with `Intl.NumberFormat(locale, { style:'currency', currency })`.
- Parse user input → minor units at the form boundary (handle locale decimal
  separators).
- Dates are date-only (ISO `YYYY-MM-DD`); display in the user's locale.

## 6. UX details that build trust

- Show the **maths**: tooltip on each "required £/month" explaining
  `(amount − saved) ÷ months left`.
- Clear **at-risk** styling with "projected N months late" and a suggested fix
  (raise priority, increase income, push the target date).
- Surplus framed positively ("£X free to allocate"); deficit framed actionably.
- Empty states guiding first-time setup (add account → add income → add payment).

## 7. Accessibility & responsiveness

- WCAG AA: keyboard-navigable tables, reorder via keyboard, sufficient contrast,
  ARIA on charts (data-table fallback).
- Responsive: overview cards reflow; plan table → stacked cards on mobile.

## 8. Testing (frontend)

- Unit: money/date utils, form parsing, optimistic-preview wiring.
- Component: plan table rendering for each category + at-risk states (RTL).
- E2E (Playwright): register → create account → add income + payments →
  verify plan numbers and overview aggregation.
