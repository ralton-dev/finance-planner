import { type FormEvent, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import type { TotpSetupDto, UserDto } from "../lib/types.js";
import { useAsync } from "../lib/useAsync.js";

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
          <div className="subhead">your account and how you sign in.</div>
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

      <TwoFactorSection enabled={user.totpEnabled === true} onChanged={() => me.refetch()} />
    </section>
  );
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
