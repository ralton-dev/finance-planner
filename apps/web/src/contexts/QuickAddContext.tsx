import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type QuickAddKind = "payment" | "income" | "account";

interface QuickAddState {
  kind: QuickAddKind | null;
  /**
   * Pre-fill the account picker when opening from an account-scoped surface
   * (the Account detail page, an account row, etc.).
   */
  accountId?: string;
}

interface LastCreated {
  kind: QuickAddKind;
  accountId?: string;
  timestamp: number;
}

interface QuickAddContextValue {
  state: QuickAddState;
  /** Bumped each time a drawer successfully creates an entity. Pages subscribe
   *  via useEffect to refetch their data when relevant. */
  lastCreated: LastCreated | null;
  openPayment: (accountId?: string) => void;
  openIncome: (accountId?: string) => void;
  openAccount: () => void;
  close: () => void;
  notifyCreated: (kind: QuickAddKind, accountId?: string) => void;
}

const QuickAddContext = createContext<QuickAddContextValue | null>(null);

export function QuickAddProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<QuickAddState>({ kind: null });
  const [lastCreated, setLastCreated] = useState<LastCreated | null>(null);

  // Stable function refs: callers can put these in useEffect deps safely.
  const openPayment = useCallback((accountId?: string) => {
    setState({ kind: "payment", accountId });
  }, []);
  const openIncome = useCallback((accountId?: string) => {
    setState({ kind: "income", accountId });
  }, []);
  const openAccount = useCallback(() => setState({ kind: "account" }), []);
  const close = useCallback(() => setState({ kind: null }), []);
  const notifyCreated = useCallback((kind: QuickAddKind, accountId?: string) => {
    setLastCreated({ kind, accountId, timestamp: Date.now() });
  }, []);

  const value = useMemo<QuickAddContextValue>(
    () => ({ state, lastCreated, openPayment, openIncome, openAccount, close, notifyCreated }),
    [state, lastCreated, openPayment, openIncome, openAccount, close, notifyCreated],
  );

  return <QuickAddContext.Provider value={value}>{children}</QuickAddContext.Provider>;
}

export function useQuickAdd(): QuickAddContextValue {
  const ctx = useContext(QuickAddContext);
  if (!ctx) throw new Error("useQuickAdd must be used within QuickAddProvider");
  return ctx;
}
