export type Frequency = "monthly" | "yearly" | "custom" | "one_off";
export type PaymentCategory =
  | "monthly_recurring"
  | "yearly_recurring"
  | "custom_recurring"
  | "fixed_point";
export type PaymentScope = "shared" | "personal";
export type AccountRole = "shared" | "personal";

export interface Recurrence {
  interval: number;
  unit: "day" | "week" | "month" | "year";
  anchor: string;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  emailVerified?: boolean;
  /** Whether an authenticator app is enrolled. Optional so a payload from an
   *  older API (or a test fixture) still satisfies the type — absent reads as
   *  "not enabled". */
  totpEnabled?: boolean;
  /** Opt-in to the daily digest email. Optional for the same reason as
   *  totpEnabled — absent reads as "off". */
  notifyEmail?: boolean;
  households?: HouseholdDto[];
}

/** What this deployment has switched on. Public: asked before logging in. */
export interface MetaDto {
  demoSeedEnabled: boolean;
}

// --- auth: second factor, password reset, SSO --------------------------------

/** A completed login: an access token in memory plus the refresh cookie. */
export interface LoginSessionDto {
  accessToken: string;
  user: UserDto;
}

/** Credentials were right, but the account has 2FA — finish at /login/totp.
 *  `pendingToken` is short-lived and is never persisted anywhere. */
export interface TotpChallengeDto {
  totpRequired: true;
  pendingToken: string;
}

export type LoginResultDto = LoginSessionDto | TotpChallengeDto;

/** Shared secret to enter into an authenticator app, plus the otpauth:// URI. */
export interface TotpSetupDto {
  secret: string;
  otpauthUri: string;
}

/** The one and only time the recovery codes are readable. */
export interface TotpEnableDto {
  enabled: true;
  recoveryCodes: string[];
}

export interface TotpDisableDto {
  enabled: false;
}

/** Whether this deployment has an OIDC provider wired up. */
export type OidcMetaDto = { enabled: false } | { enabled: true; issuer: string };

export interface HouseholdDto {
  id: string;
  name: string;
}

export type HouseholdRole = "owner" | "admin" | "member";

export interface HouseholdMemberDto {
  membershipId: string;
  userId: string;
  role: HouseholdRole;
  /** Proportional contribution to shared costs, in basis points (0–10000). */
  shareBp: number;
  displayName: string;
  email: string;
  isSelf: boolean;
}

export interface HouseholdShareDto {
  shareId: string;
  accountId: string;
  accountName: string;
  currency: string;
  permission: "view" | "edit";
}

export interface HouseholdDetailDto {
  id: string;
  name: string;
  createdAt: string;
  yourRole: HouseholdRole;
  members: HouseholdMemberDto[];
  shares: HouseholdShareDto[];
}

export interface AccountDto {
  id: string;
  name: string;
  description?: string | null;
  currency: string;
  openingBalanceMinor: number;
  monthlyBufferMinor: number;
  permission?: "view" | "edit";
  owner?: boolean;
}

export interface IncomeDto {
  id: string;
  accountId: string;
  name: string;
  amountMinor: number;
  frequency: Frequency;
  recurrence: Recurrence | null;
  anchorDate: string;
  active: boolean;
}

/** Where money arriving into an account came from: outside everything you own,
 *  or another account you own. */
export type InflowSourceKind = "external" | "account";

/**
 * Money arriving into an account, authored on the account it arrives in.
 *
 * `source: "external"` is what an income has always been — the `/incomes`
 * endpoints are the external half of these very rows. `source: "account"` is
 * one row with two faces: it arrives on `accountId` and leaves
 * `sourceAccountId`, so the two ends can never drift apart.
 */
export interface InflowDto {
  id: string;
  /** The account the money arrives into. */
  accountId: string;
  name: string;
  source: InflowSourceKind;
  /** The account the money leaves. Set exactly when `source` is "account". */
  sourceAccountId: string | null;
  amountMinor: number;
  frequency: Frequency;
  recurrence: Recurrence | null;
  anchorDate: string;
  /** Rank among the *sending* account's movements, lower first. Meaningless on
   *  an external inflow — nothing sends a salary. */
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentDto {
  id: string;
  accountId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string | null;
  recurrence: Recurrence | null;
  targetDate: string | null;
  priority: number;
  alreadySavedMinor: number;
  autoRenew: boolean;
  active: boolean;
  notes: string | null;
  projectId: string | null;
  scope: PaymentScope;
  bearerUserId: string | null;
  /** Contribution-first goal: "set aside this much per month". fixed_point only;
   *  with one set the due date is optional. */
  fixedMonthlyMinor?: number | null;
  /** Free-text grouping label ("housing", "car", …). Never drives the maths. */
  tag?: string | null;
}

export interface ProjectDto {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  color: string | null;
  targetDate: string | null;
}

export interface ProjectMemberPaymentDto {
  id: string;
  accountId: string;
  accountName: string;
  currency: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  alreadySavedMinor: number;
  dueDate: string | null;
}

export interface ProjectDetailDto extends ProjectDto {
  payments: ProjectMemberPaymentDto[];
}

/**
 * Why a line is where it is — the axis `onTrack` cannot express.
 *
 * `onTrack` answers "does the plan cover this?". It cannot separate *the plan
 * cannot fund this* (cut something, or raise a share) from *the plan funds this,
 * you have not moved the money yet* (make the transfer). Two problems, two
 * remedies, two colours: red is only ever the first of them.
 */
export type PlanLineStatus = "funded" | "awaiting_transfer" | "at_risk";

/**
 * A line's tri-state, from an API that may not have said.
 *
 * The one place the fallback is written down, so no screen invents its own.
 * `onTrack` is the older, coarser axis and still means what it always meant:
 * the plan covers this. A payload with no `status` — a household plan's lines,
 * an older API, a fixture — collapses to the two states the UI had before,
 * which is exactly what those payloads meant.
 *
 * A function in a types module because it *is* the type: reading the wire's
 * optional field is not something a component should be trusted to do twice.
 */
export function lineStatus(line: Pick<PlanLineDto, "status" | "onTrack">): PlanLineStatus {
  if (line.status) return line.status;
  return line.onTrack ? "funded" : "at_risk";
}

export interface PlanLineDto {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  /** The date on this line was worked out from the goal's pace, not set by the
   *  user. The API says so explicitly because the wire cannot: `dueDate` is
   *  filled in either way. */
  dueDateIsDerived?: boolean;
  monthsUntilDue: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  /** Of `fundedMonthlyMinor`, the part the account's own income paid for.
   *  Sums with `fundedFromInflowMinor` to `fundedMonthlyMinor` exactly.
   *  Optional: a household plan's lines carry no split. */
  fundedFromOwnMinor?: number;
  /** Of `fundedMonthlyMinor`, the part paid for by money arriving from
   *  elsewhere — a household member, or another account you own. */
  fundedFromInflowMinor?: number;
  alreadySavedMinor: number;
  /** Times the payment falls due this month; >1 for sub-monthly recurrences. */
  occurrencesThisMonth?: number;
  onTrack: boolean;
  /**
   * The tri-state. Optional because it is additive — a payload without it (an
   * older API, a household line, a test fixture) is read as `funded` when
   * `onTrack` and `at_risk` when not, which is exactly what the UI said before
   * the third state existed.
   */
  status?: PlanLineStatus;
  projectedCompletionDate?: string;
  /** Passthrough of the goal's monthly contribution cap (fixed_point only). */
  fixedMonthlyMinor?: number | null;
  /** Passthrough of the payment's grouping label, so charts can group without
   *  refetching the payments. */
  tag?: string | null;
}

/** Money already set aside toward a payment during the current month. */
export interface ContributionTotalDto {
  paymentId: string;
  amountMinor: number;
}

/** The most recent balance check-in on an account. */
export interface LatestBalanceDto {
  asOfDate: string;
  balanceMinor: number;
}

/** What one authored movement actually delivered into an account this month. */
export interface InflowArrivalDto {
  /** The authored inflow's id — one row, read from both ends. */
  inflowId: string;
  fromAccountId: string;
  /** What the sending account could afford, which may be less than the row asks. */
  amountMinor: number;
  /** How much of `amountMinor` somebody has said actually moved; absent means
   *  nobody has said this one moved. */
  confirmedMinor?: number;
}

/**
 * One sender's share of the money arriving into an account this month.
 *
 * Discriminated rather than merged, because there really are two senders: a
 * person the household plan asks to transfer, and another account of your own
 * that a movement drains. A member has a name and no account; an account has an
 * id and no member.
 *
 * **`displayName` and `accountName` are access-gated and may be absent.** The
 * amount is a fact about an account the caller can already see; the *name* of
 * whoever is sending it is not. Render the absence honestly — "a household
 * member", "another account" — rather than inventing a name or printing an id.
 */
export type PlanInflowSourceDto =
  | {
      kind: "member";
      memberUserId: string;
      /** Only when the caller can see the household. */
      displayName?: string;
      /** The account the plan asks them to move it out of — their source account
       *  (decision 11), and what "I moved it" is posted with. Ungated, like the
       *  `account` variant's `fromAccountId` below: the gate is on names, and an
       *  id is not one. */
      fromAccountId: string;
      amountMinor: number;
      confirmedMinor: number;
    }
  | {
      kind: "account";
      /** The authored inflow, so "I moved it" has something to post to. */
      inflowId: string;
      fromAccountId: string;
      /** Only when the caller can see the sending account. */
      accountName?: string;
      amountMinor: number;
      confirmedMinor: number;
    };

export interface AccountPlanDto {
  accountId: string;
  /** The date the plan was computed against — the server's day, not the
   *  browser's. Already on the wire (`AccountPlan.asOfDate`); this type simply
   *  never declared it, which is why the plan table's "due in N d" countdown
   *  had nothing to count from. */
  asOfDate: string;
  currency: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  /**
   * What is actually left in the account once the month's flows have happened:
   *
   *     income + arriving − spending − leaving
   *
   * The one number the account page, the household page and the flow diagram all
   * print (ONE-ENGINE.md). `leftoverMinor` above is deliberately a *different*
   * figure and keeps its meaning (decision 13): the account's own income after
   * its own obligations, which is the right answer for a rollup and the wrong
   * one for a picture, because summing residuals counts a transferred pound at
   * both ends.
   *
   * **Signed.** Negative means more is committed to leave this account than
   * reaches it, which happens when a member holds income in a personal account
   * other than the one their transfers leave (decision 11) and has to
   * consolidate first. Optional: a payload from before the one pass has none.
   */
  residualMinor?: number;
  shortfallMinor: number;
  lines: PlanLineDto[];
  /** Per-payment totals contributed this month — the "reality" half of the plan. */
  contributionsMTD: ContributionTotalDto[];
  /** Last manual balance check-in, or null when the account has never been reconciled. */
  latestBalance: LatestBalanceDto | null;
  /** Sum of every line's already-saved: what the plan believes is spoken for. */
  reservedMinor: number;
  /**
   * Money arriving into this account this month from anywhere but its own
   * income. Never folded into `monthlyIncomeMinor`: the account that sent it
   * still reports it as its own, and folding would double it in every figure
   * that sums income across accounts.
   */
  allocatedInflowMinor?: number;
  /** Of `allocatedInflowMinor`, how much somebody has said actually moved. The
   *  rest funds the arithmetic while its lines read `awaiting_transfer`. */
  confirmedInflowMinor?: number;
  /** Of that, the part confirming transfers the plan **derived**, which is the
   *  only money a payment line is ever funded with — the rest confirms authored
   *  savings movements and decides no line's status. */
  confirmedTransferMinor?: number;
  /** Of `allocatedInflowMinor`, what each movement from another account
   *  delivered. Empty for an account nothing moves into. */
  inflowArrivals?: InflowArrivalDto[];
  /** Total this account sends on to other accounts. Deliberately *not*
   *  subtracted from `leftoverMinor` — see the API's `AccountPlan`. */
  outboundInflowMinor?: number;
  /** The derived transfers the plan asks this account's owner to make out of
   *  it — expense transport, authored by nobody. Unlike the field above this
   *  one *is* already taken out of `leftoverMinor`. */
  transferOutMinor?: number;
  /**
   * Where the arriving money is coming from, when the caller may be told.
   * `null` — the API's own answer — means nothing is arriving that this caller
   * may be told about, which reads the same as nothing arriving.
   */
  inflowSources?: PlanInflowSourceDto[] | null;
  /**
   * The accounts in the funding loop this account belongs to, in the order
   * money would travel round it. Absent in the normal, acyclic case. A loop is
   * detected and reported, never refused at authoring — so the UI is the only
   * thing that can explain it.
   */
  fundingCycleAccountIds?: string[];
  /** The one movement on that loop the plan ignored to break it — the edge that
   *  funds nothing, and the one to delete or re-point. */
  fundingCycleBrokenInflowId?: string;
}

/**
 * The answer to "what would this do to my plan?": the account's plan as it
 * stands, alongside the plan it would have with the drafted payments/incomes
 * added. Both computed for the same as-of date; nothing is persisted.
 */
export interface PlanPreviewDto {
  base: AccountPlanDto;
  preview: AccountPlanDto;
}

/**
 * A save-up the plan funded this month with money still unrecorded against it,
 * described well enough to act on: which payment, what to call it, what the
 * month asked for, and what is still missing.
 */
export interface UnrecordedLineDto {
  paymentId: string;
  name: string;
  /** The month's target — the row's figure. */
  fundedMonthlyMinor: number;
  /** What is still missing — the amount the record action prefills. */
  remainderMinor: number;
}

/**
 * What the checklist reads off an account plan's line list, derived by the API
 * from the plan the overview already computes. The list itself never travels:
 * only the lines something is being asked of, plus the two facts the fold's
 * sentences count and name.
 */
export interface PlanLineSummaryDto {
  unrecorded: UnrecordedLineDto[];
  /** How many payment lines the plan has — "all N payments funded". */
  lineCount: number;
  /** The last line the plan still funds: what a tighter month would cut first. */
  lastFundedName: string | null;
}

/**
 * One account inside the overview: the plan's numbers for it, plus the state
 * the accounts index leads with. Enough to answer "which account needs me
 * today" without a second request per row.
 */
export interface OverviewAccountDto {
  accountId: string;
  name: string;
  /** The household this account is planned in, or null when it is planned
   *  alone. Also the de-duplication hook: an account inside a household is
   *  already spoken for by that household's members. */
  householdId: string | null;
  /** Its role in that plan — the shared pot, or one member's own account. */
  householdRole: AccountRole | null;
  monthlyIncomeMinor: number;
  /** Money arriving from anywhere but this account's own income — amounts only,
   *  never who is sending it, so the index needs no access gate. */
  allocatedInflowMinor?: number;
  /** Of that, how much has been confirmed as actually moved. The difference is
   *  what the index's awaiting chip counts. */
  confirmedInflowMinor?: number;
  /**
   * What each movement out of another account delivered here this month — the
   * itemisation of `allocatedInflowMinor`, and the only carrier of the authored
   * inflow's id, which is what "I moved it" is posted against.
   *
   * Ids and amounts, never a name, so this needs no access gate for the same
   * reason the total above does not — and it rides on the account plan already,
   * ungated, so withholding it here would hide nothing. Absent when nothing
   * moves into this account, which is the ordinary case.
   */
  inflowArrivals?: InflowArrivalDto[];
  /**
   * Where that money is coming from, as much of it as this caller may be told —
   * the same gated list the account plan carries.
   *
   * The arrivals above itemise **authored** movements, and a transfer the plan
   * *derived* has nothing to itemise, because nobody wrote it down. Without this
   * the checklist could never draw a derived-transfer row on the one screen a
   * solo user has, so the confirmation endpoint had no reachable client at all.
   */
  inflowSources?: PlanInflowSourceDto[];
  leftoverMinor: number;
  shortfallMinor: number;
  atRiskCount: number;
  /** The last balance check-in, from the same read the account page's reality
   *  strip uses. Null on an account nobody has ever checked in. */
  latestBalanceMinor: number | null;
  latestBalanceDate: string | null;
  /** What the plan has set aside on this account — the strip's second figure. */
  reservedMinor: number;
  /** Save-up lines the plan funded this month with no contribution recorded
   *  against them yet, and how much of that money is still unrecorded. Same
   *  definition of "covered" as the checklist's `record` rule — the counts are
   *  read off `planSummary.unrecorded`, so the chip and the rows agree. */
  unrecordedCount: number;
  unrecordedTotalMinor: number;
  /** Those same lines as descriptors, plus what the fold's sentences need from
   *  the rest of the list. Optional because it is additive: an API without it
   *  simply leaves this account with no checklist rows rather than inventing
   *  any. */
  planSummary?: PlanLineSummaryDto;
}

export interface CurrencyOverviewDto {
  currency: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /**
   * Surplus across the rollup: the per-account `leftoverMinor`s, summed, with
   * nothing netted out of it.
   *
   * There used to be an `intraEstateMovementMinor` term here, because two
   * engines disagreed about whose money a transferred pound was and a chain
   * inflated the estate once per hop. One pass settles that in the accounts
   * instead: `leftoverMinor` is an account's own income after its own bills and
   * after the transfers its owner has to make, so every pound is counted once
   * before this rollup sees it (ONE-ENGINE.md).
   */
  leftoverMinor: number;
  shortfallMinor: number;
  accounts: OverviewAccountDto[];
}

export interface OverviewDto {
  asOfDate: string;
  perCurrency: CurrencyOverviewDto[];
}

// --- household plan ---------------------------------------------------------

export interface HouseholdAccountAssignmentDto {
  accountId: string;
  accountName: string;
  currency: string;
  role: AccountRole;
  memberUserId: string | null;
}

export interface MemberAllocationDto {
  userId: string;
  requiredMinor: number;
  fundedMinor: number;
}

export interface HouseholdPlanLineDto {
  paymentId: string;
  accountId: string;
  name: string;
  category: PaymentCategory;
  scope: PaymentScope;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  priority: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  occurrencesThisMonth: number;
  onTrack: boolean;
  /** Passthrough of the payment's grouping label, for charts. */
  tag?: string | null;
  allocations: MemberAllocationDto[];
}

/**
 * Decision 13, on the wire: `leftoverMinor` keeps its meaning everywhere and
 * `committedMinor` is added alongside it, never netted into it. Free-after-
 * committed is the difference, and it is the figure a headline shows.
 *
 * Optional throughout, the way every additive field here is: a payload from an
 * older API — or a fixture — reads as "nothing committed", which is what those
 * payloads meant.
 */
export interface HouseholdMemberPlanDto {
  userId: string;
  displayName?: string;
  shareBp: number;
  monthlyIncomeMinor: number;
  /** Scope-wide: everything the pass attributes to them, on the household's
   *  accounts and anywhere else. Split by the two pairs below. */
  obligationMinor: number;
  fundedMinor: number;
  /** Of that, what this household's own plan lines carry — the part the
   *  breakdown beneath the figure explains. */
  householdObligationMinor?: number;
  householdFundedMinor?: number;
  /** The rest: cost this household's lines do not carry — a member's own bills
   *  pot fed by a derived transfer, chiefly. The category `committedMinor` never
   *  had a sibling for, and which the member bars used to infer by subtraction. */
  elsewhereObligationMinor?: number;
  elsewhereFundedMinor?: number;
  leftoverMinor: number;
  /** Of that leftover, what funded savings movements out of this member's own
   *  household accounts have spoken for. */
  committedMinor?: number;
  shortfallMinor: number;
}

export interface HouseholdAccountPlanDto {
  accountId: string;
  name?: string;
  role: AccountRole;
  memberUserId: string | null;
  currency: string;
  monthlyIncomeMinor: number;
  requiredOutflowMinor: number;
  fundedOutflowMinor: number;
  /** Derived transfers in and out — expense transport, authored by nobody. */
  transferInMinor: number;
  transferOutMinor: number;
  /** What authored savings movements delivered here. The mirror of
   *  `committedMinor`, and the figure the flow page used to recover by
   *  rearranging `leftoverMinor`'s identity. */
  movementInMinor?: number;
  /** What remains after the month's flows but **before** the savings movements
   *  leaving this account. Free-after-committed — the figure the account page
   *  and the flow diagram print — is this minus `committedMinor`. */
  leftoverMinor: number;
  /** What funded savings movements take out of this account (decision 13).
   *  A single bucket, deliberately not itemised: which pot each pound went to is
   *  the account page's and the flow diagram's question, not the household's. */
  committedMinor?: number;
  shortfallMinor: number;
}

export interface TransferDto {
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  amountMinor: number;
}

/** One payday, with the slices of the month's transfers that land on it. */
export interface PayEventDto {
  /** ISO date ("YYYY-MM-DD"). A member with no payday at all gets one synthetic
   *  event on the 1st, which the UI labels "start of month". */
  date: string;
  transfers: { fromAccountId: string; toAccountId: string; amountMinor: number }[];
  totalMinor: number;
}

/** Roster order; a member with no transfers to make has an empty `events`. */
export interface MemberPaydayScheduleDto {
  memberUserId: string;
  events: PayEventDto[];
}

export interface HouseholdPlanDto {
  householdId: string;
  asOfDate: string;
  currency: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /**
   * The **members'** surplus, scope-wide — their whole budgets less everything
   * the pass attributes to them, on this household's accounts and anywhere
   * else. The one scope-wide figure in an interface of household-only ones, and
   * kept that way to the penny (decision 13).
   *
   * Not a headline. A household holding nothing but its bills pot printed this
   * beside an income of £0, which is money its own income figure does not
   * contain. Use `householdLeftoverMinor`.
   */
  leftoverMinor: number;
  /**
   * What is left in **this household's accounts** when the month's flows have
   * happened — `accounts[].leftoverMinor` added up, which is the LEFT OVER
   * column of the table on the page. Before the savings movements leaving,
   * exactly as the per-account figure is, so free-after-committed is this minus
   * `committedMinor`.
   */
  householdLeftoverMinor?: number;
  /** Of that leftover, what the household's funded savings movements have
   *  spoken for (decision 13). */
  committedMinor?: number;
  shortfallMinor: number;
  members: HouseholdMemberPlanDto[];
  accounts: HouseholdAccountPlanDto[];
  lines: HouseholdPlanLineDto[];
  transfers: TransferDto[];
  /** When to move the money, not just how much. Optional so a plan served by an
   *  older API (or built in a test) still satisfies the type. */
  paydaySchedule?: MemberPaydayScheduleDto[];
}

// --- money flow over any scope ----------------------------------------------
// The diagram's model, mirroring the API's `Flow`. A scope is a set of accounts
// the user chose; a household is one preset over that set, not the mechanism.

/** What became of one edge, straight off `EstateMovement.status`. */
export type FlowEdgeStatus = "funded" | "short" | "unfunded" | "broken_cycle" | "unknown_source";

export interface FlowAccountDto {
  accountId: string;
  name: string;
  /** Money entering from outside the estate — never what another account sent. */
  incomeMinor: number;
  /** Obligations funded out of this account this month. */
  spendingMinor: number;
  /** What stays put. A residual, so the node's ribbons meet. */
  leftoverMinor: number;
  shortfallMinor: number;
}

export interface FlowEdgeDto {
  /** null means an account outside the scope — or, once hidden, outside the
   *  picture. Money crossing that edge is still drawn crossing it. */
  fromAccountId: string | null;
  toAccountId: string | null;
  amountMinor: number;
  /** What the row asked for; more than `amountMinor` when it fell short. */
  requestedMinor: number;
  status: FlowEdgeStatus;
  /** The authored movement, when the edge is one. */
  inflowId?: string;
  /** The member whose money moves, when the edge is a household transfer. */
  memberUserId?: string;
  /** That member's name, when the caller may be told it. */
  memberName?: string;
}

export interface FlowDto {
  asOfDate: string;
  currency: string;
  accounts: FlowAccountDto[];
  edges: FlowEdgeDto[];
  /** Money entering from outside — the denominator every share is measured
   *  against. See `lib/flow.ts`. */
  totalInflowMinor: number;
}

// --- projections ------------------------------------------------------------
// The plan simulated month by month, so the UI can show where the money lands
// rather than only this month's slice.

export interface ProjectionLineDto {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  /** Set aside for this payment at the end of the month, after any bill it paid. */
  alreadySavedEndMinor: number;
  dueThisMonth: boolean;
  /** amountMinor × occurrences this month; 0 when nothing falls due. */
  dueAmountMinor: number;
}

export interface MonthProjectionDto {
  /** "YYYY-MM". */
  month: string;
  monthlyIncomeMinor: number;
  /**
   * Money arriving into the account this month from outside it. Without it a
   * projected month cannot explain itself — `totalFundedMinor` can exceed
   * `monthlyIncomeMinor - bufferMinor` with nothing on the wire saying why,
   * which reads as an arithmetic error rather than as a funded pot.
   */
  allocatedInflowMinor?: number;
  /** Of that, what somebody has said moved. Zero in every month after the
   *  first: nobody has moved next March's money yet. */
  confirmedInflowMinor?: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  /** Money leaving for other accounts this month. Not subtracted from
   *  `leftoverMinor`, so a month that sends its surplus on cannot look like a
   *  month that kept it. */
  outboundInflowMinor?: number;
  shortfallMinor: number;
  reservedEndMinor: number;
  /** null on every month when the account has no balance check-in to start from. */
  projectedBalanceMinor: number | null;
  lines: ProjectionLineDto[];
}

export interface AccountProjectionDto {
  accountId: string;
  currency: string;
  asOfDate: string;
  months: MonthProjectionDto[];
}

export interface HouseholdProjectionLineDto extends ProjectionLineDto {
  accountId: string;
}

export interface HouseholdMonthProjectionDto {
  month: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  /** Money members must move between accounts this month. */
  transfersTotalMinor: number;
  reservedEndMinor: number;
  lines: HouseholdProjectionLineDto[];
}

export interface HouseholdProjectionDto {
  householdId: string;
  currency: string;
  asOfDate: string;
  months: HouseholdMonthProjectionDto[];
}

// --- upcoming payments ------------------------------------------------------

/** One dated hit of a payment inside the look-ahead window. */
export interface UpcomingItemDto {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string;
  /** Whole days from the as-of date; 0 means "today". */
  daysUntil: number;
  accountId: string;
  accountName: string;
  currency: string;
}

export interface UpcomingDto {
  asOfDate: string;
  /** The window the server actually used, after clamping. */
  days: number;
  items: UpcomingItemDto[];
}

// --- the reality loop ------------------------------------------------------
// Plans say what *should* happen; these record what *did*.

/** A dated record of money set aside toward a payment. */
export interface ContributionDto {
  id: string;
  paymentId: string;
  accountId: string;
  userId: string | null;
  /** ISO date of the first day of the month it belongs to ("YYYY-MM-01"). */
  month: string;
  amountMinor: number;
  note: string | null;
  /** Set when the contribution was created by confirming a household transfer. */
  transferConfirmationId: string | null;
  createdAt: string;
}

/** A manual balance check-in. One per account per day; newest day wins. */
export interface BalanceSnapshotDto {
  id: string;
  accountId: string;
  asOfDate: string;
  /** May be negative (overdraft). */
  balanceMinor: number;
  createdAt: string;
}

/**
 * "I moved the money", for one month of one movement.
 *
 * A household attributes the movement to a member; a movement between two of
 * your own accounts has no household at all, which is why `householdId` is
 * nullable. Exactly one of the two scopes is set.
 */
export interface TransferConfirmationDto {
  id: string;
  /** The household attributing this movement, when one does. */
  householdId: string | null;
  /** The account-sourced inflow this confirms, when it confirms one. Optional
   *  so a payload from before movements existed still satisfies the type. */
  inflowId?: string | null;
  month: string;
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  amountMinor: number;
  createdAt: string;
}

/** A frozen month scorecard for a household or a standalone account. */
export interface MonthCloseDto {
  id: string;
  /** Exactly one of householdId / accountId is set. */
  householdId: string | null;
  accountId: string | null;
  month: string;
  incomeMinor: number;
  plannedMinor: number;
  contributedMinor: number;
  closedBy: string | null;
  closedAt: string;
}

/** POST /transfers/confirm and POST /inflows/:id/confirm both return the
 *  confirmation plus the contributions it booked. */
export interface ConfirmTransferResultDto {
  confirmation: TransferConfirmationDto;
  contributions: ContributionDto[];
}

// --- portability + demo data ------------------------------------------------

/** Rows an import created. Import is additive, so these are always creations,
 *  never updates. */
export interface ImportCountsDto {
  accounts: number;
  incomes: number;
  /** Movements between two of the imported accounts. */
  accountInflows?: number;
  /** "I moved the money", restored against those movements. */
  accountInflowConfirmations?: number;
  /** The same, for the transfers the plan derives — which have no movement to
   *  be restored against. */
  derivedTransferConfirmations?: number;
  payments: number;
  contributions: number;
  balanceSnapshots: number;
  closes: number;
  projects: number;
}

/** Rows the demo seed planted. No projects or month closes in the worked
 *  example, so it is a narrower shape than an import. */
export interface DemoSeedCountsDto {
  accounts: number;
  incomes: number;
  payments: number;
  contributions: number;
  balanceSnapshots: number;
}
