# Domain Model & Database Schema

> The calculation logic that consumes this model lives in
> `03-calculation-engine.md`. Auth-owned entities (users, households) are
> detailed in `06-auth-and-households.md` and summarised here for relationships.

## 1. Entity overview

```
User ──< HouseholdMembership >── Household
                                     │
Household ──< AccountShare >── Account ──< Income
                                  │
                                  └──< Payment ──< Contribution (computed)
                                         │
                                         └── (category-specific recurrence)

Account ──1:1── PlanSnapshot (latest computed plan, calc schema)
```

- A **User** belongs to zero or more **Households** (via `HouseholdMembership`).
- An **Account** is owned by a user and may be **shared** with a household
  (via `AccountShare`), granting other members access.
- An **Account** has many **Incomes** and many **Payments**.
- A **Payment** carries category + recurrence info and a target/due date.
- **Contributions** and **PlanSnapshots** are *computed* artefacts produced by
  the calc engine, not user-entered.

## 2. Core entities

### 2.1 Account
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| owner_user_id | uuid | FK → auth user. |
| name | text | e.g. "Joint Current Account". |
| description | text? | Optional. |
| currency | char(3) | ISO 4217; display currency for the account. |
| opening_balance_minor | bigint | Current available balance, in minor units. |
| created_at / updated_at | timestamptz | |

### 2.2 Income
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| account_id | uuid | FK → Account. |
| name | text | e.g. "Salary". |
| amount_minor | bigint | Amount per occurrence, minor units. |
| frequency | enum | `monthly` \| `yearly` \| `custom` \| `one_off`. |
| recurrence | jsonb? | For `custom`: interval + unit (see §3). |
| anchor_date | date | First/next occurrence date. |
| active | bool | Soft toggle. |
| created_at / updated_at | timestamptz | |

> Incomes reuse the same frequency/recurrence model as payments so monthly
> available income can be normalised consistently (see calc engine §2).

### 2.3 Payment
The central outgoing entity. A single table with a `category` discriminator and
a `recurrence` jsonb for flexibility, plus typed columns for the common fields.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| account_id | uuid | FK → Account. |
| name | text | e.g. "Car insurance". |
| category | enum | `monthly_recurring` \| `yearly_recurring` \| `custom_recurring` \| `fixed_point`. |
| amount_minor | bigint | Amount due per occurrence. |
| due_date | date | Next due date / target date. **Required for `fixed_point`.** |
| recurrence | jsonb? | Cadence for recurring categories (see §3). Null for `fixed_point`. |
| target_date | date? | Optional override of "by when" the goal must be met (defaults to `due_date`). |
| priority | int | Lower = funded first when income is short (see calc §4). Default 100. |
| already_saved_minor | bigint | Amount already set aside toward this payment. Default 0. |
| auto_renew | bool | For recurring: roll `due_date` forward after the occurrence passes. |
| active | bool | Soft toggle / pause. |
| notes | text? | |
| created_at / updated_at | timestamptz | |

### 2.4 Contribution (computed, optional persistence)
A per-payment, per-period computed line item. May be materialised in `calc`
schema for history/auditing, or computed on the fly.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| plan_snapshot_id | uuid | FK → PlanSnapshot. |
| payment_id | uuid | FK → Payment. |
| period_month | date | The month this contribution applies to (1st of month). |
| required_minor | bigint | Ideal monthly contribution to stay on track. |
| funded_minor | bigint | Amount actually allocated after priority funding. |
| on_track | bool | Whether the target date is still achievable. |
| projected_completion_date | date? | If not on track, when it *would* complete. |

### 2.5 PlanSnapshot (computed)
A cached result of a full account computation (`calc` schema).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| account_id | uuid | FK → Account (or null for an aggregate overview snapshot). |
| computed_at | timestamptz | |
| as_of_date | date | The "today" used for the computation. |
| monthly_income_minor | bigint | Normalised monthly income. |
| total_required_minor | bigint | Sum of ideal contributions. |
| total_funded_minor | bigint | Sum after prioritised funding. |
| leftover_minor | bigint | Surplus (≥0) for the month. |
| shortfall_minor | bigint | Unfunded amount (≥0) for the month. |
| inputs_hash | text | Hash of inputs for cache invalidation. |
| detail | jsonb | Full per-payment breakdown (denormalised for fast reads). |

## 3. Recurrence representation

For `custom_recurring` payments (and custom incomes), `recurrence` is a jsonb:

```jsonc
{
  "interval": 3,            // every 3 ...
  "unit": "month",          // "day" | "week" | "month" | "year"
  "anchor": "2026-01-15"    // occurrence anchor; future occurrences derive from this
}
```

Monthly / yearly categories are conveniences over this model:
- `monthly_recurring` ≡ `{ interval: 1, unit: "month" }`
- `yearly_recurring`  ≡ `{ interval: 1, unit: "year" }`

Keeping a normalised recurrence object lets the calc engine treat every
recurring item uniformly while the UI offers friendly category-specific forms.

## 4. PostgreSQL schema (DDL sketch)

Three logical schemas. Money is **always** `bigint` minor units; never floats.

```sql
CREATE SCHEMA auth;   -- users, households, sessions (see 06-auth doc)
CREATE SCHEMA core;   -- accounts, incomes, payments
CREATE SCHEMA calc;   -- plan_snapshots, contributions

-- ---------- core ----------
CREATE TYPE core.payment_category AS ENUM
  ('monthly_recurring','yearly_recurring','custom_recurring','fixed_point');
CREATE TYPE core.frequency AS ENUM
  ('monthly','yearly','custom','one_off');

CREATE TABLE core.accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid NOT NULL,            -- references auth.users(id)
  name                 text NOT NULL,
  description          text,
  currency             char(3) NOT NULL DEFAULT 'GBP',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.incomes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  frequency    core.frequency NOT NULL,
  recurrence   jsonb,
  anchor_date  date NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  name                text NOT NULL,
  category            core.payment_category NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),
  due_date            date,
  recurrence          jsonb,
  target_date         date,
  priority            int NOT NULL DEFAULT 100,
  already_saved_minor bigint NOT NULL DEFAULT 0 CHECK (already_saved_minor >= 0),
  auto_renew          boolean NOT NULL DEFAULT true,
  active              boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixed_point_needs_due_date
    CHECK (category <> 'fixed_point' OR due_date IS NOT NULL)
);
CREATE INDEX ON core.payments (account_id);
CREATE INDEX ON core.payments (account_id, priority);

-- ---------- calc ----------
CREATE TABLE calc.plan_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid REFERENCES core.accounts(id) ON DELETE CASCADE,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  as_of_date           date NOT NULL,
  monthly_income_minor bigint NOT NULL,
  total_required_minor bigint NOT NULL,
  total_funded_minor   bigint NOT NULL,
  leftover_minor       bigint NOT NULL,
  shortfall_minor      bigint NOT NULL,
  inputs_hash          text NOT NULL,
  detail               jsonb NOT NULL
);
CREATE INDEX ON calc.plan_snapshots (account_id, computed_at DESC);

CREATE TABLE calc.contributions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_snapshot_id          uuid NOT NULL REFERENCES calc.plan_snapshots(id) ON DELETE CASCADE,
  payment_id                uuid NOT NULL REFERENCES core.payments(id) ON DELETE CASCADE,
  period_month              date NOT NULL,
  required_minor            bigint NOT NULL,
  funded_minor              bigint NOT NULL,
  on_track                  boolean NOT NULL,
  projected_completion_date date
);
CREATE INDEX ON calc.contributions (plan_snapshot_id);
```

> Foreign keys across schemas (e.g. `core.accounts.owner_user_id` →
> `auth.users.id`) are kept as logical references and enforced in-application if
> we later split Postgres physically per service. While single-DB, real FKs are
> used where cheap.

## 5. Validation & invariants

- `amount_minor`, `already_saved_minor` ≥ 0.
- `fixed_point` payments **must** have a `due_date`.
- Recurring payments **must** have a `recurrence` (or be one of the
  monthly/yearly shorthand categories that imply one).
- `currency` is per account; all amounts on an account share that currency
  (multi-currency conversion is a non-goal initially).
- `target_date` defaults to `due_date` when omitted.

## 6. Soft delete vs. hard delete

Use `active = false` to pause/retire incomes and payments (preserves history and
keeps past snapshots meaningful). Hard deletes cascade and are reserved for
genuine mistakes / GDPR erasure.
