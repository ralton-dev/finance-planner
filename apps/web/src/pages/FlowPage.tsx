import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Amount } from "../components/Amount.js";
import { ChartFrame } from "../components/ChartFrame.js";
import { DownloadButton } from "../components/DownloadButton.js";
import { FlowSankey } from "../components/FlowSankey.js";
import { ApiError, api } from "../lib/api.js";
import { accountLabel, parseAccountIds, visibleFlow } from "../lib/flow.js";
import { formatMinor } from "../lib/money.js";
import { deleteScope, readScopes, type SavedScope, saveScope } from "../lib/scopes.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, FlowDto, HouseholdDto, UserDto } from "../lib/types.js";

/**
 * The money-flow diagram, over any set of accounts.
 *
 * It used to live at `/households/:id/plan` and could only ever draw one
 * household, which meant the most interesting picture — everything you own, at
 * once — could not be drawn at all. Scope here is a set the user chooses: two
 * households' accounts and a standalone pot is an ordinary request.
 *
 * Three things travel in the URL, and the distinction between the first two is
 * load-bearing:
 *
 *   `?accounts=`  what the diagram is **computed over**. Sent to the server.
 *   `?hide=`      what is left **out of the picture**. Never sent anywhere: it
 *                 changes what is drawn and no figure at all. Narrowing the
 *                 scope instead would take the hidden account's money out of
 *                 every other account's plan, which is exactly the bug this
 *                 separation exists to prevent.
 *   `?household=` a preset: that household's roster, asked as an ordinary
 *                 scope. Same request, same diagram, same figures — a household
 *                 is a set of accounts somebody else chose. The endpoint names
 *                 the member behind a derived transfer, so nothing is lost by
 *                 not asking for the household plan.
 *
 * So every picture is a URL — bookmarkable, shareable, reopenable. Names on top
 * of that are a local convenience; see `lib/scopes.ts`.
 */

/** Whether a name is worth offering to save under. */
const trimmed = (value: string): string => value.trim().slice(0, 60);

export function FlowPage() {
  const [params, setParams] = useSearchParams();
  const householdId = params.get("household");
  const scopeIds = parseAccountIds(params.get("accounts"));
  const hidden = useMemo(() => new Set(parseAccountIds(params.get("hide"))), [params]);
  const scopeKey = scopeIds.join(",");

  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const me = useAsync<UserDto>(() => api.me(), []);

  // One request per scope, and none at all for the empty one. Toggling
  // visibility is deliberately absent from these deps: hiding an account must
  // not re-ask the server anything, because the answer would be a different
  // plan and that is the whole thing being avoided.
  //
  // A household is resolved to its roster and then asked as an ordinary scope.
  // It used to be answered by reshaping `api.householdPlan()` in the browser,
  // which is a second derivation of money crossing an account boundary and drew
  // a worse picture than the one already on the server: a household plan carries
  // authored movements as one bucket at each end, so both ends of every one of
  // them left for `elsewhere` while the accounts they ran between sat on the
  // screen (issue #43). Decision 31 settles it — one engine, and this page asks
  // it the same question for a household as for any other set of accounts.
  //
  // The roster comes from `/accounts` rather than from the plan because a roster
  // is all that is wanted: the plan endpoint would run the whole household
  // funding pass to hand back a list of ids the assignment rows already hold.
  const source = useAsync<FlowDto | null>(() => {
    if (householdId) {
      return api
        .listHouseholdAccounts(householdId)
        .then((roster) => (roster.length > 0 ? api.flow(roster.map((a) => a.accountId)) : null));
    }
    if (scopeKey) return api.flow(scopeKey.split(","));
    return Promise.resolve(null);
  }, [householdId, scopeKey]);

  const [scopes, setScopes] = useState<SavedScope[]>(readScopes);
  const [name, setName] = useState("");
  const chartRef = useRef<HTMLDivElement>(null);

  const flow = source.data ?? null;
  const drawn = flow ? visibleFlow(flow, hidden) : null;
  const households = (me.data?.households ?? []) as HouseholdDto[];

  /**
   * What the "everything you own" preset selects.
   *
   * Ownership, never access (decision 20). The preset used to select every
   * account the caller can *see*, which on a household includes a co-member's
   * account shared in — so every aggregate on this page was then computed over
   * somebody else's money under a button that explicitly claimed it was theirs.
   * The filter is `AccountsPage`'s idiom, and `owner` absent reads as "not
   * yours" there too.
   *
   * Nothing is lost by narrowing it: the household buttons beside it still give
   * the wider view, and the chips below add any visible account back by hand.
   * And no figure's derivation moves — WP-AE established the diagram's
   * denominator is legitimately a set the user chooses, and this changes only
   * which set the preset hands it.
   */
  const owned = useMemo(() => (accounts.data ?? []).filter((a) => a.owner), [accounts.data]);

  /** Point the page at a set of accounts. Always writes an explicit set: a
   *  preset is a starting point, not a mode to be stuck in. */
  function setScope(ids: readonly string[], hide: readonly string[] = []): void {
    const next = new URLSearchParams();
    if (ids.length > 0) next.set("accounts", ids.join(","));
    if (hide.length > 0) next.set("hide", hide.join(","));
    setParams(next);
  }

  /** Add or remove an account from what is computed. */
  function toggleInScope(accountId: string): void {
    const current = flow && householdId ? flow.accounts.map((a) => a.accountId) : scopeIds;
    const next = current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId];
    setScope(
      next,
      [...hidden].filter((id) => next.includes(id)),
    );
  }

  /** Show or hide an account already in scope. Rewrites `hide` and nothing
   *  else, so the request that produced these figures is untouched. */
  function toggleVisible(accountId: string): void {
    const next = new URLSearchParams(params);
    const hide = hidden.has(accountId)
      ? [...hidden].filter((id) => id !== accountId)
      : [...hidden, accountId];
    if (hide.length > 0) next.set("hide", hide.join(","));
    else next.delete("hide");
    setParams(next);
  }

  function onSave(): void {
    const label = trimmed(name);
    if (!label || !flow) return;
    setScopes(
      saveScope({
        name: label,
        accountIds: flow.accounts.map((a) => a.accountId),
        hiddenAccountIds: [...hidden],
      }),
    );
    setName("");
  }

  const label = householdId
    ? (households.find((h) => h.id === householdId)?.name ?? "household")
    : flow
      ? `${flow.accounts.length} ${flow.accounts.length === 1 ? "account" : "accounts"}`
      : "nothing chosen";

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            money flow <span className="scope">/ {label}</span>
          </h1>
          <div className="subhead">
            {drawn
              ? `${drawn.accounts.length} of ${flow!.accounts.length} drawn · ` +
                `${formatMinor(drawn.totalInflowMinor, drawn.currency)} in from outside · ` +
                `as-of ${drawn.asOfDate}`
              : "choose the accounts this picture is drawn over"}
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>scope</h2>
        <span className="meta">[what the diagram is computed over]</span>
      </div>
      <div className="scope-picker">
        <div className="scope-presets">
          <button
            type="button"
            className="ghost tiny"
            onClick={() => setScope(owned.map((a) => a.id))}
            disabled={owned.length === 0}
          >
            everything you own
          </button>
          {households.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`ghost tiny${householdId === h.id ? " active" : ""}`}
              aria-pressed={householdId === h.id}
              onClick={() => setParams(new URLSearchParams({ household: h.id }))}
            >
              {h.name}
            </button>
          ))}
        </div>
        <div className="scope-chips" role="group" aria-label="accounts in scope">
          {(accounts.data ?? []).map((a) => {
            const inScope = flow
              ? flow.accounts.some((n) => n.accountId === a.id)
              : scopeIds.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                className={inScope ? "scope-chip in" : "scope-chip"}
                aria-pressed={inScope}
                onClick={() => toggleInScope(a.id)}
              >
                {a.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="section-head">
        <h2>saved</h2>
        <span className="meta">[named pictures, kept in this browser]</span>
      </div>
      <div className="scope-picker">
        <div className="scope-presets">
          <input
            className="scope-name"
            value={name}
            placeholder="name this picture…"
            aria-label="name this picture"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
            }}
          />
          <button
            type="button"
            className="ghost tiny"
            onClick={onSave}
            disabled={!trimmed(name) || !flow}
          >
            save
          </button>
        </div>
        {scopes.length === 0 ? (
          <p className="muted" style={{ fontSize: "12px" }}>
            nothing saved yet. every picture is already a URL — this only puts a name on one.
          </p>
        ) : (
          <div className="scope-chips">
            {scopes.map((s) => (
              <span key={s.name} className="scope-saved">
                <button
                  type="button"
                  className="scope-chip"
                  onClick={() => setScope(s.accountIds, s.hiddenAccountIds)}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  className="scope-drop"
                  aria-label={`forget ${s.name}`}
                  onClick={() => setScopes(deleteScope(s.name))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* What the server refused, in the server's own words, because the two
          refusals this page can provoke are both facts about the chosen scope
          that a reader can act on: more accounts than one diagram covers, and a
          scope spanning two currencies, which has no honest ribbon width in a
          system that holds no rates. Neither rule is restated here — restating
          it is how a client and a server come to disagree — and neither is
          worked around by quietly drawing a subset, which would answer a
          question nobody asked. A transport failure has no such sentence, so it
          gets the bare one. */}
      {source.error && (
        <p className="error">
          {source.error instanceof ApiError
            ? `could not draw this scope — ${source.error.message}.`
            : "could not draw this scope."}
        </p>
      )}
      {source.loading && <p className="muted">loading…</p>}

      {drawn && (
        <>
          <div className="section-head">
            <h2>money flow</h2>
            <span className="meta">[income → accounts → movements → spending]</span>
            <span className="spacer" />
            <DownloadButton targetRef={chartRef} name="money-flow" />
          </div>
          <ChartFrame ref={chartRef}>
            <FlowSankey flow={drawn} />
          </ChartFrame>

          <div className="section-head">
            <h2>per account</h2>
            <span className="meta">[hiding one changes the picture and no figure]</span>
          </div>
          {/* Five columns and a control. On a phone the two that describe the
              month rather than move it fold away; the wrapper scrolls the rest. */}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="sticky-col">account</th>
                  <th className="num">income</th>
                  <th className="num">spending</th>
                  <th className="num">left over</th>
                  <th className="num wide-only">shortfall</th>
                  <th>in the picture</th>
                </tr>
              </thead>
              <tbody>
                {flow!.accounts.map((a) => (
                  <tr key={a.accountId} className={hidden.has(a.accountId) ? "dim-row" : ""}>
                    <td className="name sticky-col">
                      {/* An account on this household's roster that the reader
                          may not see arrives with its figures and without its
                          name, and the row prints the absence rather than
                          leaving a blank cell or dropping a row the totals
                          above are counted over. In the same voice as a name,
                          undimmed, exactly as `PlanTable` prints a sender it
                          may not name — and as the node beside it must, since
                          a Sankey label has no second colour to say it in. */}
                      <span>{accountLabel(a)}</span>
                      {a.shortfallMinor > 0 && (
                        <span className="row-sub">
                          {"short "}
                          <Amount minor={a.shortfallMinor} currency={flow!.currency} />
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {a.incomeMinor > 0 ? formatMinor(a.incomeMinor, flow!.currency) : "—"}
                    </td>
                    <td className="num">
                      {a.spendingMinor > 0 ? formatMinor(a.spendingMinor, flow!.currency) : "—"}
                    </td>
                    {/* Green is a month that works, and a negative residual is
                        not one — the household table's rule, for its reason.
                        WP-Q stopped flooring this figure so that a member
                        holding their income somewhere other than the account
                        their transfers leave (decision 11) could see they have
                        to consolidate; printing the minus in green says the
                        opposite of the thing the sign was kept for. */}
                    <td className={`num ${a.leftoverMinor < 0 ? "warn" : "ok"}`}>
                      {formatMinor(a.leftoverMinor, flow!.currency)}
                    </td>
                    <td className={`num wide-only${a.shortfallMinor > 0 ? " warn" : " dim"}`}>
                      {a.shortfallMinor > 0 ? formatMinor(a.shortfallMinor, flow!.currency) : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ghost tiny"
                        aria-pressed={!hidden.has(a.accountId)}
                        aria-label={`${hidden.has(a.accountId) ? "show" : "hide"} ${accountLabel(a)}`}
                        onClick={() => toggleVisible(a.accountId)}
                      >
                        {hidden.has(a.accountId) ? "show" : "hide"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!source.loading && !flow && !source.error && (
        <p className="muted" style={{ fontSize: "12px" }}>
          pick some accounts above, or start from a preset.
        </p>
      )}
    </section>
  );
}
