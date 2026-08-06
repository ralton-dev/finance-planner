import type {
  AccountDto,
  AccountPlanDto,
  AccountProjectionDto,
  AccountRole,
  BalanceSnapshotDto,
  ConfirmTransferResultDto,
  ContributionDto,
  DemoSeedCountsDto,
  FlowDto,
  HouseholdAccountAssignmentDto,
  HouseholdDetailDto,
  HouseholdPlanDto,
  HouseholdProjectionDto,
  HouseholdRole,
  ImportCountsDto,
  IncomeDto,
  InflowDto,
  LoginResultDto,
  LoginSessionDto,
  MetaDto,
  MonthCloseDto,
  OidcMetaDto,
  OverviewDto,
  PaymentDto,
  PlanDebugDto,
  PlanPreviewDto,
  ProjectDetailDto,
  ProjectDto,
  ProjectVisibility,
  TotpDisableDto,
  TotpEnableDto,
  TotpSetupDto,
  TransferConfirmationDto,
  UpcomingDto,
  UserDto,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A failed response as an ApiError, reading the API's `{error:{code,message}}`
 *  envelope when there is one. Shared by the JSON and raw paths so an error
 *  means the same thing whichever one asked. */
async function toApiError(res: Response): Promise<ApiError> {
  let code = "error";
  let message = res.statusText;
  try {
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    code = json.error?.code ?? code;
    message = json.error?.message ?? message;
  } catch {
    /* non-JSON error */
  }
  return new ApiError(res.status, code, message);
}

/** Query string from the params that are actually set — never "?months=&asOf=". */
function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Typed client for the API gateway. Holds the access token in memory and
 * transparently refreshes it once on a 401. */
export class ApiClient {
  private accessToken: string | null = null;
  /** The refresh currently in flight, if any. See tryRefresh(). */
  private refreshInflight: Promise<boolean> | null = null;

  constructor(private readonly baseUrl = "") {}

  setToken(token: string | null): void {
    this.accessToken = token;
  }

  getToken(): string | null {
    return this.accessToken;
  }

  private async request<T>(method: Method, path: string, body?: unknown, retry = true): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
    });

    if (res.status === 401 && retry && (await this.tryRefresh())) {
      return this.request<T>(method, path, body, false);
    }

    if (!res.ok) throw await toApiError(res);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * The same auth and one-shot refresh as request(), handing back the Response
   * itself. For the endpoints whose *headers and bytes* are the payload (the
   * export download) rather than a parsed JSON body.
   */
  private async requestRaw(method: Method, path: string, retry = true): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}) },
      credentials: "include",
    });

    if (res.status === 401 && retry && (await this.tryRefresh())) {
      return this.requestRaw(method, path, false);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  /**
   * Swap the refresh cookie for a fresh access token, at most once at a time.
   *
   * Single-flight is not an optimisation, it is the whole point: the server
   * rotates the cookie on every refresh and reads a second presentation of a
   * rotated token as theft. Two refreshes racing on one cookie would therefore
   * sign the user out of every device. A page that fires several requests at
   * once 401s on all of them the moment the access token expires, so the race
   * is the common case — every caller waits on the one request instead. The
   * promise is dropped as soon as it settles, so a later refresh still runs
   * and a failed one poisons nothing.
   */
  tryRefresh(): Promise<boolean> {
    this.refreshInflight ??= this.refreshOnce().finally(() => {
      this.refreshInflight = null;
    });
    return this.refreshInflight;
  }

  private async refreshOnce(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + "/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { accessToken: string };
      this.accessToken = json.accessToken;
      return true;
    } catch {
      return false;
    }
  }

  // ---- deployment meta ----
  /** What this deployment has switched on. Public — no session needed. */
  meta() {
    return this.request<MetaDto>("GET", "/api/meta");
  }

  // ---- auth ----
  register(body: { email: string; password: string; displayName: string }) {
    return this.request<{ userId: string }>("POST", "/api/auth/register", body);
  }

  /** Either a session, or a `totpRequired` challenge to finish via loginTotp(). */
  async login(body: { email: string; password: string }): Promise<LoginResultDto> {
    const res = await this.request<LoginResultDto>("POST", "/api/auth/login", body);
    if ("accessToken" in res) this.accessToken = res.accessToken;
    return res;
  }

  /** Second leg of a 2FA login. Exactly one of `code` / `recoveryCode`.
   *  `retry: false` — a 401 here means a bad code, not a stale access token, so
   *  there is nothing to refresh and re-sending the code would be pointless. */
  async loginTotp(body: {
    pendingToken: string;
    code?: string;
    recoveryCode?: string;
  }): Promise<LoginSessionDto> {
    const res = await this.request<LoginSessionDto>("POST", "/api/auth/login/totp", body, false);
    this.accessToken = res.accessToken;
    return res;
  }

  async logout() {
    try {
      await this.request("POST", "/api/auth/logout");
    } finally {
      this.accessToken = null;
    }
  }

  me() {
    return this.request<UserDto>("GET", "/api/auth/me");
  }

  /** Change a setting on your own account; answers with the whole profile. */
  updateMe(body: { notifyEmail: boolean }) {
    return this.request<UserDto>("PATCH", "/api/auth/me", body);
  }

  /**
   * Erase the account and everything that is yours alone. No undo.
   *
   * 403 `invalid_credentials` when the password is wrong. An SSO-only account
   * has no local password to check and is erased on the strength of the token
   * instead — the field is ignored there, but the schema still requires it to
   * be non-empty, so send a placeholder rather than "".
   */
  deleteMe(body: { password: string }) {
    return this.request<void>("DELETE", "/api/auth/me", body);
  }

  // ---- two-factor auth (TOTP) ----
  /** Starts enrolment: returns the shared secret to show once. 409 when already on. */
  totpSetup() {
    return this.request<TotpSetupDto>("POST", "/api/auth/totp/setup");
  }
  /** Confirms enrolment with a code from the authenticator. The recovery codes
   *  it returns are the only copy — the server keeps hashes. */
  totpEnable(code: string) {
    return this.request<TotpEnableDto>("POST", "/api/auth/totp/enable", { code });
  }
  /** Accepts a TOTP code or an unused recovery code. */
  totpDisable(code: string) {
    return this.request<TotpDisableDto>("POST", "/api/auth/totp/disable", { code });
  }

  // ---- password reset ----
  /** Always 204, whether or not the address exists — never enumerate accounts. */
  forgotPassword(email: string) {
    return this.request<void>("POST", "/api/auth/password/forgot", { email });
  }
  resetPassword(token: string, password: string) {
    return this.request<{ reset: true }>("POST", "/api/auth/password/reset", { token, password });
  }

  // ---- single sign-on ----
  /** Whether this deployment has an OIDC provider configured. */
  oidcMeta() {
    return this.request<OidcMetaDto>("GET", "/api/auth/oidc/meta");
  }

  // ---- accounts ----
  listAccounts() {
    return this.request<AccountDto[]>("GET", "/api/accounts");
  }
  createAccount(body: Partial<AccountDto> & { name: string; currency: string }) {
    return this.request<AccountDto>("POST", "/api/accounts", body);
  }
  getAccount(id: string) {
    return this.request<AccountDto>("GET", `/api/accounts/${id}`);
  }
  /**
   * No `currency`: an account is denominated once, when it is created. The
   * server answers 422 to a body asking for a different one, so a field here
   * would only offer callers a request that cannot succeed.
   */
  updateAccount(
    id: string,
    body: {
      name?: string;
      description?: string | null;
      openingBalanceMinor?: number;
      monthlyBufferMinor?: number;
    },
  ) {
    return this.request<AccountDto>("PATCH", `/api/accounts/${id}`, body);
  }
  deleteAccount(id: string) {
    return this.request<void>("DELETE", `/api/accounts/${id}`);
  }
  getPlan(id: string, asOf?: string) {
    return this.request<AccountPlanDto>(
      "GET",
      `/api/accounts/${id}/plan${asOf ? `?asOf=${asOf}` : ""}`,
    );
  }
  /**
   * What-if: the plan as it stands, next to the plan it would have with the
   * drafted payments/incomes added (≤5 of each). Read-only — nothing is
   * persisted, and view access is enough.
   */
  previewPlan(
    accountId: string,
    body: { addPayments?: unknown[]; addIncomes?: unknown[] },
    asOf?: string,
  ) {
    return this.request<PlanPreviewDto>(
      "POST",
      `/api/accounts/${accountId}/plan/preview${query({ asOf })}`,
      body,
    );
  }
  /** Hidden engine trace. Requires `debug=engine`; normal screens never call it. */
  debugPlan(params: { account?: string; household?: string; asOf?: string }) {
    return this.request<PlanDebugDto>(
      "GET",
      `/api/debug/plan${query({ debug: "engine", ...params })}`,
    );
  }
  /** The plan month by month. `months` is clamped to 1..24 server-side (default 12). */
  accountProjection(id: string, months?: number, asOf?: string) {
    return this.request<AccountProjectionDto>(
      "GET",
      `/api/accounts/${id}/projection${query({ months, asOf })}`,
    );
  }

  // ---- contributions (money actually set aside) ----
  /** Record money set aside toward a payment. Moves the plan without editing the payment. */
  recordContribution(
    paymentId: string,
    body: { amountMinor: number; month?: string; note?: string },
  ) {
    return this.request<ContributionDto>("POST", `/api/payments/${paymentId}/contributions`, body);
  }
  listContributions(accountId: string, month?: string) {
    return this.request<ContributionDto[]>(
      "GET",
      `/api/accounts/${accountId}/contributions${month ? `?month=${month}` : ""}`,
    );
  }
  deleteContribution(contributionId: string) {
    return this.request<void>("DELETE", `/api/contributions/${contributionId}`);
  }

  // ---- balance check-ins ----
  /** Anchor the plan to real money. One snapshot per account per day; restating a day overwrites it. */
  setBalance(accountId: string, body: { balanceMinor: number; asOfDate?: string }) {
    return this.request<BalanceSnapshotDto>("PUT", `/api/accounts/${accountId}/balance`, body);
  }
  /** Oldest first. */
  listBalances(accountId: string) {
    return this.request<BalanceSnapshotDto[]>("GET", `/api/accounts/${accountId}/balances`);
  }

  // ---- month closes ----
  /** Freeze my month. Every currency partition I plan in, or none of them —
   *  a month already closed in any one of them comes back 409. */
  closeMyMonth(month: string) {
    return this.request<MonthCloseDto[]>("POST", "/api/me/closes", { month });
  }
  /** My frozen months, newest first. Mine only; there is nothing to scope. */
  listMyCloses() {
    return this.request<MonthCloseDto[]>("GET", "/api/me/closes");
  }
  /** Re-open one row. Per row, where closing is per month. */
  reopenMyMonth(closeId: string) {
    return this.request<void>("DELETE", `/api/me/closes/${closeId}`);
  }

  // ---- transfer confirmations ----
  /** Confirm a planned transfer actually moved; books the member's funded slice
   *  against each payment in the destination account. */
  confirmTransfer(
    householdId: string,
    body: { fromAccountId: string; toAccountId: string; memberUserId: string; month?: string },
  ) {
    return this.request<ConfirmTransferResultDto>(
      "POST",
      `/api/households/${householdId}/transfers/confirm`,
      body,
    );
  }
  /** Defaults to the current month server-side. */
  listTransferConfirmations(householdId: string, month?: string) {
    return this.request<TransferConfirmationDto[]>(
      "GET",
      `/api/households/${householdId}/transfers/confirmations${month ? `?month=${month}` : ""}`,
    );
  }
  /** Un-confirm: drops the confirmation and the contributions it created. */
  unconfirmTransfer(householdId: string, confirmationId: string) {
    return this.request<void>(
      "DELETE",
      `/api/households/${householdId}/transfers/confirmations/${confirmationId}`,
    );
  }

  // ---- incomes ----
  listIncomes(accountId: string) {
    return this.request<IncomeDto[]>("GET", `/api/accounts/${accountId}/incomes`);
  }
  createIncome(accountId: string, body: unknown) {
    return this.request<IncomeDto>("POST", `/api/accounts/${accountId}/incomes`, body);
  }
  updateIncome(id: string, body: unknown) {
    return this.request<IncomeDto>("PATCH", `/api/incomes/${id}`, body);
  }
  deleteIncome(id: string) {
    return this.request<void>("DELETE", `/api/incomes/${id}`);
  }

  // ---- inflows ----
  // Money arriving, whatever its source. `/incomes` above is the external half
  // of these very rows — one table, two doors, and the income door deliberately
  // cannot see a movement between two of your own accounts.
  /** Everything arriving into this account: external income and movements alike. */
  listInflows(accountId: string) {
    return this.request<InflowDto[]>("GET", `/api/accounts/${accountId}/inflows`);
  }
  /** The other face of the same rows: movements *leaving* this account — what
   *  its surplus is already committed to. */
  listOutboundInflows(accountId: string) {
    return this.request<InflowDto[]>("GET", `/api/accounts/${accountId}/inflows/outbound`);
  }
  createInflow(accountId: string, body: unknown) {
    return this.request<InflowDto>("POST", `/api/accounts/${accountId}/inflows`, body);
  }
  /** Everything but which two accounts it runs between: re-pointing an end is
   *  authoring a new movement, and the API refuses it here. */
  updateInflow(id: string, body: unknown) {
    return this.request<InflowDto>("PATCH", `/api/inflows/${id}`, body);
  }
  deleteInflow(id: string) {
    return this.request<void>("DELETE", `/api/inflows/${id}`);
  }
  /** "I moved this money", for one month of one movement — the standalone twin
   *  of `confirmTransfer`, with no household anywhere. Books what the movement
   *  actually delivered against the payments it funded. */
  confirmMovement(inflowId: string, month?: string) {
    return this.request<ConfirmTransferResultDto>(
      "POST",
      `/api/inflows/${inflowId}/confirm${month ? `?month=${month}` : ""}`,
    );
  }
  /** Movements touching this account this month, from both sides: what arrived
   *  here and what left here. Defaults to the current month server-side. */
  listAccountConfirmations(accountId: string, month?: string) {
    return this.request<TransferConfirmationDto[]>(
      "GET",
      `/api/accounts/${accountId}/transfers/confirmations${month ? `?month=${month}` : ""}`,
    );
  }
  /** Nested under the inflow, so it can only ever reach an inflow-scoped
   *  confirmation — a household one keeps its own route and its own rule. */
  unconfirmMovement(inflowId: string, confirmationId: string) {
    return this.request<void>("DELETE", `/api/inflows/${inflowId}/confirmations/${confirmationId}`);
  }
  /**
   * "I moved the money" for a transfer the plan **derived** with no household
   * anywhere — the feed into a pot nobody authored a movement for (decision 9).
   *
   * The third shape, and the one migration 0010 made storable: it carries
   * neither a household nor an inflow, and is scoped by its two accounts, its
   * month and the member who moves it. Posted against the *receiving* account,
   * which is the side the app holds a plan for.
   */
  confirmDerivedTransfer(
    accountId: string,
    body: { fromAccountId: string; toAccountId: string; memberUserId: string },
    month?: string,
  ) {
    return this.request<ConfirmTransferResultDto>(
      "POST",
      `/api/accounts/${accountId}/transfers/confirm${month ? `?month=${month}` : ""}`,
      body,
    );
  }
  /** Nested under the receiving account, so it can only ever reach a
   *  confirmation with no household and no inflow — the household route keeps
   *  its own rule about whose transfers a plain member may un-confirm. */
  unconfirmDerivedTransfer(accountId: string, confirmationId: string) {
    return this.request<void>(
      "DELETE",
      `/api/accounts/${accountId}/transfers/confirmations/${confirmationId}`,
    );
  }

  // ---- payments ----
  listPayments(accountId: string) {
    return this.request<PaymentDto[]>("GET", `/api/accounts/${accountId}/payments`);
  }
  createPayment(accountId: string, body: unknown) {
    return this.request<PaymentDto>("POST", `/api/accounts/${accountId}/payments`, body);
  }
  updatePayment(id: string, body: unknown) {
    return this.request<PaymentDto>("PATCH", `/api/payments/${id}`, body);
  }
  deletePayment(id: string) {
    return this.request<void>("DELETE", `/api/payments/${id}`);
  }
  reorderPayments(accountId: string, orderedPaymentIds: string[]) {
    return this.request<PaymentDto[]>("PATCH", `/api/accounts/${accountId}/payments/reorder`, {
      orderedPaymentIds,
    });
  }

  // ---- money flow over any scope ----
  /**
   * Where money goes across a set of accounts — any set, spanning any number of
   * households and none. The whole set is always asked for: hiding an account
   * from the picture is presentation and must never reach here, because dropping
   * it from the request would drop its money from the others' plans.
   */
  flow(accountIds: readonly string[], asOf?: string) {
    // Built by hand rather than through `query()`: the set is comma-separated,
    // and `URLSearchParams` percent-encodes a comma it does not have to, which
    // makes the request unreadable in a log for no benefit at all.
    return this.request<FlowDto>(
      "GET",
      `/api/flow?accounts=${accountIds.join(",")}${asOf ? `&asOf=${asOf}` : ""}`,
    );
  }

  // ---- overview ----
  overview(asOf?: string) {
    return this.request<OverviewDto>("GET", `/api/overview${asOf ? `?asOf=${asOf}` : ""}`);
  }
  /** What falls due next across every visible account. `days` clamps to 1..90
   *  (default 14); the server caps the feed at 50 rows. */
  upcoming(days?: number, asOf?: string) {
    return this.request<UpcomingDto>("GET", `/api/upcoming${query({ days, asOf })}`);
  }

  // ---- households ----
  createHousehold(name: string) {
    return this.request<{ id: string; name: string }>("POST", "/api/auth/households", { name });
  }
  getHousehold(id: string) {
    return this.request<HouseholdDetailDto>("GET", `/api/auth/households/${id}`);
  }
  inviteMember(householdId: string, email: string, role: HouseholdRole = "member") {
    return this.request<{ id: string }>("POST", `/api/auth/households/${householdId}/members`, {
      email,
      role,
    });
  }
  removeMember(householdId: string, userId: string) {
    return this.request<void>("DELETE", `/api/auth/households/${householdId}/members/${userId}`);
  }
  updateMemberRole(householdId: string, userId: string, role: "admin" | "member") {
    return this.request<{ id: string; role: HouseholdRole }>(
      "PATCH",
      `/api/auth/households/${householdId}/members/${userId}`,
      { role },
    );
  }
  deleteHousehold(id: string) {
    return this.request<void>("DELETE", `/api/auth/households/${id}`);
  }
  shareAccount(accountId: string, householdId: string, permission: "view" | "edit") {
    return this.request<{ id: string }>("POST", `/api/accounts/${accountId}/shares`, {
      householdId,
      permission,
    });
  }
  unshareAccount(accountId: string, shareId: string) {
    return this.request<void>("DELETE", `/api/accounts/${accountId}/shares/${shareId}`);
  }
  setMemberShare(householdId: string, userId: string, shareBp: number) {
    return this.request<{ id: string; contributionShareBp: number }>(
      "PATCH",
      `/api/auth/households/${householdId}/members/${userId}/share`,
      { shareBp },
    );
  }

  // ---- household plan + account roster ----
  householdPlan(id: string, asOf?: string) {
    return this.request<HouseholdPlanDto>(
      "GET",
      `/api/households/${id}/plan${asOf ? `?asOf=${asOf}` : ""}`,
    );
  }
  /** The pooled household plan month by month. Members only, as the plan is. */
  householdProjection(id: string, months?: number, asOf?: string) {
    return this.request<HouseholdProjectionDto>(
      "GET",
      `/api/households/${id}/projection${query({ months, asOf })}`,
    );
  }
  listHouseholdAccounts(id: string) {
    return this.request<HouseholdAccountAssignmentDto[]>("GET", `/api/households/${id}/accounts`);
  }
  assignHouseholdAccount(
    householdId: string,
    accountId: string,
    body: { role: AccountRole; memberUserId?: string | null },
  ) {
    return this.request<HouseholdAccountAssignmentDto>(
      "PUT",
      `/api/households/${householdId}/accounts/${accountId}`,
      body,
    );
  }
  unassignHouseholdAccount(householdId: string, accountId: string) {
    return this.request<void>("DELETE", `/api/households/${householdId}/accounts/${accountId}`);
  }

  // ---- projects ----
  /** Every project you can see: yours, plus a co-member's shared ones. */
  listProjects() {
    return this.request<ProjectDto[]>("GET", "/api/projects");
  }
  createProject(body: {
    name: string;
    description?: string | null;
    targetDate?: string | null;
    visibility?: ProjectVisibility;
  }) {
    return this.request<ProjectDto>("POST", "/api/projects", body);
  }
  /** Owner only, including the visibility flip. Going shared refuses, naming
   *  every payment on an account the household cannot see. */
  updateProject(
    id: string,
    body: {
      name?: string;
      description?: string | null;
      targetDate?: string | null;
      visibility?: ProjectVisibility;
    },
  ) {
    return this.request<ProjectDto>("PATCH", `/api/projects/${id}`, body);
  }
  getProject(id: string) {
    return this.request<ProjectDetailDto>("GET", `/api/projects/${id}`);
  }
  deleteProject(id: string) {
    return this.request<void>("DELETE", `/api/projects/${id}`);
  }

  // ---- export / import ----
  /**
   * Everything you own, as one JSON document.
   *
   * Returns the raw Response rather than a parsed body, because the download
   * needs both halves of it: `await res.blob()` for the bytes and
   * `content-disposition` for the server's filename. (This is also why a plain
   * `<a href="/api/export">` can't do the job — the browser would send no
   * Authorization header.) See lib/files.ts for the save side.
   */
  exportData(): Promise<Response> {
    return this.requestRaw("GET", "/api/export");
  }

  /** Restore an export under this account, with fresh ids. Additive — nothing
   *  existing is touched. `body` is a parsed export file; 422 when it isn't. */
  importData(body: unknown) {
    return this.request<ImportCountsDto>("POST", "/api/import", body);
  }

  // ---- demo data ----
  /** Plant the worked example. 404 when the deployment has it switched off,
   *  409 `demo_not_empty` when the caller already has accounts. */
  seedDemo() {
    return this.request<DemoSeedCountsDto>("POST", "/api/demo/seed");
  }
}

export const api = new ApiClient();
