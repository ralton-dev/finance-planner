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
  /**
   * Put a payment into a project. `Project` only.
   *
   * Deliberately *not* `edit`: filing a payment into a project changes what the
   * project holds without changing the project, and a co-member of a shared one
   * may do the first and never the second. Folding it into `edit` would hand
   * `PATCH /api/projects/:id` — rename, retarget, un-share — to everybody in
   * the household the moment the shared arm below exists.
   */
  | "file_payment"
  | "delete_household";

export type SubjectKind = "Account" | "Household" | "Project";

/**
 * Tagged reference to an entity. Use `subject("Account", { id })` to build.
 *
 * `ownerUserId` and `visibility` are carried for `Project` alone, and the
 * overloads below make them available there and nowhere else. Accounts and
 * households resolve through the access and membership lists the caller's
 * context already holds; a project resolves through two fields on the row, so
 * passing the row is cheaper and more honest than loading every project a user
 * has.
 */
export interface SubjectRef {
  __subjectType: SubjectKind;
  id: string;
  /** `Project` only — who the row belongs to. See `subject`. */
  ownerUserId?: string;
  /** `Project` only — personal, or shared into the owner's household. Absent
   *  reads as personal, which is the row's own default. */
  visibility?: ProjectVisibility;
}

/** Structural copy of `@finance-planner/data`'s union. This package deliberately
 *  depends on nothing, and a project row satisfies it as it stands. */
export type ProjectVisibility = "personal" | "shared";

/** Wrap a plain object with its subject kind so `ability.can` can dispatch. */
export function subject(kind: "Account" | "Household", obj: { id: string }): SubjectRef;
export function subject(
  kind: "Project",
  obj: { id: string; ownerUserId: string; visibility?: ProjectVisibility },
): SubjectRef;
export function subject(
  kind: SubjectKind,
  obj: { id: string; ownerUserId?: string; visibility?: ProjectVisibility },
): SubjectRef {
  return kind === "Project"
    ? {
        __subjectType: kind,
        id: obj.id,
        ownerUserId: obj.ownerUserId,
        visibility: obj.visibility ?? "personal",
      }
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
  /**
   * Everybody who shares a household with this user, themselves excluded — the
   * audience of a **shared** project (MINE-AND-OURS decision 22).
   *
   * Optional and empty by default, because it costs two queries a request and
   * only the two project gates ask for it. Empty means a shared project reaches
   * nobody but its owner, which is exactly right for a user with no household.
   */
  householdMemberIds?: readonly string[];
}

const ACCOUNT_OWNER_ACTIONS: readonly Action[] = ["view", "edit", "delete", "share"];

/**
 * What a project's owner may do with it — everything, because owner is still
 * the only role a project's *row* has.
 *
 * `file_payment` is what filing a payment into a project asks for; `view`
 * drives the detail route, and `hasAnyAccess` its 404.
 */
const PROJECT_OWNER_ACTIONS: readonly Action[] = [
  "view",
  "edit",
  "delete",
  "share",
  "file_payment",
];

/**
 * The second arm this set was always a set for: what a **co-member of the
 * owner's household** may do with a project shared into it (decision 22).
 *
 * Read it and put your own payments in it; never rename it, delete it, or
 * un-share it. `edit`, `delete` and `share` are therefore absent, and their
 * absence is load-bearing — `PATCH`/`DELETE /api/projects/:id` ask for `edit`
 * and `delete`, so a co-member meets a 403 there, which is honest to somebody
 * who can already see the project exists.
 */
const PROJECT_SHARED_MEMBER_ACTIONS: readonly Action[] = ["view", "file_payment"];

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

  // A project is not enumerated ahead of time — its whole authorization is two
  // fields on the row the caller already loaded — so it answers from the ref
  // rather than from a map built per request. `undefined` means no access at
  // all, which is what `hasAnyAccess` turns into a 404.
  //
  // "Shared" is resolved here and now, against the roster as it stands: a
  // project's audience is not stored anywhere, so an owner who leaves the
  // household stops sharing with it between one request and the next.
  const coMembers = new Set(ctx.householdMemberIds ?? []);
  const projectActions = (ref: SubjectRef): Set<Action> | undefined => {
    if (ref.ownerUserId === undefined) return undefined;
    if (ref.ownerUserId === ctx.userId) return new Set(PROJECT_OWNER_ACTIONS);
    if (ref.visibility === "shared" && coMembers.has(ref.ownerUserId)) {
      return new Set(PROJECT_SHARED_MEMBER_ACTIONS);
    }
    return undefined;
  };

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
