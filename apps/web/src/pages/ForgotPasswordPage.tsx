import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api.js";

/** The one and only outcome copy. The endpoint answers 204 whether or not the
 *  address exists, and so does this screen — nothing here may hint at whether
 *  an account was found. */
const CONFIRMATION = "if that email has an account, a reset link is on its way.";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch {
      // Only a transport/server failure can land here — the endpoint never
      // reports whether the address matched — so this stays enumeration-safe.
      setError("could not send the reset link. try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>reset password</h1>
      {sent ? (
        <>
          <p className="auth-hint">{CONFIRMATION}</p>
          <p className="auth-hint">the link expires shortly, so use it soon.</p>
          <p className="muted">
            <Link to="/login">← back to log in</Link>
          </p>
        </>
      ) : (
        <>
          <p className="auth-hint">
            we'll email you a link to set a new password. no account is ever revealed here.
          </p>
          <form onSubmit={onSubmit}>
            <label>
              email
              <input
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? "sending…" : "send reset link"}
            </button>
          </form>
          <p className="muted">
            <Link to="/login">← back to log in</Link>
          </p>
        </>
      )}
    </div>
  );
}
