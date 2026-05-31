import { type FormEvent, useEffect, useState } from "react";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api, ApiError } from "../lib/api.js";
import { toMinor } from "../lib/money.js";
import { Drawer } from "./Drawer.js";

/** Quick-add drawer: create a new account. Opened from the sidebar or anywhere
 *  via `useQuickAdd().openAccount()`. */
export function NewAccountDrawer() {
  const { state, close, notifyCreated } = useQuickAdd();
  const open = state.kind === "account";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [buffer, setBuffer] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setCurrency("GBP");
    setOpeningBalance("0");
    setBuffer("0");
    setBusy(false);
    setErr(null);
  }, [open]);

  if (!open) return null;

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createAccount({
        name: name.trim(),
        description: description.trim() || undefined,
        currency: currency.toUpperCase(),
        openingBalanceMinor: toMinor(openingBalance),
        monthlyBufferMinor: toMinor(buffer),
      });
      notifyCreated("account", created.id);
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not create account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={close}
      title="new account"
      footer={
        <>
          <button type="button" className="ghost" onClick={close} disabled={busy}>
            cancel
          </button>
          <button type="button" onClick={() => submit()} disabled={busy || !name.trim()}>
            {busy ? "creating…" : "create account"}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label>
          name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Current Account"
            required
            autoFocus
          />
        </label>

        <label>
          description (optional)
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. primary current account"
          />
        </label>

        <label>
          currency
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            required
            style={{ width: "6rem" }}
          />
          <span className="field-hint">iso 4217 code (e.g. GBP, USD, EUR).</span>
        </label>

        <label>
          opening balance
          <input
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
          <span className="field-hint">
            informational only — v1 doesn't carry balances month-to-month.
          </span>
        </label>

        <label>
          monthly buffer
          <input
            value={buffer}
            onChange={(e) => setBuffer(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
          <span className="field-hint">reserved off the top before goals are funded.</span>
        </label>

        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
      </form>
    </Drawer>
  );
}
