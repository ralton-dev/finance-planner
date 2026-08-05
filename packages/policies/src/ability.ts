/**
 * Authorization rules for Finance Planner.
 *
 * Single source of truth for what a user is allowed to do. Both api and auth
 * build an ability per request from the user's effective access and call
 * `ability.can(action, subject(kind, obj))` instead of scattering inline
 * `if (role !== "owner")` checks across handlers.
 *
 * The shape mirrors CASL's `can/cannot` API so this module can be swapped for
 * `@casl/ability` later without changing call sites — but the small surface
 * here means we don't need the runtime engine, the MongoDB-style query DSL,
 * or the type-level subject-with-conditions gymnastics it implies.
 */

export type Action =
  | "view"
  | "edit"
  | "delete"
  | "share"
  | "manage_members"
  | "change_roles"
  | "delete_household";

export type SubjectKind = "Account" | "Household" | "Project";

/**
 * Tagged reference to an entity. Use `subject("Account", { id })` to build.
 *
 * `ownerUserId` is carried for `Project` alone, and the overloads below make it
 * mandatory there and unavailable elsewhere. Accounts and households resolve
 * through the access and membership lists the caller's context already holds; a
 * project resolves through one field on the row, so passing the row's owner is
 * cheaper and more honest than loading every project a user has.
 */
export interface SubjectRef {
  __subjectType: SubjectKind;
  id: string;
  /** `Project` only — who the row belongs to. See `subject`. */
  ownerUserId?: string;
}

/** Wrap a plain object with its subject kind so `ability.can` can dispatch. */
export function subject(kind: "Account" | "Household", obj: { id: string }): SubjectRef;
export function subject(kind: "Project", obj: { id: string; ownerUserId: string }): SubjectRef;
export function subject(kind: SubjectKind, obj: { id: string; ownerUserId?: string }): SubjectRef {
  return kind === "Project"
    ? { __subjectType: kind, id: obj.id, ownerUserId: obj.ownerUserId }
    : { __subjectType: kind, id: obj.id };
}

export interface AppAbility {
  can(action: Action, ref: SubjectRef): boolean;
  cannot(action: Action, ref: SubjectRef): boolean;
  /** Does the user have ANY access to this subject? Drives the 404 leak rule. */
  hasAnyAccess(ref: SubjectRef): boolean;
}

/** Per-account effective access as resolved by Store.listAccessibleAccounts. */
export interface AccountAccessCtx {
  id: string;
  isOwner: boolean;
  permission: "view" | "edit";
}

/** Per-household membership the user holds. */
export interface HouseholdMembershipCtx {
  id: string;
  role: "owner" | "admin" | "member";
}

export interface UserContext {
  userId: string;
  accountAccess: AccountAccessCtx[];
  households: HouseholdMembershipCtx[];
}

const ACCOUNT_OWNER_ACTIONS: readonly Action[] = ["view", "edit", "delete", "share"];

/**
 * What a project's owner may do with it — which today is everything, because
 * owner is the only role a project has.
 *
 * `edit` is what filing a payment into a project asks for, so a project you do
 * not own cannot be named as a payment's `projectId`; `view` drives the detail
 * route, and `hasAnyAccess` its 404. Deliberately a set rather than a bare
 * `ownerUserId === userId`, so the day a project can be shared into a household
 * the second arm lands here — where every caller already asks — instead of
 * becoming a fifth hand-rolled ownership comparison.
 */
const PROJECT_OWNER_ACTIONS: readonly Action[] = ["view", "edit", "delete", "share"];

/** Pure function: same inputs → same allowed set. Inexpensive to call per request. */
export function buildAbility(ctx: UserContext): AppAbility {
  const accountActions = new Map<string, Set<Action>>();
  for (const a of ctx.accountAccess) {
    const actions = new Set<Action>();
    if (a.isOwner) {
      for (const action of ACCOUNT_OWNER_ACTIONS) actions.add(action);
    } else {
      actions.add("view");
      if (a.permission === "edit") actions.add("edit");
    }
    accountActions.set(a.id, actions);
  }

  const householdActions = new Map<string, Set<Action>>();
  for (const h of ctx.households) {
    const actions = new Set<Action>(["view"]);
    if (h.role === "owner" || h.role === "admin") {
      actions.add("manage_members");
    }
    if (h.role === "owner") {
      actions.add("change_roles");
      actions.add("delete_household");
    }
    householdActions.set(h.id, actions);
  }

  // A project is not enumerated ahead of time — its whole authorization is one
  // field on the row the caller already loaded — so it answers from the ref
  // rather than from a map built per request. `undefined` means no access at
  // all, which is what `hasAnyAccess` turns into a 404.
  const projectActions = (ref: SubjectRef): Set<Action> | undefined =>
    ref.ownerUserId !== undefined && ref.ownerUserId === ctx.userId
      ? new Set(PROJECT_OWNER_ACTIONS)
      : undefined;

  const lookup = (ref: SubjectRef): Set<Action> | undefined => {
    if (ref.__subjectType === "Project") return projectActions(ref);
    return (ref.__subjectType === "Account" ? accountActions : householdActions).get(ref.id);
  };

  return {
    can(action, ref) {
      return lookup(ref)?.has(action) ?? false;
    },
    cannot(action, ref) {
      return !this.can(action, ref);
    },
    hasAnyAccess(ref) {
      return lookup(ref) !== undefined;
    },
  };
}
