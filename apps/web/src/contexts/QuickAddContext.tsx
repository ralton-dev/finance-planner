import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { IncomeDto, PaymentDto } from "../lib/types.js";

export type QuickAddKind = "payment" | "income" | "account";

interface QuickAddState {
  kind: QuickAddKind | null;
  /**
   * Pre-fill the account picker when opening from an account-scoped surface
   * (the Account detail page, an account row, etc.). Ignored in edit mode.
   */
  accountId?: string;
  /** When set, the drawer renders in edit mode: pre-filled, PATCHes on save. */
  editingPayment?: PaymentDto;
  editingIncome?: IncomeDto;
}

interface LastMutated {
  kind: QuickAddKind;
  accountId?: string;
  /** "create" or "update" — pages can refetch either way; mostly informational. */
  op: "create" | "update";
  timestamp: number;
}

interface QuickAddContextValue {
  state: QuickAddState;
  /** Bumped each time a drawer creates OR updates an entity. Pages subscribe
   *  via useEffect to refetch their data. */
  lastCreated: LastMutated | null;
  openPayment: (accountId?: string) => void;
  openIncome: (accountId?: string) => void;
  openAccount: () => void;
  openEditPayment: (payment: PaymentDto) => void;
  openEditIncome: (income: IncomeDto) => void;
  close: () => void;
  notifyCreated: (kind: QuickAddKind, accountId?: string) => void;
  notifyUpdated: (kind: QuickAddKind, accountId?: string) => void;
}

const QuickAddContext = createContext<QuickAddContextValue | null>(null);

export function QuickAddProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<QuickAddState>({ kind: null });
  const [lastCreated, setLastCreated] = useState<LastMutated | null>(null);

  // Stable function refs: callers can put these in useEffect deps safely.
  const openPayment = useCallback((accountId?: string) => {
    setState({ kind: "payment", accountId });
  }, []);
  const openIncome = useCallback((accountId?: string) => {
    setState({ kind: "income", accountId });
  }, []);
  const openAccount = useCallback(() => setState({ kind: "account" }), []);
  const openEditPayment = useCallback((payment: PaymentDto) => {
    setState({ kind: "payment", accountId: payment.accountId, editingPayment: payment });
  }, []);
  const openEditIncome = useCallback((income: IncomeDto) => {
    setState({ kind: "income", accountId: income.accountId, editingIncome: income });
  }, []);
  const close = useCallback(() => setState({ kind: null }), []);
  const notifyCreated = useCallback((kind: QuickAddKind, accountId?: string) => {
    setLastCreated({ kind, accountId, op: "create", timestamp: Date.now() });
  }, []);
  const notifyUpdated = useCallback((kind: QuickAddKind, accountId?: string) => {
    setLastCreated({ kind, accountId, op: "update", timestamp: Date.now() });
  }, []);

  const value = useMemo<QuickAddContextValue>(
    () => ({
      state,
      lastCreated,
      openPayment,
      openIncome,
      openAccount,
      openEditPayment,
      openEditIncome,
      close,
      notifyCreated,
      notifyUpdated,
    }),
    [
      state,
      lastCreated,
      openPayment,
      openIncome,
      openAccount,
      openEditPayment,
      openEditIncome,
      close,
      notifyCreated,
      notifyUpdated,
    ],
  );

  return <QuickAddContext.Provider value={value}>{children}</QuickAddContext.Provider>;
}

export function useQuickAdd(): QuickAddContextValue {
  const ctx = useContext(QuickAddContext);
  if (!ctx) throw new Error("useQuickAdd must be used within QuickAddProvider");
  return ctx;
}
