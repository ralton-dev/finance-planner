import type {
  AccountRole,
  Frequency,
  PaymentCategory,
  PaymentScope,
  Recurrence,
} from "@finance-planner/contracts";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "./db.js";
import type {
  Account,
  AccountShare,
  BalanceSnapshot,
  Contribution,
  EmailVerificationToken,
  Household,
  HouseholdAccountAssignment,
  HouseholdMembership,
  HouseholdRole,
  Income,
  Inflow,
  InflowSourceKind,
  MonthClose,
  PasswordResetToken,
  Payment,
  PlanSnapshot,
  Project,
  ProjectVisibility,
  RecoveryCode,
  Session,
  SharePermission,
  TransferConfirmation,
  User,
  UserStatus,
} from "./entities.js";
import * as s from "./schema.js";
import {
  type AccountAccess,
  type AccountPatch,
  assertInflowShape,
  type ContributionTotal,
  HouseholdExclusivityError,
  type MonthCloseScope,
  type NewAccount,
  type NewAccountAssignment,
  type NewBalanceSnapshot,
  type NewContribution,
  type NewIncome,
  type NewInflow,
  type NewMonthClose,
  type NewPayment,
  type NewProject,
  type NewTransferConfirmation,
  type NewUser,
  type Store,
  toIncome,
} from "./store.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const rec = (v: unknown): Recurrence | null => (v as Recurrence | null) ?? null;

function mapUser(r: typeof s.users.$inferSelect): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.passwordHash ?? null,
    displayName: r.displayName,
    status: r.status as UserStatus,
    emailVerified: r.emailVerified,
    totpSecret: r.totpSecret ?? null,
    totpEnabledAt: iso(r.totpEnabledAt),
    notifyEmail: r.notifyEmail,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapRecoveryCode(r: typeof s.recoveryCodes.$inferSelect): RecoveryCode {
  return {
    id: r.id,
    userId: r.userId,
    codeHash: r.codeHash,
    usedAt: iso(r.usedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

function mapMembership(r: typeof s.memberships.$inferSelect): HouseholdMembership {
  return {
    id: r.id,
    householdId: r.householdId,
    userId: r.userId,
    role: r.role as HouseholdRole,
    contributionShareBp: r.contributionShareBp,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapAssignment(
  r: typeof s.householdAccountAssignments.$inferSelect,
): HouseholdAccountAssignment {
  return {
    id: r.id,
    householdId: r.householdId,
    accountId: r.accountId,
    role: r.role as AccountRole,
    memberUserId: r.memberUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Postgres-backed Store via Drizzle. Production persistence. */
export class PgStore implements Store {
  constructor(private readonly db: Database) {}

  async createUser(input: NewUser): Promise<User> {
    const [row] = await this.db
      .insert(s.users)
      .values({
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        displayName: input.displayName,
      })
      .returning();
    return mapUser(row!);
  }

  async getUserById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(s.users).where(eq(s.users.id, id));
    return row ? mapUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(s.users)
      .where(eq(s.users.email, email.toLowerCase()));
    return row ? mapUser(row) : null;
  }

  async setUserVerified(id: string): Promise<void> {
    await this.db.update(s.users).set({ emailVerified: true }).where(eq(s.users.id, id));
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(s.users).set({ passwordHash }).where(eq(s.users.id, userId));
  }

  async setUserNotifyEmail(userId: string, on: boolean): Promise<void> {
    await this.db.update(s.users).set({ notifyEmail: on }).where(eq(s.users.id, userId));
  }

  async listUsersWithNotifications(): Promise<User[]> {
    const rows = await this.db
      .select()
      .from(s.users)
      .where(eq(s.users.notifyEmail, true))
      .orderBy(asc(s.users.createdAt));
    return rows.map(mapUser);
  }

  async deleteUserCascade(userId: string): Promise<void> {
    // Owned accounts first — deleteAccount already clears everything hanging off
    // one. Accounts shared *with* this user are untouched: they are their
    // owners', and the share dies with the membership below.
    const owned = await this.db
      .select({ id: s.accounts.id })
      .from(s.accounts)
      .where(eq(s.accounts.ownerUserId, userId));
    for (const a of owned) await this.deleteAccount(a.id);

    await this.db.delete(s.projects).where(eq(s.projects.ownerUserId, userId));

    const founded = await this.db
      .select({ id: s.households.id })
      .from(s.households)
      .where(eq(s.households.createdBy, userId));
    for (const h of founded) await this.deleteHousehold(h.id);

    // Their own scorecards. The FK cascades on the user delete below; explicit
    // for parity with MemoryStore, as with the notification log.
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.userId, userId));

    await this.db.delete(s.memberships).where(eq(s.memberships.userId, userId));
    await this.db.delete(s.sessions).where(eq(s.sessions.userId, userId));
    await this.db
      .delete(s.emailVerificationTokens)
      .where(eq(s.emailVerificationTokens.userId, userId));
    await this.db.delete(s.passwordResetTokens).where(eq(s.passwordResetTokens.userId, userId));
    await this.db.delete(s.recoveryCodes).where(eq(s.recoveryCodes.userId, userId));
    await this.db.delete(s.notificationLog).where(eq(s.notificationLog.userId, userId));
    await this.db.delete(s.users).where(eq(s.users.id, userId));
  }

  async setUserTotpSecret(userId: string, secret: string | null): Promise<void> {
    // Clearing the secret must also clear the flag: no secret, no second factor.
    await this.db
      .update(s.users)
      .set(secret === null ? { totpSecret: null, totpEnabledAt: null } : { totpSecret: secret })
      .where(eq(s.users.id, userId));
  }

  async enableUserTotp(userId: string): Promise<void> {
    await this.db.update(s.users).set({ totpEnabledAt: new Date() }).where(eq(s.users.id, userId));
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    await this.db.delete(s.recoveryCodes).where(eq(s.recoveryCodes.userId, userId));
    if (codeHashes.length === 0) return;
    await this.db
      .insert(s.recoveryCodes)
      .values(codeHashes.map((codeHash) => ({ userId, codeHash })));
  }

  async listUnusedRecoveryCodes(userId: string): Promise<RecoveryCode[]> {
    const rows = await this.db
      .select()
      .from(s.recoveryCodes)
      .where(and(eq(s.recoveryCodes.userId, userId), isNull(s.recoveryCodes.usedAt)))
      .orderBy(asc(s.recoveryCodes.createdAt));
    return rows.map(mapRecoveryCode);
  }

  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    // The WHERE clause is the guard: a spent code updates zero rows.
    const rows = await this.db
      .update(s.recoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(s.recoveryCodes.userId, userId),
          eq(s.recoveryCodes.codeHash, codeHash),
          isNull(s.recoveryCodes.usedAt),
        ),
      )
      .returning({ id: s.recoveryCodes.id });
    return rows.length > 0;
  }

  async createSession(session: Omit<Session, "id" | "createdAt" | "revokedAt">): Promise<Session> {
    const [row] = await this.db
      .insert(s.sessions)
      .values({
        userId: session.userId,
        refreshTokenHash: session.refreshTokenHash,
        expiresAt: new Date(session.expiresAt),
      })
      .returning();
    return {
      id: row!.id,
      userId: row!.userId,
      refreshTokenHash: row!.refreshTokenHash,
      expiresAt: row!.expiresAt.toISOString(),
      revokedAt: iso(row!.revokedAt),
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async getSessionByTokenHash(hash: string): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.refreshTokenHash, hash));
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      refreshTokenHash: row.refreshTokenHash,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async revokeSession(id: string): Promise<void> {
    await this.db.update(s.sessions).set({ revokedAt: new Date() }).where(eq(s.sessions.id, id));
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.db
      .update(s.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt)));
  }

  async createEmailVerificationToken(token: EmailVerificationToken): Promise<void> {
    await this.db.insert(s.emailVerificationTokens).values({
      token: token.token,
      userId: token.userId,
      expiresAt: new Date(token.expiresAt),
    });
  }

  async consumeEmailVerificationToken(token: string): Promise<EmailVerificationToken | null> {
    const [row] = await this.db
      .select()
      .from(s.emailVerificationTokens)
      .where(eq(s.emailVerificationTokens.token, token));
    if (!row) return null;
    await this.db
      .delete(s.emailVerificationTokens)
      .where(eq(s.emailVerificationTokens.token, token));
    return { token: row.token, userId: row.userId, expiresAt: row.expiresAt.toISOString() };
  }

  async createPasswordResetToken(token: PasswordResetToken): Promise<void> {
    await this.db.insert(s.passwordResetTokens).values({
      token: token.token,
      userId: token.userId,
      expiresAt: new Date(token.expiresAt),
    });
  }

  async consumePasswordResetToken(token: string): Promise<PasswordResetToken | null> {
    // Delete-and-return keeps it single-use even under concurrent redemption.
    const [row] = await this.db
      .delete(s.passwordResetTokens)
      .where(eq(s.passwordResetTokens.token, token))
      .returning();
    if (!row) return null;
    return { token: row.token, userId: row.userId, expiresAt: row.expiresAt.toISOString() };
  }

  /**
   * The household this user is already in, if any — the exclusivity rule's one
   * question. `exceptHouseholdId` is the household being joined, which is never
   * an answer to it.
   *
   * The same rule lives in the database as a trigger
   * (`0011_one_household_per_user.sql`), which is the floor under this and
   * catches a write that never came through here. Asking first is what turns
   * it into a readable refusal instead of a raw SQLSTATE 23505.
   */
  private async otherHouseholdOf(
    userId: string,
    exceptHouseholdId?: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ householdId: s.memberships.householdId })
      .from(s.memberships)
      .where(
        exceptHouseholdId
          ? and(eq(s.memberships.userId, userId), ne(s.memberships.householdId, exceptHouseholdId))
          : eq(s.memberships.userId, userId),
      )
      .limit(1);
    return row?.householdId ?? null;
  }

  async createHousehold(name: string, createdBy: string): Promise<Household> {
    // Before the row, not after: a household whose founder was refused
    // membership would be an orphan nobody could reach or delete.
    const already = await this.otherHouseholdOf(createdBy);
    if (already) throw new HouseholdExclusivityError(createdBy, already);
    const [row] = await this.db.insert(s.households).values({ name, createdBy }).returning();
    await this.addMembership(row!.id, createdBy, "owner");
    return {
      id: row!.id,
      name: row!.name,
      createdBy: row!.createdBy,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async getHousehold(id: string): Promise<Household | null> {
    const [row] = await this.db.select().from(s.households).where(eq(s.households.id, id));
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async deleteHousehold(id: string): Promise<void> {
    // Every member leaves at once, so a movement that only existed because two
    // people were in this household stops claiming money — the same dissolution
    // `removeMember` performs, for everybody.
    for (const m of await this.listMembersForHousehold(id)) {
      await this.dissolveMembershipBenefits(id, m.userId);
    }
    // account_shares + assignments live in other schemas with no FK back to
    // households, so wipe them first; memberships cascade via ON DELETE CASCADE.
    // Whatever shares are left are of accounts whose owner is no longer a
    // member, so the loop above did not reach them. They take their
    // shared-project links with them the same way.
    const orphanShares = await this.db
      .delete(s.accountShares)
      .where(eq(s.accountShares.householdId, id))
      .returning({ accountId: s.accountShares.accountId });
    for (const o of orphanShares) await this.clearProjectLinksForAccount(o.accountId);
    await this.db
      .delete(s.householdAccountAssignments)
      .where(eq(s.householdAccountAssignments.householdId, id));
    // Confirmations (and their linked contributions, via FK cascade) + closes
    // have no FK to households either.
    const confs = await this.db
      .select({ id: s.transferConfirmations.id })
      .from(s.transferConfirmations)
      .where(eq(s.transferConfirmations.householdId, id));
    for (const c of confs) await this.deleteTransferConfirmation(c.id);
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.householdId, id));
    await this.db.delete(s.households).where(eq(s.households.id, id));
  }

  async listHouseholdsForUser(userId: string): Promise<Household[]> {
    const rows = await this.db
      .select({ h: s.households })
      .from(s.memberships)
      .innerJoin(s.households, eq(s.households.id, s.memberships.householdId))
      .where(eq(s.memberships.userId, userId))
      .orderBy(asc(s.memberships.createdAt), asc(s.memberships.id));
    return rows.map(({ h }) => ({
      id: h.id,
      name: h.name,
      createdBy: h.createdBy,
      createdAt: h.createdAt.toISOString(),
    }));
  }

  async addMembership(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership> {
    const already = await this.otherHouseholdOf(userId, householdId);
    if (already) throw new HouseholdExclusivityError(userId, already);
    const [row] = await this.db
      .insert(s.memberships)
      .values({ householdId, userId, role })
      .returning();
    return mapMembership(row!);
  }

  async getMembership(householdId: string, userId: string): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .select()
      .from(s.memberships)
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)));
    return row ? mapMembership(row) : null;
  }

  async listMembersForHousehold(householdId: string): Promise<HouseholdMembership[]> {
    const rows = await this.db
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.householdId, householdId));
    return rows.map(mapMembership);
  }

  async removeMember(householdId: string, userId: string): Promise<void> {
    await this.dissolveMembershipBenefits(householdId, userId);
    await this.db
      .delete(s.memberships)
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)));
  }

  /**
   * Steps 1–4 of the departure cascade (see `Store.removeMember`). Called
   * while the membership still stands, so the ordering guarantee holds: at no
   * point is a non-member's account still attached to the household.
   *
   * Reads the two account sets into memory rather than expressing them as
   * subqueries. A household is a handful of people holding a handful of
   * accounts, so the round trips are trivial and the statements stay legible —
   * the same trade `deleteHousehold` already makes for confirmations.
   *
   * Idempotent, so `deleteHousehold` may run it for every member in turn and
   * `removeMember` may run it for a membership that has already gone.
   */
  private async dissolveMembershipBenefits(householdId: string, userId: string): Promise<void> {
    const mine = (await this.listAccountsForOwner(userId)).map((a) => a.id);
    const otherOwners = (await this.listMembersForHousehold(householdId))
      .map((m) => m.userId)
      .filter((id) => id !== userId);
    const theirs = (
      await Promise.all(otherOwners.map((id) => this.listAccountsForOwner(id)))
    ).flatMap((accounts) => accounts.map((a) => a.id));

    // 1. Their shared projects come back personal, stripped of everything on an
    //    account they do not own. Before step 4, and that ordering is
    //    load-bearing — see `Store.removeMember`.
    const sharedOfTheirs = await this.db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(eq(s.projects.ownerUserId, userId), eq(s.projects.visibility, "shared")));
    if (sharedOfTheirs.length > 0) {
      const projectIds = sharedOfTheirs.map((p) => p.id);
      await this.db
        .update(s.payments)
        .set({ projectId: null, updatedAt: new Date() })
        .where(
          mine.length > 0
            ? and(inArray(s.payments.projectId, projectIds), notInArray(s.payments.accountId, mine))
            : inArray(s.payments.projectId, projectIds),
        );
      await this.db
        .update(s.projects)
        .set({ visibility: "personal", updatedAt: new Date() })
        .where(inArray(s.projects.id, projectIds));
    }

    // 2. Movements across the boundary: deactivated, never deleted. The row's
    //    confirmations — and the contributions they booked — are the record of
    //    money that really moved, and deleting the inflow would cascade them
    //    away (0009). An inactive inflow is not a funding edge and funds
    //    nothing, so the forward-looking claim dissolves and the history stays.
    if (mine.length > 0 && theirs.length > 0) {
      await this.db
        .update(s.inflows)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(s.inflows.source, "account"),
            eq(s.inflows.active, true),
            or(
              and(inArray(s.inflows.accountId, mine), inArray(s.inflows.sourceAccountId, theirs)),
              and(inArray(s.inflows.sourceAccountId, mine), inArray(s.inflows.accountId, theirs)),
            ),
          ),
        );
    }

    // 3. Plan roles: their accounts' roles here, and any role naming them as
    //    the member a personal account belongs to.
    if (mine.length > 0) {
      await this.db
        .delete(s.householdAccountAssignments)
        .where(
          and(
            eq(s.householdAccountAssignments.householdId, householdId),
            inArray(s.householdAccountAssignments.accountId, mine),
          ),
        );
    }
    await this.db
      .delete(s.householdAccountAssignments)
      .where(
        and(
          eq(s.householdAccountAssignments.householdId, householdId),
          eq(s.householdAccountAssignments.memberUserId, userId),
        ),
      );

    // 4. Access grants of their accounts into this household, each taking that
    //    account's payments out of every shared project with it. What the
    //    household shared with *them* needs nothing: that access was their
    //    membership, and the membership is about to go.
    if (mine.length > 0) {
      const gone = await this.db
        .delete(s.accountShares)
        .where(
          and(
            eq(s.accountShares.householdId, householdId),
            inArray(s.accountShares.accountId, mine),
          ),
        )
        .returning({ accountId: s.accountShares.accountId });
      for (const g of gone) await this.clearProjectLinksForAccount(g.accountId);
    }
  }

  async updateMembershipRole(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .update(s.memberships)
      .set({ role })
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)))
      .returning();
    return row ? mapMembership(row) : null;
  }

  async updateMembershipShare(
    householdId: string,
    userId: string,
    shareBp: number,
  ): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .update(s.memberships)
      .set({ contributionShareBp: shareBp })
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)))
      .returning();
    return row ? mapMembership(row) : null;
  }

  async upsertAccountAssignment(input: NewAccountAssignment): Promise<HouseholdAccountAssignment> {
    const existing = await this.getAccountAssignment(input.householdId, input.accountId);
    if (existing) {
      const [row] = await this.db
        .update(s.householdAccountAssignments)
        .set({ role: input.role, memberUserId: input.memberUserId, updatedAt: new Date() })
        .where(eq(s.householdAccountAssignments.id, existing.id))
        .returning();
      return mapAssignment(row!);
    }
    const [row] = await this.db
      .insert(s.householdAccountAssignments)
      .values({
        householdId: input.householdId,
        accountId: input.accountId,
        role: input.role,
        memberUserId: input.memberUserId,
      })
      .returning();
    return mapAssignment(row!);
  }

  async listAccountAssignments(householdId: string): Promise<HouseholdAccountAssignment[]> {
    const rows = await this.db
      .select()
      .from(s.householdAccountAssignments)
      .where(eq(s.householdAccountAssignments.householdId, householdId));
    return rows.map(mapAssignment);
  }

  async getAccountAssignment(
    householdId: string,
    accountId: string,
  ): Promise<HouseholdAccountAssignment | null> {
    const [row] = await this.db
      .select()
      .from(s.householdAccountAssignments)
      .where(
        and(
          eq(s.householdAccountAssignments.householdId, householdId),
          eq(s.householdAccountAssignments.accountId, accountId),
        ),
      );
    return row ? mapAssignment(row) : null;
  }

  async deleteAccountAssignment(householdId: string, accountId: string): Promise<void> {
    await this.db
      .delete(s.householdAccountAssignments)
      .where(
        and(
          eq(s.householdAccountAssignments.householdId, householdId),
          eq(s.householdAccountAssignments.accountId, accountId),
        ),
      );
  }

  async listSharesForHousehold(householdId: string): Promise<AccountShare[]> {
    const rows = await this.db
      .select()
      .from(s.accountShares)
      .where(eq(s.accountShares.householdId, householdId));
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      householdId: r.householdId,
      permission: r.permission as SharePermission,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createAccountShare(
    accountId: string,
    householdId: string,
    permission: SharePermission,
  ): Promise<AccountShare> {
    const [row] = await this.db
      .insert(s.accountShares)
      .values({ accountId, householdId, permission })
      .returning();
    return {
      id: row!.id,
      accountId: row!.accountId,
      householdId: row!.householdId,
      permission: row!.permission as SharePermission,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async listSharesForAccount(accountId: string): Promise<AccountShare[]> {
    const rows = await this.db
      .select()
      .from(s.accountShares)
      .where(eq(s.accountShares.accountId, accountId));
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      householdId: r.householdId,
      permission: r.permission as SharePermission,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async deleteAccountShare(id: string): Promise<void> {
    const [share] = await this.db
      .select({ accountId: s.accountShares.accountId })
      .from(s.accountShares)
      .where(eq(s.accountShares.id, id));
    await this.db.delete(s.accountShares).where(eq(s.accountShares.id, id));
    // An account nobody in the household can see has no business in a shared
    // project (see `Store.deleteAccountShare`).
    if (share) await this.clearProjectLinksForAccount(share.accountId);
  }

  async listAccessibleAccounts(userId: string): Promise<AccountAccess[]> {
    const result = new Map<string, AccountAccess>();
    const owned = await this.db
      .select({ id: s.accounts.id })
      .from(s.accounts)
      .where(eq(s.accounts.ownerUserId, userId));
    for (const o of owned) result.set(o.id, { accountId: o.id, permission: "edit", owner: true });

    const shared = await this.db
      .select({ accountId: s.accountShares.accountId, permission: s.accountShares.permission })
      .from(s.memberships)
      .innerJoin(s.accountShares, eq(s.accountShares.householdId, s.memberships.householdId))
      .where(eq(s.memberships.userId, userId));
    for (const sh of shared) {
      const existing = result.get(sh.accountId);
      if (existing?.owner) continue;
      const perm = sh.permission as SharePermission;
      if (!existing || (existing.permission === "view" && perm === "edit")) {
        result.set(sh.accountId, { accountId: sh.accountId, permission: perm, owner: false });
      }
    }
    return [...result.values()];
  }

  async getAccess(userId: string, accountId: string): Promise<AccountAccess | null> {
    const all = await this.listAccessibleAccounts(userId);
    return all.find((a) => a.accountId === accountId) ?? null;
  }

  async createAccount(input: NewAccount): Promise<Account> {
    const [row] = await this.db
      .insert(s.accounts)
      .values({
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description ?? null,
        currency: input.currency,
        openingBalanceMinor: input.openingBalanceMinor ?? 0,
        monthlyBufferMinor: input.monthlyBufferMinor ?? 0,
      })
      .returning();
    return this.mapAccount(row!);
  }

  async getAccount(id: string): Promise<Account | null> {
    const [row] = await this.db.select().from(s.accounts).where(eq(s.accounts.id, id));
    return row ? this.mapAccount(row) : null;
  }

  async listAccountsForOwner(ownerUserId: string): Promise<Account[]> {
    const rows = await this.db
      .select()
      .from(s.accounts)
      .where(eq(s.accounts.ownerUserId, ownerUserId));
    return rows.map((r) => this.mapAccount(r));
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<Account | null> {
    const [row] = await this.db
      .update(s.accounts)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        // No `currency`: an account is denominated once, when it is created, so
        // the column never appears in a SET clause and
        // `accounts_currency_is_fixed` (0012) never has cause to fire.
        ...(patch.openingBalanceMinor !== undefined
          ? { openingBalanceMinor: patch.openingBalanceMinor }
          : {}),
        ...(patch.monthlyBufferMinor !== undefined
          ? { monthlyBufferMinor: patch.monthlyBufferMinor }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.accounts.id, id))
      .returning();
    return row ? this.mapAccount(row) : null;
  }

  async deleteAccount(id: string): Promise<void> {
    await this.db.delete(s.contributions).where(eq(s.contributions.accountId, id));
    await this.db.delete(s.balanceSnapshots).where(eq(s.balanceSnapshots.accountId, id));
    await this.db
      .delete(s.transferConfirmations)
      .where(
        or(
          eq(s.transferConfirmations.fromAccountId, id),
          eq(s.transferConfirmations.toAccountId, id),
        ),
      );
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.accountId, id));
    // Both faces of an inflow: what arrived here, and what this account sent
    // elsewhere. Either FK would cascade; stay explicit like the rest.
    await this.db
      .delete(s.inflows)
      .where(or(eq(s.inflows.accountId, id), eq(s.inflows.sourceAccountId, id)));
    await this.db.delete(s.payments).where(eq(s.payments.accountId, id));
    await this.db.delete(s.accountShares).where(eq(s.accountShares.accountId, id));
    await this.db
      .delete(s.householdAccountAssignments)
      .where(eq(s.householdAccountAssignments.accountId, id));
    await this.db.delete(s.accounts).where(eq(s.accounts.id, id));
  }

  async createInflow(input: NewInflow): Promise<Inflow> {
    // Checked here as well as by the table's CHECKs, so both stores refuse the
    // same rows with the same error rather than one of them raising a driver
    // exception the caller cannot read.
    assertInflowShape(input);
    const [row] = await this.db
      .insert(s.inflows)
      .values({
        accountId: input.accountId,
        name: input.name,
        source: input.source,
        sourceAccountId: input.sourceAccountId,
        amountMinor: input.amountMinor,
        frequency: input.frequency,
        recurrence: input.recurrence,
        anchorDate: input.anchorDate,
        priority: input.priority,
        active: input.active,
      })
      .returning();
    return this.mapInflow(row!);
  }

  async getInflow(id: string): Promise<Inflow | null> {
    const [row] = await this.db.select().from(s.inflows).where(eq(s.inflows.id, id));
    return row ? this.mapInflow(row) : null;
  }

  async listInflows(accountId: string): Promise<Inflow[]> {
    const rows = await this.db
      .select()
      .from(s.inflows)
      .where(eq(s.inflows.accountId, accountId))
      .orderBy(asc(s.inflows.priority), asc(s.inflows.createdAt));
    return rows.map((r) => this.mapInflow(r));
  }

  async listOutboundInflows(accountId: string): Promise<Inflow[]> {
    const rows = await this.db
      .select()
      .from(s.inflows)
      .where(eq(s.inflows.sourceAccountId, accountId))
      .orderBy(asc(s.inflows.priority), asc(s.inflows.createdAt));
    return rows.map((r) => this.mapInflow(r));
  }

  async updateInflow(id: string, patch: Partial<NewInflow>): Promise<Inflow | null> {
    const current = await this.getInflow(id);
    if (!current) return null;
    // Validate the row the patch produces, not the patch: the CHECKs constrain
    // `source` and `source_account_id` together, so neither can be judged alone.
    assertInflowShape({ ...current, ...stripUndefined(patch) });
    const [row] = await this.db
      .update(s.inflows)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(s.inflows.id, id))
      .returning();
    return row ? this.mapInflow(row) : null;
  }

  async deleteInflow(id: string): Promise<void> {
    await this.db.delete(s.inflows).where(eq(s.inflows.id, id));
  }

  async createIncome(input: NewIncome): Promise<Income> {
    return toIncome(
      await this.createInflow({
        ...input,
        source: "external",
        sourceAccountId: null,
        priority: 100,
      }),
    );
  }

  async getIncome(id: string): Promise<Income | null> {
    const [row] = await this.db
      .select()
      .from(s.inflows)
      .where(and(eq(s.inflows.id, id), eq(s.inflows.source, "external")));
    return row ? toIncome(this.mapInflow(row)) : null;
  }

  async listIncomes(accountId: string): Promise<Income[]> {
    const rows = await this.db
      .select()
      .from(s.inflows)
      .where(and(eq(s.inflows.accountId, accountId), eq(s.inflows.source, "external")))
      .orderBy(asc(s.inflows.priority), asc(s.inflows.createdAt));
    return rows.map((r) => toIncome(this.mapInflow(r)));
  }

  async updateIncome(id: string, patch: Partial<NewIncome>): Promise<Income | null> {
    if (!(await this.getIncome(id))) return null;
    const updated = await this.updateInflow(id, patch);
    return updated ? toIncome(updated) : null;
  }

  async deleteIncome(id: string): Promise<void> {
    await this.db
      .delete(s.inflows)
      .where(and(eq(s.inflows.id, id), eq(s.inflows.source, "external")));
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const [row] = await this.db
      .insert(s.payments)
      .values({
        accountId: input.accountId,
        name: input.name,
        category: input.category,
        amountMinor: input.amountMinor,
        dueDate: input.dueDate,
        recurrence: input.recurrence,
        targetDate: input.targetDate,
        priority: input.priority,
        alreadySavedMinor: input.alreadySavedMinor,
        autoRenew: input.autoRenew,
        active: input.active,
        notes: input.notes,
        projectId: input.projectId,
        scope: input.scope,
        bearerUserId: input.bearerUserId,
        fixedMonthlyMinor: input.fixedMonthlyMinor,
        tag: input.tag,
      })
      .returning();
    return this.mapPayment(row!);
  }

  async getPayment(id: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(s.payments).where(eq(s.payments.id, id));
    return row ? this.mapPayment(row) : null;
  }

  async listPayments(accountId: string): Promise<Payment[]> {
    const rows = await this.db.select().from(s.payments).where(eq(s.payments.accountId, accountId));
    return rows.map((r) => this.mapPayment(r));
  }

  async updatePayment(id: string, patch: Partial<NewPayment>): Promise<Payment | null> {
    const [row] = await this.db
      .update(s.payments)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(s.payments.id, id))
      .returning();
    return row ? this.mapPayment(row) : null;
  }

  async deletePayment(id: string): Promise<void> {
    // contributions cascade via their FK, but stay explicit like the rest.
    await this.db.delete(s.contributions).where(eq(s.contributions.paymentId, id));
    await this.db.delete(s.payments).where(eq(s.payments.id, id));
  }

  async reorderPayments(accountId: string, orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      await this.db
        .update(s.payments)
        .set({ priority: i + 1, updatedAt: new Date() })
        .where(and(eq(s.payments.id, orderedIds[i]!), eq(s.payments.accountId, accountId)));
    }
  }

  async tryLogNotification(userId: string, date: string, kind: string): Promise<boolean> {
    // The unique index does the arbitration: the loser of a race inserts zero
    // rows and is told "already sent" rather than sending a second email.
    const rows = await this.db
      .insert(s.notificationLog)
      .values({ userId, date, kind })
      .onConflictDoNothing({
        target: [s.notificationLog.userId, s.notificationLog.date, s.notificationLog.kind],
      })
      .returning({ id: s.notificationLog.id });
    return rows.length > 0;
  }

  async saveSnapshot(snapshot: Omit<PlanSnapshot, "id" | "computedAt">): Promise<PlanSnapshot> {
    const [row] = await this.db
      .insert(s.planSnapshots)
      .values({
        accountId: snapshot.accountId,
        asOfDate: snapshot.asOfDate,
        inputsHash: snapshot.inputsHash,
        detail: snapshot.detail,
      })
      .returning();
    return {
      id: row!.id,
      accountId: row!.accountId,
      computedAt: row!.computedAt.toISOString(),
      asOfDate: row!.asOfDate,
      inputsHash: row!.inputsHash,
      detail: row!.detail,
    };
  }

  async createContribution(input: NewContribution): Promise<Contribution> {
    const [row] = await this.db
      .insert(s.contributions)
      .values({
        paymentId: input.paymentId,
        accountId: input.accountId,
        userId: input.userId,
        month: input.month,
        amountMinor: input.amountMinor,
        note: input.note,
        transferConfirmationId: input.transferConfirmationId,
      })
      .returning();
    return mapContribution(row!);
  }

  async getContribution(id: string): Promise<Contribution | null> {
    const [row] = await this.db.select().from(s.contributions).where(eq(s.contributions.id, id));
    return row ? mapContribution(row) : null;
  }

  async listContributionsForAccount(accountId: string, month?: string): Promise<Contribution[]> {
    const rows = await this.db
      .select()
      .from(s.contributions)
      .where(
        month
          ? and(eq(s.contributions.accountId, accountId), eq(s.contributions.month, month))
          : eq(s.contributions.accountId, accountId),
      )
      .orderBy(asc(s.contributions.createdAt));
    return rows.map(mapContribution);
  }

  async sumContributionsByPayment(accountId: string): Promise<ContributionTotal[]> {
    const rows = await this.db
      .select({
        paymentId: s.contributions.paymentId,
        total: sql<string>`coalesce(sum(${s.contributions.amountMinor}), 0)`,
      })
      .from(s.contributions)
      .where(eq(s.contributions.accountId, accountId))
      .groupBy(s.contributions.paymentId);
    return rows.map((r) => ({ paymentId: r.paymentId, totalMinor: Number(r.total) }));
  }

  async deleteContribution(id: string): Promise<void> {
    await this.db.delete(s.contributions).where(eq(s.contributions.id, id));
  }

  async upsertBalanceSnapshot(input: NewBalanceSnapshot): Promise<BalanceSnapshot> {
    const [row] = await this.db
      .insert(s.balanceSnapshots)
      .values({
        accountId: input.accountId,
        asOfDate: input.asOfDate,
        balanceMinor: input.balanceMinor,
      })
      .onConflictDoUpdate({
        target: [s.balanceSnapshots.accountId, s.balanceSnapshots.asOfDate],
        set: { balanceMinor: input.balanceMinor },
      })
      .returning();
    return mapBalanceSnapshot(row!);
  }

  async listBalanceSnapshots(accountId: string): Promise<BalanceSnapshot[]> {
    const rows = await this.db
      .select()
      .from(s.balanceSnapshots)
      .where(eq(s.balanceSnapshots.accountId, accountId))
      .orderBy(asc(s.balanceSnapshots.asOfDate));
    return rows.map(mapBalanceSnapshot);
  }

  async createTransferConfirmation(input: NewTransferConfirmation): Promise<TransferConfirmation> {
    const [row] = await this.db
      .insert(s.transferConfirmations)
      .values({
        householdId: input.householdId,
        inflowId: input.inflowId,
        month: input.month,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        memberUserId: input.memberUserId,
        amountMinor: input.amountMinor,
      })
      .returning();
    return mapTransferConfirmation(row!);
  }

  async getTransferConfirmation(id: string): Promise<TransferConfirmation | null> {
    const [row] = await this.db
      .select()
      .from(s.transferConfirmations)
      .where(eq(s.transferConfirmations.id, id));
    return row ? mapTransferConfirmation(row) : null;
  }

  async listTransferConfirmations(
    householdId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    const rows = await this.db
      .select()
      .from(s.transferConfirmations)
      .where(
        and(
          eq(s.transferConfirmations.householdId, householdId),
          eq(s.transferConfirmations.month, month),
        ),
      )
      .orderBy(asc(s.transferConfirmations.createdAt));
    return rows.map(mapTransferConfirmation);
  }

  async listTransferConfirmationsForAccount(
    accountId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    const rows = await this.db
      .select()
      .from(s.transferConfirmations)
      .where(
        and(
          isNotNull(s.transferConfirmations.inflowId),
          eq(s.transferConfirmations.month, month),
          or(
            eq(s.transferConfirmations.fromAccountId, accountId),
            eq(s.transferConfirmations.toAccountId, accountId),
          ),
        ),
      )
      .orderBy(asc(s.transferConfirmations.createdAt));
    return rows.map(mapTransferConfirmation);
  }

  async listDerivedTransferConfirmationsForAccount(
    accountId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    const rows = await this.db
      .select()
      .from(s.transferConfirmations)
      .where(
        and(
          isNull(s.transferConfirmations.householdId),
          isNull(s.transferConfirmations.inflowId),
          eq(s.transferConfirmations.month, month),
          or(
            eq(s.transferConfirmations.fromAccountId, accountId),
            eq(s.transferConfirmations.toAccountId, accountId),
          ),
        ),
      )
      .orderBy(asc(s.transferConfirmations.createdAt));
    return rows.map(mapTransferConfirmation);
  }

  async deleteTransferConfirmation(id: string): Promise<void> {
    // Linked contributions cascade via FK; stay explicit for parity with
    // MemoryStore semantics.
    await this.db.delete(s.contributions).where(eq(s.contributions.transferConfirmationId, id));
    await this.db.delete(s.transferConfirmations).where(eq(s.transferConfirmations.id, id));
  }

  async createMonthClose(input: NewMonthClose): Promise<MonthClose> {
    // Both refusals — a duplicate partition, a user close naming no currency —
    // come back from the database itself, off the unique index and the CHECK
    // that 0013 adds. MemoryStore states them in code to say the same thing.
    const [row] = await this.db
      .insert(s.monthCloses)
      .values({
        householdId: input.householdId,
        accountId: input.accountId,
        userId: input.userId ?? null,
        currency: input.currency ?? null,
        month: input.month,
        incomeMinor: input.incomeMinor,
        plannedMinor: input.plannedMinor,
        contributedMinor: input.contributedMinor,
        closedBy: input.closedBy,
      })
      .returning();
    return mapMonthClose(row!);
  }

  async getMonthCloseById(id: string): Promise<MonthClose | null> {
    const [row] = await this.db.select().from(s.monthCloses).where(eq(s.monthCloses.id, id));
    return row ? mapMonthClose(row) : null;
  }

  async getMonthClose(scope: MonthCloseScope, month: string): Promise<MonthClose | null> {
    // Ordered and limited, not merely "the first row back": a user's month can
    // hold one row per currency, and asking without one must still answer the
    // same way twice.
    const [row] = await this.db
      .select()
      .from(s.monthCloses)
      .where(and(monthCloseScopeCond(scope), eq(s.monthCloses.month, month)))
      .orderBy(asc(s.monthCloses.currency))
      .limit(1);
    return row ? mapMonthClose(row) : null;
  }

  async listMonthCloses(scope: MonthCloseScope): Promise<MonthClose[]> {
    const rows = await this.db
      .select()
      .from(s.monthCloses)
      .where(monthCloseScopeCond(scope))
      .orderBy(desc(s.monthCloses.month), asc(s.monthCloses.currency));
    return rows.map(mapMonthClose);
  }

  async deleteMonthClose(id: string): Promise<void> {
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.id, id));
  }

  private mapAccount(r: typeof s.accounts.$inferSelect): Account {
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: r.name,
      description: r.description,
      currency: r.currency,
      openingBalanceMinor: r.openingBalanceMinor,
      monthlyBufferMinor: r.monthlyBufferMinor,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapInflow(r: typeof s.inflows.$inferSelect): Inflow {
    return {
      id: r.id,
      accountId: r.accountId,
      name: r.name,
      source: r.source as InflowSourceKind,
      sourceAccountId: r.sourceAccountId,
      amountMinor: r.amountMinor,
      frequency: r.frequency as Frequency,
      recurrence: rec(r.recurrence),
      anchorDate: r.anchorDate,
      priority: r.priority,
      active: r.active,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapPayment(r: typeof s.payments.$inferSelect): Payment {
    return {
      id: r.id,
      accountId: r.accountId,
      name: r.name,
      category: r.category as PaymentCategory,
      amountMinor: r.amountMinor,
      dueDate: r.dueDate,
      recurrence: rec(r.recurrence),
      targetDate: r.targetDate,
      priority: r.priority,
      alreadySavedMinor: r.alreadySavedMinor,
      autoRenew: r.autoRenew,
      active: r.active,
      notes: r.notes,
      projectId: r.projectId,
      scope: r.scope as PaymentScope,
      bearerUserId: r.bearerUserId,
      fixedMonthlyMinor: r.fixedMonthlyMinor,
      tag: r.tag,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapProject(r: typeof s.projects.$inferSelect): Project {
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: r.name,
      description: r.description,
      color: r.color,
      targetDate: r.targetDate,
      visibility: r.visibility as ProjectVisibility,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async createProject(input: NewProject): Promise<Project> {
    const [row] = await this.db
      .insert(s.projects)
      .values({
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description,
        color: input.color,
        targetDate: input.targetDate,
        // Personal unless it says otherwise — 0014's column default, restated
        // here so both stores answer the same without asking the database.
        visibility: input.visibility ?? "personal",
      })
      .returning();
    return this.mapProject(row!);
  }

  async getProject(id: string): Promise<Project | null> {
    const [row] = await this.db.select().from(s.projects).where(eq(s.projects.id, id));
    return row ? this.mapProject(row) : null;
  }

  async listProjectsForOwner(ownerUserId: string): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(s.projects)
      .where(eq(s.projects.ownerUserId, ownerUserId));
    return rows.map((r) => this.mapProject(r));
  }

  async listProjectsForUser(userId: string): Promise<Project[]> {
    // Membership read here and now: a shared project's audience is not stored
    // (see `ProjectVisibility`), so an owner with no household shares with
    // nobody. A household is a handful of people, so this reads the roster into
    // memory rather than joining — the trade `dissolveMembershipBenefits`
    // already makes.
    const mates = await this.coMembersOf(userId);
    const rows = await this.db
      .select()
      .from(s.projects)
      .where(
        mates.length === 0
          ? eq(s.projects.ownerUserId, userId)
          : or(
              eq(s.projects.ownerUserId, userId),
              and(eq(s.projects.visibility, "shared"), inArray(s.projects.ownerUserId, mates)),
            ),
      )
      .orderBy(asc(s.projects.createdAt));
    return rows.map((r) => this.mapProject(r));
  }

  /** Everyone sharing a household with this user, themselves excluded. */
  private async coMembersOf(userId: string): Promise<string[]> {
    const householdIds = (await this.listHouseholdsForUser(userId)).map((h) => h.id);
    if (householdIds.length === 0) return [];
    const rows = await this.db
      .select({ userId: s.memberships.userId })
      .from(s.memberships)
      .where(inArray(s.memberships.householdId, householdIds));
    return [...new Set(rows.map((r) => r.userId))].filter((id) => id !== userId);
  }

  async clearProjectLinksForAccount(accountId: string): Promise<void> {
    // Scoped through the account's own payments, so the shared-project set read
    // here is bounded by one account rather than by the whole table.
    const linked = await this.db
      .select({ projectId: s.payments.projectId })
      .from(s.payments)
      .where(and(eq(s.payments.accountId, accountId), isNotNull(s.payments.projectId)));
    const projectIds = [...new Set(linked.map((r) => r.projectId!))];
    if (projectIds.length === 0) return;
    const shared = await this.db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(inArray(s.projects.id, projectIds), eq(s.projects.visibility, "shared")));
    if (shared.length === 0) return;
    await this.db
      .update(s.payments)
      .set({ projectId: null, updatedAt: new Date() })
      .where(
        and(
          eq(s.payments.accountId, accountId),
          inArray(
            s.payments.projectId,
            shared.map((p) => p.id),
          ),
        ),
      );
  }

  async updateProject(id: string, patch: Partial<NewProject>): Promise<Project | null> {
    const [row] = await this.db
      .update(s.projects)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(s.projects.id, id))
      .returning();
    return row ? this.mapProject(row) : null;
  }

  async deleteProject(id: string): Promise<void> {
    // Member payments lose their link via the FK's ON DELETE SET NULL.
    await this.db.delete(s.projects).where(eq(s.projects.id, id));
  }

  async listPaymentsForProject(projectId: string): Promise<Payment[]> {
    const rows = await this.db.select().from(s.payments).where(eq(s.payments.projectId, projectId));
    return rows.map((r) => this.mapPayment(r));
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mapContribution(r: typeof s.contributions.$inferSelect): Contribution {
  return {
    id: r.id,
    paymentId: r.paymentId,
    accountId: r.accountId,
    userId: r.userId,
    month: r.month,
    amountMinor: r.amountMinor,
    note: r.note,
    transferConfirmationId: r.transferConfirmationId,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapBalanceSnapshot(r: typeof s.balanceSnapshots.$inferSelect): BalanceSnapshot {
  return {
    id: r.id,
    accountId: r.accountId,
    asOfDate: r.asOfDate,
    balanceMinor: r.balanceMinor,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapTransferConfirmation(
  r: typeof s.transferConfirmations.$inferSelect,
): TransferConfirmation {
  return {
    id: r.id,
    householdId: r.householdId,
    inflowId: r.inflowId,
    month: r.month,
    fromAccountId: r.fromAccountId,
    toAccountId: r.toAccountId,
    memberUserId: r.memberUserId,
    amountMinor: r.amountMinor,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The one scope column a close is filed under, plus the currency when the
 *  caller named one — see `MonthCloseScope`. */
function monthCloseScopeCond(scope: MonthCloseScope): SQL | undefined {
  if ("householdId" in scope) return eq(s.monthCloses.householdId, scope.householdId);
  if ("accountId" in scope) return eq(s.monthCloses.accountId, scope.accountId);
  return and(
    eq(s.monthCloses.userId, scope.userId),
    scope.currency === undefined ? undefined : eq(s.monthCloses.currency, scope.currency),
  );
}

function mapMonthClose(r: typeof s.monthCloses.$inferSelect): MonthClose {
  return {
    id: r.id,
    householdId: r.householdId,
    accountId: r.accountId,
    userId: r.userId,
    currency: r.currency,
    month: r.month,
    incomeMinor: r.incomeMinor,
    plannedMinor: r.plannedMinor,
    contributedMinor: r.contributedMinor,
    closedBy: r.closedBy,
    closedAt: r.closedAt.toISOString(),
  };
}
