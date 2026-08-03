import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");
export const coreSchema = pgSchema("core");
export const calcSchema = pgSchema("calc");

export const users = authSchema.table("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = authSchema.table("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailVerificationTokens = authSchema.table("email_verification_tokens", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const households = authSchema.table("households", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = authSchema.table("household_memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  householdId: uuid("household_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull().default("member"),
  contributionShareBp: integer("contribution_share_bp").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accountShares = authSchema.table("account_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  householdId: uuid("household_id").notNull(),
  permission: text("permission").notNull().default("view"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = coreSchema.table("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  currency: text("currency").notNull().default("GBP"),
  openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" }).notNull().default(0),
  monthlyBufferMinor: bigint("monthly_buffer_minor", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incomes = coreSchema.table("incomes", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  name: text("name").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  frequency: text("frequency").notNull(),
  recurrence: jsonb("recurrence"),
  anchorDate: date("anchor_date").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payments = coreSchema.table("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  dueDate: date("due_date"),
  recurrence: jsonb("recurrence"),
  targetDate: date("target_date"),
  priority: integer("priority").notNull().default(100),
  alreadySavedMinor: bigint("already_saved_minor", { mode: "number" }).notNull().default(0),
  autoRenew: boolean("auto_renew").notNull().default(true),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  projectId: uuid("project_id"),
  scope: text("scope").notNull().default("shared"),
  bearerUserId: uuid("bearer_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-household account role: a shared pot, or personal to one member. Drives
 * cost attribution + transfer derivation in the household plan engine. Unique
 * per (household, account).
 */
export const householdAccountAssignments = coreSchema.table("household_account_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  householdId: uuid("household_id").notNull(),
  accountId: uuid("account_id").notNull(),
  role: text("role").notNull().default("shared"),
  memberUserId: uuid("member_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = coreSchema.table("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"),
  targetDate: date("target_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transferConfirmations = coreSchema.table("transfer_confirmations", {
  id: uuid("id").defaultRandom().primaryKey(),
  householdId: uuid("household_id").notNull(),
  month: date("month").notNull(),
  fromAccountId: uuid("from_account_id").notNull(),
  toAccountId: uuid("to_account_id").notNull(),
  memberUserId: uuid("member_user_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contributions = coreSchema.table("contributions", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: uuid("payment_id").notNull(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id"),
  month: date("month").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  note: text("note"),
  transferConfirmationId: uuid("transfer_confirmation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const balanceSnapshots = coreSchema.table("balance_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  asOfDate: date("as_of_date").notNull(),
  balanceMinor: bigint("balance_minor", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const monthCloses = coreSchema.table("month_closes", {
  id: uuid("id").defaultRandom().primaryKey(),
  householdId: uuid("household_id"),
  accountId: uuid("account_id"),
  month: date("month").notNull(),
  incomeMinor: bigint("income_minor", { mode: "number" }).notNull(),
  plannedMinor: bigint("planned_minor", { mode: "number" }).notNull(),
  contributedMinor: bigint("contributed_minor", { mode: "number" }).notNull(),
  closedBy: uuid("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planSnapshots = calcSchema.table("plan_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  asOfDate: date("as_of_date").notNull(),
  inputsHash: text("inputs_hash").notNull(),
  detail: jsonb("detail").notNull(),
});
