import type {
  AccountDto,
  AccountPlanDto,
  AccountProjectionDto,
  AccountRole,
  BalanceSnapshotDto,
  ConfirmTransferResultDto,
  ContributionDto,
  DemoSeedCountsDto,
  HouseholdAccountAssignmentDto,
  HouseholdDetailDto,
  HouseholdPlanDto,
  HouseholdProjectionDto,
  HouseholdRole,
  ImportCountsDto,
  IncomeDto,
  LoginResultDto,
  LoginSessionDto,
  MetaDto,
  MonthCloseDto,
  OidcMetaDto,
  OverviewDto,
  PaymentDto,
  PlanPreviewDto,
  ProjectDetailDto,
  ProjectDto,
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

  async tryRefresh(): Promise<boolean> {
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
  updateAccount(
    id: string,
    body: {
      name?: string;
      description?: string | null;
      currency?: string;
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
  closeAccountMonth(accountId: string, month: string) {
    return this.request<MonthCloseDto>("POST", `/api/accounts/${accountId}/close`, { month });
  }
  /** Newest first. */
  listAccountCloses(accountId: string) {
    return this.request<MonthCloseDto[]>("GET", `/api/accounts/${accountId}/closes`);
  }
  reopenAccountMonth(accountId: string, closeId: string) {
    return this.request<void>("DELETE", `/api/accounts/${accountId}/closes/${closeId}`);
  }
  closeHouseholdMonth(householdId: string, month: string) {
    return this.request<MonthCloseDto>("POST", `/api/households/${householdId}/close`, { month });
  }
  listHouseholdCloses(householdId: string) {
    return this.request<MonthCloseDto[]>("GET", `/api/households/${householdId}/closes`);
  }
  reopenHouseholdMonth(householdId: string, closeId: string) {
    return this.request<void>("DELETE", `/api/households/${householdId}/closes/${closeId}`);
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
  listProjects() {
    return this.request<ProjectDto[]>("GET", "/api/projects");
  }
  createProject(body: { name: string; description?: string | null; targetDate?: string | null }) {
    return this.request<ProjectDto>("POST", "/api/projects", body);
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
