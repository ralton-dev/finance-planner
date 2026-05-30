import { type ReactNode, useEffect } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Optional id used for aria-labelledby. When the trigger button passes the
   * same id, the drawer is wired up for assistive tech.
   */
  labelledBy?: string;
}

/**
 * Right-anchored slide-over panel. Backdrop dismisses on click; ESC dismisses
 * too. Body scroll is locked while open so the page beneath doesn't drift.
 */
export function Drawer({ open, onClose, title, children, footer, labelledBy }: DrawerProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} data-testid="drawer-backdrop" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid="drawer"
      >
        <header className="drawer-head">
          <span className="drawer-title" id={labelledBy}>
            {title}
          </span>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close drawer"
          >
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </>
  );
}
