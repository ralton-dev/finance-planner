import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { api, ApiError } from "../lib/api.js";
import { filenameFromDisposition, readTextFile, saveBlob } from "../lib/files.js";
import type { ImportCountsDto, TotpSetupDto, UserDto } from "../lib/types.js";
import { useAsync } from "../lib/useAsync.js";

/** Used when the server's content-disposition is missing or unreadable. */
const EXPORT_FALLBACK_NAME = "finance-planner-export.json";

export function SettingsPage() {
  // Read straight from /me rather than the session user: totpEnabled changes
  // under us as the panels below run, and this is the field they key off.
  const me = useAsync<UserDto>(() => api.me(), []);

  if (me.error) return <p className="error">could not load your account.</p>;
  if (me.loading || !me.data) return <p className="muted">loading…</p>;

  const user = me.data;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>settings</h1>
          <div className="subhead">your account, your data, and how you sign in.</div>
        </div>
      </div>

      <div className="section-head">
        <h2>account</h2>
      </div>
      {/* Read-only: the API exposes no profile-update endpoint, and no
       *  password-change endpoint either — a password is changed by going
       *  through the /forgot → /reset flow. Add a section here if/when
       *  POST /api/auth/password/change exists. */}
      <div className="settings-panel">
        <div className="settings-row">
          <span className="k">email</span>
          <span className="v">{user.email}</span>
        </div>
        <div className="settings-row">
          <span className="k">display name</span>
          <span className="v">{user.displayName}</span>
        </div>
      </div>

      <NotificationsSection notifyEmail={user.notifyEmail === true} />

      <TwoFactorSection enabled={user.totpEnabled === true} onChanged={() => me.refetch()} />

      <DataSection />

      <DangerZone email={user.email} />
    </section>
  );
}

/** The digest opt-in. One switch, flipped optimistically: the request is a
 *  single boolean, so waiting on it would be all latency and no information. */
function NotificationsSection({ notifyEmail }: { notifyEmail: boolean }) {
  const [on, setOn] = useState(notifyEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The prop is the server's answer: a refetch elsewhere on the page wins over
  // whatever this switch is showing.
  useEffect(() => setOn(notifyEmail), [notifyEmail]);

  async function toggle(): Promise<void> {
    const next = !on;
    setOn(next);
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({ notifyEmail: next });
    } catch {
      setOn(!next);
      setError("could not save that — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <h2>notifications</h2>
      </div>
      <div className="settings-panel">
        <label className="toggle-row">
          <input type="checkbox" checked={on} disabled={busy} onChange={() => void toggle()} />
          <span>daily email digest</span>
        </label>
        <p className="auth-hint">
          sends a morning email when payments are due or transfers are planned in the next 7 days
          (needs SMTP configured on the server)
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

/** A parsed export file waiting for the user to say yes. */
interface PendingImport {
  fileName: string;
  /** Whatever the file parsed to. Not validated here — the server is the judge
   *  of a well-formed export, and guessing wrong would reject good files. */
  data: unknown;
}

/** Take your data out, or put a previous export back in. */
function DataSection() {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportCountsDto | null>(null);

  async function exportEverything(): Promise<void> {
    setExporting(true);
    setExportError(null);
    try {
      const res = await api.exportData();
      const name = filenameFromDisposition(res.headers.get("content-disposition"));
      saveBlob(await res.blob(), name ?? EXPORT_FALLBACK_NAME);
    } catch {
      setExportError("could not build that export — try again.");
    } finally {
      setExporting(false);
    }
  }

  async function pickFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = e.target;
    const file = input.files?.[0];
    // Let the same file be chosen again after a cancel — without this, picking
    // it a second time fires no change event.
    input.value = "";
    setPending(null);
    setImported(null);
    setImportError(null);
    if (!file) return;

    try {
      setPending({ fileName: file.name, data: JSON.parse(await readTextFile(file)) });
    } catch {
      // Broken JSON never reaches the network: nothing to ask the server about.
      setImportError("that file isn't valid json.");
    }
  }

  async function confirmImport(): Promise<void> {
    if (!pending) return;
    setImporting(true);
    setImportError(null);
    try {
      setImported(await api.importData(pending.data));
      setPending(null);
    } catch (err) {
      const rejected = err instanceof ApiError && err.status === 422;
      setImportError(
        rejected
          ? "that file doesn't look like a finance-planner export"
          : "could not import that file — try again.",
      );
      // A rejected file will be rejected again; anything else is worth retrying,
      // so only drop the confirmation when the file itself is the problem.
      if (rejected) setPending(null);
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <h2>data</h2>
      </div>
      <div className="settings-panel">
        <div className="settings-actions">
          <button type="button" onClick={() => void exportEverything()} disabled={exporting}>
            {exporting ? "preparing…" : "export everything"}
          </button>
        </div>
        <p className="auth-hint">
          a json file with your accounts, incomes, payments, contributions, balance history, month
          closes and projects. households and accounts shared with you are not included — they
          belong to the people you share them with.
        </p>
        {exportError && (
          <p className="error" role="alert">
            {exportError}
          </p>
        )}

        <div className="data-divider" />

        <label className="file-picker">
          import from export
          <input type="file" accept=".json,application/json" onChange={(e) => void pickFile(e)} />
        </label>

        {pending && (
          <div className="import-confirm">
            {/* The picker is cleared on pick (so the same file can be chosen
                twice), which leaves this as the only sign of what is queued. */}
            <p className="import-file">{pending.fileName}</p>
            <p className="auth-hint">
              adds {summarizeExport(pending.data)} — import is additive, nothing is deleted —
              continue?
            </p>
            <div className="settings-actions">
              <button type="button" onClick={() => void confirmImport()} disabled={importing}>
                {importing ? "importing…" : "import"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setPending(null)}
                disabled={importing}
              >
                cancel
              </button>
            </div>
          </div>
        )}

        {imported && <p className="import-result">imported {countsLine(imported)}</p>}
        {importError && (
          <p className="error" role="alert">
            {importError}
          </p>
        )}
      </div>
    </>
  );
}

/** Wiping the account: two steps, and the second one asks for the email in
 *  full. The API has no undo, so neither does this. */
function DangerZone({ email }: { email: string }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = typedEmail.trim() === email && password.length > 0;

  async function destroy(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.deleteMe({ password });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "wrong password"
          : "could not delete your account — try again.",
      );
      setBusy(false);
      return;
    }
    // The account is gone; the session behind it is meaningless. logout()
    // tolerates the dead token, so this always lands on the login screen.
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <section className="danger-zone settings-danger">
      <h3>danger zone</h3>
      {!open ? (
        <>
          <p className="hint">
            deleting removes your accounts, incomes, payments, contributions, balance history,
            projects and any household you created. there is no undo.
          </p>
          <button type="button" className="danger" onClick={() => setOpen(true)}>
            delete account and all data
          </button>
        </>
      ) : (
        <>
          <p className="hint">
            this erases everything above. type <b>{email}</b> to confirm.
          </p>
          <input
            aria-label="type your email to confirm deletion"
            placeholder={email}
            autoComplete="off"
            spellCheck={false}
            value={typedEmail}
            onChange={(e) => {
              setTypedEmail(e.target.value);
              setError(null);
            }}
            disabled={busy}
          />
          <input
            aria-label="password"
            type="password"
            placeholder="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            disabled={busy}
          />
          <p className="hint">signed in with sso only? type anything here.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="danger"
              onClick={() => void destroy()}
              disabled={!armed || busy}
            >
              {busy ? "deleting…" : "delete my account"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOpen(false);
                setTypedEmail("");
                setPassword("");
                setError(null);
              }}
              disabled={busy}
            >
              keep my account
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** "2 accounts · 7 payments · 1 project" — what a picked file says it carries,
 *  read off the same shape the export writes. Best-effort by design: a file we
 *  can't read counts as nothing and the server still gets the final say. */
function summarizeExport(file: unknown): string {
  const doc = file as { accounts?: unknown; projects?: unknown } | null;
  const accounts = Array.isArray(doc?.accounts) ? doc.accounts : [];
  const projects = Array.isArray(doc?.projects) ? doc.projects : [];
  const nested = (key: string): number =>
    accounts.reduce((total: number, account: unknown) => {
      const list = (account as Record<string, unknown> | null)?.[key];
      return total + (Array.isArray(list) ? list.length : 0);
    }, 0);

  const parts = [
    plural(accounts.length, "account"),
    plural(nested("incomes"), "income"),
    plural(nested("payments"), "payment"),
    plural(projects.length, "project"),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : "whatever is in that file";
}

/** "imported 2 accounts · 5 payments" — the rows the server actually created. */
function countsLine(counts: ImportCountsDto): string {
  const parts = [
    plural(counts.accounts, "account"),
    plural(counts.incomes, "income"),
    plural(counts.payments, "payment"),
    plural(counts.contributions, "contribution"),
    plural(counts.balanceSnapshots, "balance check-in"),
    plural(counts.closes, "month close"),
    plural(counts.projects, "project"),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : "nothing — that file was empty";
}

/** "2 accounts", "1 income", or null when there is nothing to mention. */
function plural(count: number, noun: string): string | null {
  if (!count) return null;
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

type Stage = "idle" | "scan" | "codes" | "disable";

function TwoFactorSection({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [stage, setStage] = useState<Stage>("idle");
  const [setup, setSetup] = useState<TotpSetupDto | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setStage("idle");
    setSetup(null);
    setError(null);
  }

  async function startSetup(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      setSetup(await api.totpSetup());
      setStage("scan");
    } catch (err) {
      setError(totpError(err, "could not start two-factor setup."));
    } finally {
      setBusy(false);
    }
  }

  async function enable(code: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const res = await api.totpEnable(code);
      setRecoveryCodes(res.recoveryCodes);
      setSetup(null);
      setStage("codes");
      onChanged();
    } catch (err) {
      setError(totpError(err, "could not turn on two-factor."));
    } finally {
      setBusy(false);
    }
  }

  async function disable(code: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await api.totpDisable(code);
      reset();
      onChanged();
    } catch (err) {
      setError(totpError(err, "could not turn off two-factor."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <h2>two-factor auth</h2>
        <span className="meta">[authenticator app]</span>
      </div>
      <div className="settings-panel">
        <div className="settings-row">
          <span className="k">status</span>
          <span className="v">
            <span className={enabled ? "tag-status ok" : "tag-status idle"}>
              {enabled ? "enabled" : "not enabled"}
            </span>
          </span>
        </div>

        {stage === "idle" && (
          <>
            <p className="auth-hint">
              {enabled
                ? "a code from your authenticator app is required every time you log in."
                : "add a code from an authenticator app on top of your password."}
            </p>
            <div className="settings-actions">
              {enabled ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setError(null);
                    setStage("disable");
                  }}
                >
                  disable 2fa
                </button>
              ) : (
                <button type="button" onClick={startSetup} disabled={busy}>
                  {busy ? "starting…" : "enable 2fa"}
                </button>
              )}
            </div>
          </>
        )}

        {stage === "scan" && setup && (
          <ScanStep
            setup={setup}
            busy={busy}
            error={error}
            onConfirm={enable}
            onCancel={reset}
            onClearError={() => setError(null)}
          />
        )}

        {stage === "codes" && (
          <RecoveryCodesPanel codes={recoveryCodes} onDismiss={() => setStage("idle")} />
        )}

        {stage === "disable" && (
          <DisableStep
            busy={busy}
            error={error}
            onConfirm={disable}
            onCancel={reset}
            onClearError={() => setError(null)}
          />
        )}

        {stage === "idle" && error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

function ScanStep({
  setup,
  busy,
  error,
  onConfirm,
  onCancel,
  onClearError,
}: {
  setup: TotpSetupDto;
  busy: boolean;
  error: string | null;
  onConfirm: (code: string) => Promise<void>;
  onCancel: () => void;
  onClearError: () => void;
}) {
  const [code, setCode] = useState("");

  function submit(e: FormEvent): void {
    e.preventDefault();
    void onConfirm(code.trim());
  }

  return (
    <div className="totp-step">
      <p className="auth-hint">
        scan or paste into your authenticator, then enter the code it shows.
      </p>
      <div className="settings-row">
        <span className="k">secret</span>
        <code className="totp-secret">{groupSecret(setup.secret)}</code>
      </div>
      <div className="settings-row">
        <span className="k">otpauth uri</span>
        <code className="totp-uri">{setup.otpauthUri}</code>
      </div>
      <div className="settings-actions">
        <CopyButton text={setup.otpauthUri} label="copy uri" />
        <CopyButton text={setup.secret} label="copy secret" />
      </div>
      <form onSubmit={submit}>
        <label>
          code from your app
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ""));
              onClearError();
            }}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <button type="submit" disabled={busy || code.length === 0}>
            {busy ? "verifying…" : "confirm"}
          </button>
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function DisableStep({
  busy,
  error,
  onConfirm,
  onCancel,
  onClearError,
}: {
  busy: boolean;
  error: string | null;
  onConfirm: (code: string) => Promise<void>;
  onCancel: () => void;
  onClearError: () => void;
}) {
  const [code, setCode] = useState("");

  function submit(e: FormEvent): void {
    e.preventDefault();
    void onConfirm(code.trim());
  }

  return (
    <form onSubmit={submit} className="totp-step">
      <p className="auth-hint">
        confirm with a code from your authenticator app, or one of your unused recovery codes.
      </p>
      <label>
        code or recovery code
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            onClearError();
          }}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-actions">
        <button type="submit" className="danger" disabled={busy || code.trim().length === 0}>
          {busy ? "disabling…" : "confirm disable"}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          cancel
        </button>
      </div>
    </form>
  );
}

/** The codes are readable exactly once — the server stores only hashes — so
 *  this panel is dismissed by an explicit acknowledgement, not by navigation. */
function RecoveryCodesPanel({ codes, onDismiss }: { codes: string[]; onDismiss: () => void }) {
  return (
    <div className="recovery-panel">
      <h3>recovery codes</h3>
      <p className="auth-hint">
        save these somewhere safe. each one logs you in once if you lose your authenticator.{" "}
        <b>they will never be shown again.</b>
      </p>
      <div className="recovery-codes" aria-label="recovery codes">
        {codes.map((c) => (
          <code key={c}>{c}</code>
        ))}
      </div>
      <div className="settings-actions">
        <CopyButton text={codes.join("\n")} label="copy all" />
        <button type="button" onClick={onDismiss}>
          i've saved these
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost tiny"
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "copied ✓" : label}
    </button>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  // navigator.clipboard is absent on insecure origins (and in jsdom).
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Base32 secrets are far easier to type by hand in groups of four. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(" ");
}

function totpError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_code") return "wrong code, try again";
    if (err.code === "totp_already_enabled") return "two-factor is already on for this account.";
    if (err.code === "totp_not_started") return "that setup expired — start again.";
  }
  return fallback;
}
