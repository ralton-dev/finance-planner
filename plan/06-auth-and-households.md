# Authentication, Users & Households

> Decision: **multi-user with login + shared households** (`00-overview.md`).
> Owned by the `auth` service (`01-architecture.md`), schema `auth`.

## 1. Goals

- Each person has their own login and sees only data they're entitled to.
- Accounts can be **shared** with a **household** so multiple users (e.g.
  partners) can collaborate on the same budget.
- Granular enough to support view-only vs. edit access.

## 2. Entities

### 2.1 User
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| email | citext (unique) | Login identifier. |
| password_hash | text | Argon2id. Null if external IdP only. |
| display_name | text | |
| status | enum | `active` \| `invited` \| `disabled`. |
| created_at / updated_at | timestamptz | |

### 2.2 Household
A named group that accounts can be shared into.
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| name | text | e.g. "Smith Household". |
| created_by | uuid | FK → User. |
| created_at | timestamptz | |

### 2.3 HouseholdMembership
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| household_id | uuid | FK → Household. |
| user_id | uuid | FK → User. |
| role | enum | `owner` \| `admin` \| `member`. |
| status | enum | `active` \| `invited`. |
| invited_email | citext? | For pending invites before the user exists. |

`owner`/`admin` can manage members and shares; `member` participates.

### 2.4 AccountShare
Grants a household access to an account (the account itself lives in `core`).
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| account_id | uuid | Logical FK → core.accounts. |
| household_id | uuid | FK → Household. |
| permission | enum | `view` \| `edit`. |
| created_by | uuid | FK → User. |
| created_at | timestamptz | |

### 2.5 Session / refresh tokens
| Field | Type | Notes |
|-------|------|-------|
| id | uuid (PK) | |
| user_id | uuid | FK → User. |
| refresh_token_hash | text | Opaque token, hashed at rest. |
| user_agent / ip | text | For session listing/revocation. |
| expires_at | timestamptz | |
| revoked_at | timestamptz? | |

## 3. Authentication flow

- **Registration**: email + password (Argon2id). Email verification (token link)
  before `active` — can be relaxed for early phases (see open questions).
- **Login**: returns a short-lived **access JWT** (~15 min) + a long-lived
  **opaque refresh token** (stored httpOnly cookie; hash persisted).
- **Refresh**: exchange refresh token for a new access JWT; rotate refresh token.
- **Logout**: revoke the refresh token (set `revoked_at`).
- **Access JWT claims**: `sub` (userId), `email`, `iat`, `exp`. Authorization
  data (which accounts) is resolved server-side, not baked into the token, so
  share changes take effect immediately.

> **External IdP option**: the design leaves room to add OIDC (Google/Apple/
> generic) later — `password_hash` is nullable and the token model is standard.
> Whether to ship password auth, OIDC, or both in v1 is in `09-open-questions.md`.

## 4. Authorization (effective access resolution)

For any account-scoped request, the user's access is the **most permissive** of:

1. **Owner**: `core.accounts.owner_user_id == userId` → full (`edit`).
2. **Shared**: there exists an `AccountShare` for the account into a household
   the user is an `active` member of → permission = the share's `permission`.

```
effectivePermission(user, account):
  if account.owner_user_id == user.id: return EDIT
  shares = accountShares(account.id) ∩ households(user.id)
  return max(share.permission for share in shares)   // edit > view, else none
```

- `auth` exposes `/internal/auth/users/:id/accounts-acl` returning the set of
  `{accountId, permission}` for fast filtering in `api` (cached briefly in Redis).
- Reads need `view`; mutations need `edit`. Sharing/household management requires
  household `admin`/`owner`. Deleting an account requires being its `owner`.

## 5. Invitations

- Invite by email. If the email is unknown, create an `invited` membership with
  `invited_email`; on registration with that email, claim pending invites.
- Invite emails contain a signed, expiring token link.

## 6. Security practices

- Argon2id password hashing; enforce password strength + breached-password check.
- Rate-limit auth endpoints; lockout/backoff on repeated failures.
- Refresh-token rotation with reuse detection (revoke family on reuse).
- Tokens: access JWT signed with rotating keys (JWKS); refresh tokens opaque +
  hashed at rest.
- CSRF protection for the cookie-based refresh flow; SameSite=strict cookies.
- Audit log of household/share/membership changes.
- Principle of least privilege between services (internal endpoints not exposed
  publicly; network policy restricts who can call `auth`).

## 7. Privacy / data protection

- Treat financial data as sensitive: encrypt at rest (DB-level / volume), TLS in
  transit, minimise PII in logs.
- Account deletion + "export my data" + "delete my data" flows for GDPR (later
  phase, but schema uses cascading deletes to make erasure feasible).

## 8. Testing

- Unit: permission resolution matrix (owner/admin/member × view/edit × shared/own).
- Integration: full register→login→refresh→logout; invite + claim; share + access.
- Security: token reuse detection, rate limiting, authorization bypass attempts
  (can't read/edit another user's unshared account → 404).
