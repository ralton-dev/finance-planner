# Calculation Engine

> This is the core of the product. The engine is a **pure, deterministic
> library** in `packages/domain`, imported by `calc` (worker), `api` (sync
> path), and optionally `web` (optimistic previews). Same inputs → same outputs.
>
> Money is in integer **minor units** (pennies). Rounding rules are defined in
> §6 to guarantee contributions sum back to totals.

## 1. What the engine answers

Given an account's incomes, payments, and a reference date ("today"), produce:

1. **Per-payment required monthly contribution** — how much to set aside this
   month to be ready by the target date.
2. **Funded amount per payment** — after applying the prioritised funding rule
   when income is insufficient.
3. **On-track status & projected completion date** per payment.
4. **Account totals**: normalised monthly income, total required, total funded,
   **leftover (surplus)** and **shortfall (deficit)**.

## 2. Normalising income to a monthly figure

Each income is converted to an equivalent **monthly amount**:

| Frequency | Monthly equivalent |
|-----------|--------------------|
| `monthly` | `amount` |
| `yearly`  | `amount / 12` |
| `custom`  | `amount / intervalInMonths(recurrence)` |
| `one_off` | spread over months until `anchor_date` if future, else 0 |

`monthlyIncome = Σ monthlyEquivalent(income)` over active incomes.

`intervalInMonths({interval, unit})`:
- `month` → `interval`
- `year`  → `interval * 12`
- `week`  → `interval * 7 / 30.4375` (avg month length)
- `day`   → `interval / 30.4375`

## 3. Required monthly contribution per payment

Let:
- `now` = `as_of_date`
- `monthsUntil(d)` = whole months from `now` to date `d`, **floored at a
  minimum of 1** to avoid divide-by-zero and to mean "due this month".

### 3.1 Fixed-point (one-off)
```
remaining        = max(0, amount - already_saved)
target           = target_date ?? due_date
monthsLeft       = monthsUntil(target)
requiredMonthly  = ceilDiv(remaining, monthsLeft)
```
> Example: £1,200 holiday due in 8 months, £0 saved →
> `1200_00 / 8 = 150_00` → **£150/month**. With £400 already saved →
> `(1200-400)/8 = 100_00` → **£100/month**.

### 3.2 Yearly recurring
Save smoothly toward the next occurrence, then keep saving for the one after.
```
nextDue          = nextOccurrence(due_date, recurrence, now)
remaining        = max(0, amount - already_saved)   // toward this occurrence
monthsLeft       = monthsUntil(nextDue)
requiredMonthly  = ceilDiv(remaining, monthsLeft)
```
After `nextDue` passes (and `auto_renew`), `already_saved` resets and the cycle
repeats; the steady-state contribution converges to `amount / 12`.
> Example: £320 car insurance due in 5 months, nothing saved →
> `320_00 / 5 = 64_00` → **£64/month** until renewal, then ~£26.67/month
> (320/12) in steady state.

### 3.3 Monthly recurring
Due every month — there is nothing to "save up"; the full amount is required
each month as a direct commitment.
```
requiredMonthly  = amount
```
> These reduce leftover directly. The UI distinguishes "bills paid this month"
> from "savings toward future goals", but both consume monthly income.

### 3.4 Custom recurring
Generalises the above using the recurrence cadence.
```
nextDue          = nextOccurrence(due_date, recurrence, now)
remaining        = max(0, amount - already_saved)
monthsLeft       = monthsUntil(nextDue)
requiredMonthly  = ceilDiv(remaining, monthsLeft)
```
> Example: £90 water bill every 3 months, next due in 2 months, £0 saved →
> `90_00 / 2 = 45_00` this cycle; steady state `90/3 = 30_00`/month.

### 3.5 `nextOccurrence(anchor, recurrence, now)`
Advance `anchor` by `recurrence` steps until the date is `>= now`. Handles
month-end clamping (e.g. anchor on the 31st in a 30-day month → last day).

## 4. Prioritised funding & shortfall

Per discovery, the behaviour is **prioritise + show shortfall**.

```
availableForSavings = monthlyIncome            // (optionally minus a user-set buffer)
payments            = sort(active payments by priority asc, then due_date asc)

remainingBudget = availableForSavings
for p in payments:
    funded[p]      = min(p.requiredMonthly, remainingBudget)
    remainingBudget -= funded[p]
    p.onTrack      = funded[p] >= p.requiredMonthly
    if not p.onTrack:
        p.projectedCompletion = projectCompletion(p, funded[p])

totalRequired = Σ requiredMonthly
totalFunded   = Σ funded
leftover      = max(0, remainingBudget)        // surplus
shortfall     = max(0, totalRequired - totalFunded)  // unfunded gap
```

### 4.1 Projected completion when underfunded
If a goal only receives `funded < required`, estimate when it *would* complete at
the current funding rate:
```
monthsNeeded            = ceilDiv(remaining, max(funded, 1))
projectedCompletion     = now + monthsNeeded months
```
This drives the "at risk — projected late by N months" indicator in the UI.

### 4.2 Why priority funding (not proportional)
The product owner chose explicit prioritisation: the user ranks goals via
`payment.priority`; the engine funds top priorities fully before lower ones,
and surfaces exactly which goals are starved and by how much. (Proportional
split was the rejected alternative — see `00-overview.md`.)

## 5. Account result shape

```ts
interface PaymentPlanLine {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string;            // ISO date
  targetDate: string;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  alreadySavedMinor: number;
  onTrack: boolean;
  projectedCompletionDate?: string;
  monthsUntilDue: number;
}

interface AccountPlan {
  accountId: string;
  asOfDate: string;
  currency: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;       // surplus
  shortfallMinor: number;      // deficit
  lines: PaymentPlanLine[];
}
```

## 6. Rounding rules (important for trust)

- All division uses **`ceilDiv`** for required contributions, so you never
  under-save and miss the target by a penny.
- Account totals are summed from the **already-rounded** per-payment figures so
  the breakdown visibly adds up to the totals (no "£0.01 unaccounted").
- Steady-state smoothing (e.g. yearly → /12) uses banker's rounding only for
  display estimates, never for the "required this month" figure.

## 7. All-accounts overview aggregation

The overview computes each account's `AccountPlan`, then aggregates **per
currency** (no FX conversion initially):

```
overview.perCurrency[ccy] = {
  monthlyIncome:  Σ account.monthlyIncome,
  totalRequired:  Σ account.totalRequired,
  totalFunded:    Σ account.totalFunded,
  leftover:       Σ account.leftover,
  shortfall:      Σ account.shortfall,
  accounts:       [ ...per-account summaries ]
}
```
If all accounts share one currency, this collapses to a single set of totals.

## 8. Determinism, testing & edge cases

The engine must be exhaustively unit-tested. Key cases:

- Target date in the past or this month → `monthsLeft = 1`, full remaining due now.
- `already_saved >= amount` → required = 0, on track, possibly refundable surplus.
- Income = 0 → everything underfunded; shortfall = total required.
- Paused (`active=false`) incomes/payments excluded.
- Custom recurrence with week/day units and month-end clamping.
- Leap years / Feb 29 anchors.
- Mixed currencies in overview (must not silently sum across currencies).
- Very large numbers of payments (performance: O(n log n) from the sort).

> **Golden-file tests**: maintain a set of input fixtures → expected
> `AccountPlan` JSON, so any change to the maths is reviewed deliberately.

## 9. Future extensions (flagged, not in v1)

- Per-goal funding buffers / emergency-fund reservation off the top.
- Interest/savings-rate modelling toward goals.
- "What-if" simulation (add a hypothetical payment and preview impact).
- Lump-sum windfall allocation across goals by priority.
