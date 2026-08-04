import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { usePrivacy } from "../contexts/PrivacyContext.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, HouseholdDto, UserDto } from "../lib/types.js";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  action: () => void;
  /** Optional searchable keywords beyond the label. */
  keywords?: string;
}

/**
 * Cmd-K / Ctrl-K command palette. Mount once at App level. Listens globally
 * for the chord, opens a centered overlay, filters commands as the user
 * types, and executes the selected one on Enter.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { openPayment, openIncome, openAccount } = useQuickAdd();
  const { hidden, toggle: togglePrivacy } = usePrivacy();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh accounts + households when the palette opens — they may have
  // changed since last render. Skip the fetch when closed.
  const accounts = useAsync<AccountDto[]>(
    () => (open ? api.listAccounts() : Promise.resolve([])),
    [open],
  );
  const me = useAsync<UserDto>(() => (open ? api.me() : Promise.resolve({} as UserDto)), [open]);

  // Global keyboard shortcut: Cmd+K (mac) or Ctrl+K (everywhere else).
  useEffect(() => {
    function handler(e: globalThis.KeyboardEvent): void {
      const isModK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isModK) {
        e.preventDefault();
        setOpen((cur) => !cur);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Focus the input and reset state every time we open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  function close(): void {
    setOpen(false);
  }

  const commands = useMemo<Command[]>(() => {
    const close_ = close;
    const list: Command[] = [
      {
        id: "nav-today",
        label: "go to today",
        hint: "/",
        group: "navigate",
        keywords: "overview home",
        action: () => {
          navigate("/");
          close_();
        },
      },
      {
        id: "nav-accounts",
        label: "go to accounts",
        hint: "/accounts",
        group: "navigate",
        action: () => {
          navigate("/accounts");
          close_();
        },
      },
      {
        id: "nav-projects",
        label: "go to projects",
        hint: "/projects",
        group: "navigate",
        action: () => {
          navigate("/projects");
          close_();
        },
      },
      {
        id: "nav-households",
        label: "go to households",
        hint: "/households",
        group: "navigate",
        action: () => {
          navigate("/households");
          close_();
        },
      },
      {
        id: "add-account",
        label: "new account",
        group: "quick add",
        keywords: "create",
        action: () => {
          openAccount();
          close_();
        },
      },
      {
        id: "add-income",
        label: "new income",
        group: "quick add",
        keywords: "create",
        action: () => {
          openIncome();
          close_();
        },
      },
      {
        id: "add-payment",
        label: "new payment",
        group: "quick add",
        keywords: "create",
        action: () => {
          openPayment();
          close_();
        },
      },
      {
        id: "toggle-privacy",
        label: hidden ? "show amounts" : "hide amounts",
        hint: "h a",
        group: "view",
        keywords: "privacy blur shoulder screenshot",
        action: () => {
          togglePrivacy();
          close_();
        },
      },
    ];

    // Per-account jump + add commands. Only include editable accounts in the
    // "add" variants; "open" works for any visible account.
    for (const a of accounts.data ?? []) {
      list.push({
        id: `open-account-${a.id}`,
        label: `open ${a.name}`,
        hint: a.currency,
        group: "accounts",
        keywords: "go view",
        action: () => {
          navigate(`/accounts/${a.id}`);
          close_();
        },
      });
      if (a.owner || a.permission === "edit") {
        list.push({
          id: `add-payment-${a.id}`,
          label: `add payment to ${a.name}`,
          group: "quick add",
          keywords: "new",
          action: () => {
            openPayment(a.id);
            close_();
          },
        });
        list.push({
          id: `add-income-${a.id}`,
          label: `add income to ${a.name}`,
          group: "quick add",
          keywords: "new",
          action: () => {
            openIncome(a.id);
            close_();
          },
        });
      }
    }

    // Per-household jump commands.
    for (const h of (me.data?.households ?? []) as HouseholdDto[]) {
      list.push({
        id: `open-household-${h.id}`,
        label: `open household ${h.name}`,
        group: "households",
        keywords: "go view",
        action: () => {
          navigate(`/households/${h.id}`);
          close_();
        },
      });
    }

    return list;
  }, [
    accounts.data,
    me.data,
    navigate,
    openAccount,
    openIncome,
    openPayment,
    hidden,
    togglePrivacy,
  ]);

  const filtered = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.keywords ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  // Clamp the active index when filtered results shrink.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [activeIdx, filtered.length]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[activeIdx]?.action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  if (!open) return null;

  // Group commands for display while preserving filter order.
  const groups: { name: string; items: { cmd: Command; idx: number }[] }[] = [];
  const groupMap = new Map<string, { cmd: Command; idx: number }[]>();
  filtered.forEach((cmd, idx) => {
    let items = groupMap.get(cmd.group);
    if (!items) {
      items = [];
      groupMap.set(cmd.group, items);
      groups.push({ name: cmd.group, items });
    }
    items.push({ cmd, idx });
  });

  return (
    <>
      <div className="palette-backdrop" onClick={close} data-testid="palette-backdrop" />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input-row">
          <span className="palette-prompt">›</span>
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="search · jump · run command…"
            aria-label="command palette input"
          />
          <span className="palette-esc">esc</span>
        </div>
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">no commands match.</div>
          ) : (
            groups.map((g) => (
              <div className="palette-group" key={g.name}>
                <div className="palette-group-title">{g.name}</div>
                {g.items.map(({ cmd, idx }) => (
                  <button
                    type="button"
                    key={cmd.id}
                    className={`palette-item${idx === activeIdx ? " active" : ""}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={cmd.action}
                  >
                    <span className="palette-item-label">{cmd.label}</span>
                    {cmd.hint && <span className="palette-item-hint">{cmd.hint}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
