import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

/** Where the choice lives between sessions. */
export const PRIVACY_STORAGE_KEY = "fp.privacy";
/** Class stamped on the document root; the stylesheet does the rest. */
export const PRIVACY_CLASS = "privacy";

interface PrivacyValue {
  /** True while amounts are blurred. */
  hidden: boolean;
  toggle: () => void;
  setHidden: (hidden: boolean) => void;
}

/**
 * Default value rather than a throwing hook: a chart or an amount rendered
 * outside the provider (a test, a login screen) should simply show its numbers,
 * not crash.
 */
const PrivacyContext = createContext<PrivacyValue>({
  hidden: false,
  toggle: () => {},
  setHidden: () => {},
});

function readStored(): boolean {
  try {
    return localStorage.getItem(PRIVACY_STORAGE_KEY) === "1";
  } catch {
    // Private-mode Safari and friends: no persistence, still a working toggle.
    return false;
  }
}

/**
 * Privacy mode: "someone is looking over my shoulder". Blurs every rendered
 * amount by putting one class on the document root — instant, no reload, and it
 * reaches the drawers and the command palette, which render outside the page
 * tree. Persisted so it survives a refresh, because a session that silently
 * forgot would be worse than useless.
 */
export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(readStored);

  useEffect(() => {
    document.documentElement.classList.toggle(PRIVACY_CLASS, hidden);
    try {
      localStorage.setItem(PRIVACY_STORAGE_KEY, hidden ? "1" : "0");
    } catch {
      /* no persistence available — the toggle still works for this session */
    }
  }, [hidden]);

  // Unmount cleanup only, so the class never outlives the app (or a test).
  useEffect(() => () => document.documentElement.classList.remove(PRIVACY_CLASS), []);

  const toggle = useCallback(() => setHidden((on) => !on), []);

  return (
    <PrivacyContext.Provider value={{ hidden, toggle, setHidden }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy(): PrivacyValue {
  return useContext(PrivacyContext);
}
