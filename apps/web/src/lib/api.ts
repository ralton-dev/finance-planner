import type {
  AccountDto,
  AccountPlanDto,
  IncomeDto,
  OverviewDto,
  PaymentDto,
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

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

    if (!res.ok) {
      let code = "error";
      let message = res.statusText;
      try {
        const json = (await res.json()) as { error?: { code?: string; message?: string } };
        code = json.error?.code ?? code;
        message = json.error?.message ?? message;
      } catch {
        /* non-JSON error */
      }
      throw new ApiError(res.status, code, message);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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

  // ---- auth ----
  register(body: { email: string; password: string; displayName: string }) {
    return this.request<{ userId: string }>("POST", "/api/auth/register", body);
  }

  async login(body: { email: string; password: string }) {
    const res = await this.request<{ accessToken: string; user: UserDto }>(
      "POST",
      "/api/auth/login",
      body,
    );
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
  deleteAccount(id: string) {
    return this.request<void>("DELETE", `/api/accounts/${id}`);
  }
  getPlan(id: string, asOf?: string) {
    return this.request<AccountPlanDto>(
      "GET",
      `/api/accounts/${id}/plan${asOf ? `?asOf=${asOf}` : ""}`,
    );
  }

  // ---- incomes ----
  listIncomes(accountId: string) {
    return this.request<IncomeDto[]>("GET", `/api/accounts/${accountId}/incomes`);
  }
  createIncome(accountId: string, body: unknown) {
    return this.request<IncomeDto>("POST", `/api/accounts/${accountId}/incomes`, body);
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

  // ---- households ----
  createHousehold(name: string) {
    return this.request<{ id: string; name: string }>("POST", "/api/auth/households", { name });
  }
}

export const api = new ApiClient();
