import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import { toMinor } from "../lib/money.js";
import type { AccountDto } from "../lib/types.js";
import { Drawer } from "./Drawer.js";

interface Props {
  /** When non-null, the drawer is open and editing this account. */
  account: AccountDto | null;
  onClose: () => void;
  onSaved: (updated: AccountDto) => void;
  onDeleted: () => void;
  /** Pre-focus a specific field on open (e.g. when clicking the Buffer KPI). */
  focusField?: "monthlyBuffer";
}

export function AccountSettingsDrawer({ account, onClose, onSaved, onDeleted, focusField }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [buffer, setBuffer] = useState("0");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const bufferRef = useRef<HTMLInputElement>(null);

  // Reset form whenever the target account changes.
  useEffect(() => {
    if (!account) return;
    setName(account.name);
    setDescription(account.description ?? "");
    setBuffer((account.monthlyBufferMinor / 100).toFixed(2));
    setConfirmName("");
    setErr(null);
  }, [account]);

  // Focus the buffer field when invoked from the Buffer KPI.
  useEffect(() => {
    if (!account || focusField !== "monthlyBuffer") return;
    const t = setTimeout(() => {
      bufferRef.current?.focus();
      bufferRef.current?.select();
    }, 80);
    return () => clearTimeout(t);
  }, [account, focusField]);

  if (!account) return null;
  const canEdit = account.owner || account.permission === "edit";
  const isOwner = !!account.owner;

  async function save(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (!account) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateAccount(account.id, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        monthlyBufferMinor: toMinor(buffer),
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not save changes.");
    } finally {
      setBusy(false);
    }
  }

  async function destroy(): Promise<void> {
    if (!account || confirmName !== account.name) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteAccount(account.id);
      onDeleted();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not delete account.");
    } finally {
      setBusy(false);
    }
  }

  const titleId = `drawer-${account.id}`;

  return (
    <Drawer
      open
      onClose={onClose}
      labelledBy={titleId}
      title={
        <>
          account settings <span className="scope">/ {account.name}</span>
        </>
      }
      footer={
        canEdit ? (
          <>
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>
              cancel
            </button>
            <button type="button" onClick={() => save()} disabled={busy}>
              {busy ? "saving…" : "save"}
            </button>
          </>
        ) : (
          <button type="button" className="ghost" onClick={onClose}>
            close
          </button>
        )
      }
    >
      {!canEdit && (
        <p className="muted" style={{ marginBottom: "1rem" }}>
          you have view-only access to this account — no fields can be changed.
        </p>
      )}

      <form onSubmit={save}>
        <label>
          name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            required
          />
        </label>

        <label>
          description (optional)
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!canEdit}
            placeholder="e.g. primary current account"
          />
        </label>

        {/* A fact, not a field: the chip `RoleCell` uses for a role that cannot
         *  change. An input here would look editable and be refused with a 422. */}
        <div className="field">
          <span className="field-label">currency</span>
          <span className="tag-status idle">{account.currency}</span>
          <span className="field-hint">
            fixed when the account was created — planning runs per currency, and every amount here
            is already in this one. an account in a different currency is a different account.
          </span>
        </div>

        <label>
          monthly buffer
          <input
            ref={bufferRef}
            value={buffer}
            onChange={(e) => setBuffer(e.target.value)}
            disabled={!canEdit}
            inputMode="decimal"
            placeholder="0.00"
          />
          <span className="field-hint">
            major units of {account.currency} (e.g. <code>100.00</code>). reserved off the top
            before goals are funded.
          </span>
        </label>

        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
      </form>

      {isOwner && (
        <section className="danger-zone">
          <h3>danger zone</h3>
          <p className="hint">
            deleting removes the account and all of its incomes, payments, shares, and plan
            snapshots. there is no undo. type <b>{account.name}</b> to confirm.
          </p>
          <input
            placeholder={account.name}
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            disabled={busy}
            aria-label="type account name to confirm deletion"
          />
          <button
            type="button"
            className="danger"
            onClick={destroy}
            disabled={confirmName !== account.name || busy}
          >
            {busy ? "deleting…" : "delete account"}
          </button>
        </section>
      )}
    </Drawer>
  );
}
