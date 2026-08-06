import { type ReactNode, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import type { PlanDebugDto, PlanDebugLabelsDto, PlanDebugScopeDto } from "../lib/types.js";
import { useAsync } from "../lib/useAsync.js";

const EMPTY_LABELS: PlanDebugLabelsDto = { accounts: {}, users: {}, households: {} };

function collectLabels(data: PlanDebugDto): PlanDebugLabelsDto {
  const labels: PlanDebugLabelsDto = { accounts: {}, users: {}, households: {} };
  for (const scope of data.scopes) {
    Object.assign(labels.accounts, scope.labels.accounts);
    Object.assign(labels.users, scope.labels.users);
    Object.assign(labels.households, scope.labels.households);
  }
  return labels;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function labelId(
  id: string,
  labels: Record<string, string>,
  fallback: string,
  includeId = false,
): string {
  const name = labels[id];
  if (!name) return includeId ? `${fallback} ${shortId(id)}` : fallback;
  return includeId ? `${name} [${id}]` : name;
}

function accountLabel(id: string, labels: PlanDebugLabelsDto, includeId = false): string {
  return labelId(id, labels.accounts, "account", includeId);
}

function householdLabel(id: string, labels: PlanDebugLabelsDto, includeId = false): string {
  return labelId(id, labels.households, "household", includeId);
}

function subjectLabel(data: PlanDebugDto, labels = collectLabels(data)): string {
  switch (data.subject.kind) {
    case "account":
      return accountLabel(data.subject.accountId, labels);
    case "household":
      return householdLabel(data.subject.householdId, labels);
    case "user":
      return "user";
  }
}

function isAccountIdKey(key?: string): boolean {
  return (
    key === "accountId" ||
    key === "fromAccountId" ||
    key === "toAccountId" ||
    key === "sourceAccountId"
  );
}

function isUserIdKey(key?: string): boolean {
  return (
    key === "userId" || key === "memberUserId" || key === "ownerUserId" || key === "bearerUserId"
  );
}

interface TraceEntityLabels {
  incomes: Record<string, string>;
  movements: Record<string, string>;
  payments: Record<string, string>;
}

function collectTraceEntityLabels(value: unknown): TraceEntityLabels {
  const labels: TraceEntityLabels = { incomes: {}, movements: {}, payments: {} };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const row = node as Record<string, unknown>;
    if (typeof row.incomeId === "string" && typeof row.name === "string" && row.name.trim()) {
      labels.incomes[row.incomeId] = row.name;
    }
    if (typeof row.inflowId === "string" && typeof row.name === "string" && row.name.trim()) {
      labels.movements[row.inflowId] = row.name;
    }
    if (typeof row.paymentId === "string") {
      if (typeof row.paymentName === "string" && row.paymentName.trim()) {
        labels.payments[row.paymentId] = row.paymentName;
      } else if (typeof row.name === "string" && row.name.trim()) {
        labels.payments[row.paymentId] = row.name;
      }
    }
    for (const entryValue of Object.values(row)) visit(entryValue);
  };
  visit(value);
  return labels;
}

function entityLabel(id: string, labels: Record<string, string>, fallback: string): string {
  return labels[id] ?? fallback;
}

function labelTraceIds(
  value: unknown,
  labels: PlanDebugLabelsDto,
  entities: TraceEntityLabels,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    if (key === "accountIds") {
      return value.map((item) =>
        typeof item === "string"
          ? accountLabel(item, labels)
          : labelTraceIds(item, labels, entities),
      );
    }
    if (key === "inflowIds") {
      return value.map((item) =>
        typeof item === "string" ? entityLabel(item, entities.movements, "movement") : item,
      );
    }
    return value.map((item) => labelTraceIds(item, labels, entities));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        labelTraceIds(entryValue, labels, entities, entryKey),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (isAccountIdKey(key)) return accountLabel(value, labels);
  if (isUserIdKey(key)) return labelId(value, labels.users, "user");
  if (key === "householdId")
    return labels.households[value] ? householdLabel(value, labels) : "household";
  if (key === "scopeId") return "scope";
  if (key === "incomeId") return entityLabel(value, entities.incomes, "income");
  if (key === "inflowId") return entityLabel(value, entities.movements, "movement");
  if (key === "paymentId") return entityLabel(value, entities.payments, "payment");
  return value;
}

function logScope(scope: PlanDebugScopeDto): void {
  const title =
    scope.householdId && scope.labels.households[scope.householdId]
      ? householdLabel(scope.householdId, scope.labels)
      : scope.accountIds.map((id) => accountLabel(id, scope.labels)).join(", ") || "scope";
  const visibleLabels = {
    accounts: Object.values(scope.labels.accounts).sort(),
    users: Object.values(scope.labels.users).sort(),
    households: Object.values(scope.labels.households).sort(),
  };
  console.groupCollapsed(`[finance-planner debug] ${title}`);
  console.log(scope.report);
  console.debug("labels", visibleLabels);
  console.debug(
    "structured trace (labels applied)",
    labelTraceIds(scope.trace, scope.labels, collectTraceEntityLabels(scope.trace)),
  );
  console.groupEnd();
}

function logDebugReport(data: PlanDebugDto): void {
  console.groupCollapsed(`[finance-planner debug] ${subjectLabel(data)} @ ${data.asOfDate}`);
  for (const scope of data.scopes) logScope(scope);
  console.groupEnd();
}

const TOKEN_RE =
  /(\b[A-Z]{3} -?\d+ minor\b|\b\d{4}-\d{2}-\d{2}\b|#[0-9]+|\[[^\]]+\]|->|\b(?:true|false|null|none)\b|\b(?:income|funded|required|shortfall|buffer|priority|status|scope|role|owner|household|account|member|currency|amount|confirmed|moving|from|reason|onTrack)\b|=)/g;

function tokenClass(token: string): string {
  if (/^[A-Z]{3} -?\d+ minor$/.test(token)) return "debug-token-money";
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return "debug-token-date";
  if (/^#[0-9]+$/.test(token)) return "debug-token-rank";
  if (/^\[.+\]$/.test(token)) return "debug-token-id";
  if (token === "->") return "debug-token-arrow";
  if (token === "true" || token === "false" || token === "null" || token === "none")
    return "debug-token-bool";
  if (token === "=") return "debug-token-operator";
  return "debug-token-key";
}

function highlightLine(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) parts.push(line.slice(last, index));
    parts.push(
      <span className={tokenClass(token)} key={`${index}-${token}`}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function lineClass(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "debug-line debug-line-blank";
  if (
    trimmed.startsWith("Finance Planner") ||
    trimmed.startsWith("Currency ") ||
    trimmed.startsWith("Phase ") ||
    trimmed.startsWith("Per ")
  ) {
    return "debug-line debug-line-heading";
  }
  if (
    trimmed.startsWith("scope:") ||
    trimmed.startsWith("household:") ||
    trimmed.startsWith("as of:")
  ) {
    return "debug-line debug-line-meta";
  }
  if (trimmed.startsWith("#")) return "debug-line debug-line-step";
  if (trimmed.startsWith("-")) return "debug-line debug-line-bullet";
  return "debug-line";
}

function DebugReport({ report }: { report: string }) {
  return (
    <pre className="debug-report">
      <code>
        {report.split("\n").map((line, index) => (
          <span className={lineClass(line)} key={index}>
            {highlightLine(line)}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

function DebugOptions({ data }: { data?: PlanDebugDto }) {
  const labels = data ? collectLabels(data) : EMPTY_LABELS;
  const accounts = Object.entries(labels.accounts).sort((a, b) => a[1].localeCompare(b[1]));
  const households = Object.entries(labels.households).sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <details className="debug-options" open>
      <summary>debug options</summary>
      <div className="debug-options-grid">
        <div>
          <code>debug=engine</code>
          <span>turns on the hidden calculation trace; it is not a separate engine.</span>
        </div>
        <div>
          <code>account=&lt;account-id&gt;</code>
          <span>filters the trace to the full scope containing that account.</span>
        </div>
        <div>
          <code>household=&lt;household-id&gt;</code>
          <span>filters the trace to that household roster. Do not combine it with account.</span>
        </div>
        <div>
          <code>asOf=YYYY-MM-DD</code>
          <span>optional calculation date; defaults to today.</span>
        </div>
        <div>
          <code>no account or household</code>
          <span>plans every visible scope, including household-scoped plans you can view.</span>
        </div>
      </div>
      {(accounts.length > 0 || households.length > 0) && (
        <div className="debug-targets">
          {households.map(([id, name]) => (
            <a href={`/debug/plan?debug=engine&household=${id}`} key={id}>
              household: {name}
            </a>
          ))}
          {accounts.map(([id, name]) => (
            <a href={`/debug/plan?debug=engine&account=${id}`} key={id}>
              account: {name}
            </a>
          ))}
        </div>
      )}
    </details>
  );
}

export function DebugPlanPage() {
  const [params, setParams] = useSearchParams();
  const enabled = params.get("debug") === "engine";
  const account = params.get("account") ?? undefined;
  const household = params.get("household") ?? undefined;
  const asOf = params.get("asOf") ?? undefined;

  const debug = useAsync<PlanDebugDto | null>(
    () => (enabled ? api.debugPlan({ account, household, asOf }) : Promise.resolve(null)),
    [enabled, account, household, asOf],
  );

  useEffect(() => {
    if (debug.data) logDebugReport(debug.data);
  }, [debug.data]);

  useEffect(() => {
    if (enabled) return;
    const next = new URLSearchParams(params);
    next.set("debug", "engine");
    setParams(next, { replace: true });
  }, [enabled, params, setParams]);

  if (!enabled) {
    return <p className="muted">loading debug trace…</p>;
  }

  if (account && household) {
    return (
      <section>
        <h1>
          plan debug <span className="scope">/ invalid target</span>
        </h1>
        <p className="error">choose account or household, not both.</p>
      </section>
    );
  }

  if (debug.loading) return <p className="muted">loading…</p>;
  if (debug.error || !debug.data) {
    return (
      <section>
        <h1>
          plan debug <span className="scope">/ failed</span>
        </h1>
        <p className="error">{debug.error?.message ?? "could not load debug trace."}</p>
      </section>
    );
  }

  const data = debug.data;
  const labels = collectLabels(data);
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            plan debug <span className="scope">/ {subjectLabel(data, labels)}</span>
          </h1>
          <div className="subhead">
            {data.asOfDate} · {data.scopes.length} {data.scopes.length === 1 ? "scope" : "scopes"}
          </div>
        </div>
        <div className="actions">
          <button type="button" className="ghost" onClick={() => logDebugReport(data)}>
            print to console
          </button>
        </div>
      </div>

      <DebugOptions data={data} />

      {data.scopes.length === 0 ? (
        <p className="muted">no planned scopes.</p>
      ) : (
        data.scopes.map((scope) => {
          const title = scope.householdId
            ? householdLabel(scope.householdId, scope.labels)
            : scope.accountIds.map((id) => accountLabel(id, scope.labels)).join(", ") || "scope";
          return (
            <div className="scope-block" key={scope.scopeId}>
              <div className="section-head">
                <h2>{title}</h2>
                <span className="meta">
                  {scope.accountIds.length} {scope.accountIds.length === 1 ? "account" : "accounts"}{" "}
                  · {scope.accountIds.map((id) => accountLabel(id, scope.labels)).join(", ")}
                </span>
              </div>
              <DebugReport report={scope.report} />
            </div>
          );
        })
      )}
    </section>
  );
}
