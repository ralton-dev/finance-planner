import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, ApiError } from "../lib/api.js";

const MIN_PASSWORD_LENGTH = 8;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Someone opened /reset by hand, or the mail client mangled the link.
  if (!token) {
    return (
      <div className="auth-card">
        <h1>reset password</h1>
        <p className="error" role="alert">
          this link is missing its reset token.
        </p>
        <p className="auth-hint">
          open the link from the email exactly as it was sent, or request a new one.
        </p>
        <p className="muted">
          <Link to="/forgot">request a new link →</Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-card">
        <h1>password updated</h1>
        <p className="auth-hint">you can log in with your new password now.</p>
        <p className="muted">
          <Link to="/login">go to log in →</Link>
        </p>
      </div>
    );
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError("passwords do not match");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_token"
          ? "this reset link is invalid or has expired. request a new one."
          : "could not reset the password. try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>set a new password</h1>
      <form onSubmit={onSubmit} noValidate>
        <label>
          new password
          <input
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label>
          confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </label>
        <p className="auth-hint">at least {MIN_PASSWORD_LENGTH} characters.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "saving…" : "set password"}
        </button>
      </form>
      <p className="muted">
        <Link to="/login">← back to log in</Link>
      </p>
    </div>
  );
}
