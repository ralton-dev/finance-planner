import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { api, ApiError } from "../lib/api.js";

/** Second-factor input mode. Recovery codes are alphanumeric, TOTP codes aren't. */
type Factor = "totp" | "recovery";

export function LoginPage() {
  const { login, completeTotpLogin } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step-up state. The pending token lives here and nowhere else — never in
  // localStorage, never in the URL — so closing the tab abandons the attempt.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [factor, setFactor] = useState<Factor>("totp");
  const [code, setCode] = useState("");

  const sso = useOidcProvider();

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const outcome = await login(email, password);
      if (outcome.totpRequired) {
        setPendingToken(outcome.pendingToken);
        return;
      }
      navigate("/");
    } catch {
      setError("invalid email or password");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setBusy(true);
    try {
      await completeTotpLogin(
        factor === "recovery"
          ? { pendingToken, recoveryCode: code.trim() }
          : { pendingToken, code: code.trim() },
      );
      navigate("/");
    } catch (err) {
      setError(secondFactorError(err));
    } finally {
      setBusy(false);
    }
  }

  function backToCredentials(): void {
    setPendingToken(null);
    setCode("");
    setFactor("totp");
    setError(null);
  }

  function switchFactor(next: Factor): void {
    setFactor(next);
    setCode("");
    setError(null);
  }

  if (pendingToken) {
    return (
      <div className="auth-card">
        <h1>two-factor</h1>
        <p className="auth-hint">
          {factor === "recovery"
            ? "enter one of the recovery codes you saved when you turned 2fa on."
            : "enter the 6-digit code from your authenticator app."}
        </p>
        <form onSubmit={onSubmitCode}>
          {factor === "recovery" ? (
            <label>
              recovery code
              <input
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </label>
          ) : (
            <label>
              code
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
              />
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "verifying…" : "verify"}
          </button>
        </form>
        <p className="muted">
          <button
            type="button"
            className="action"
            onClick={() => switchFactor(factor === "recovery" ? "totp" : "recovery")}
          >
            {factor === "recovery"
              ? "use your authenticator app instead"
              : "use a recovery code instead"}
          </button>
        </p>
        <p className="muted">
          <button type="button" className="action muted" onClick={backToCredentials}>
            ← back
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>log in</h1>
      <form onSubmit={onSubmit}>
        <label>
          email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "logging in…" : "log in"}
        </button>
      </form>
      {sso && (
        <>
          <div className="auth-divider">
            <span>or</span>
          </div>
          <button
            type="button"
            className="ghost auth-sso"
            onClick={() => {
              window.location.href = "/api/auth/oidc/login";
            }}
          >
            sign in with sso
          </button>
          {sso.issuer && <p className="auth-hint auth-issuer">via {sso.issuer}</p>}
        </>
      )}
      <p className="muted">
        <Link to="/forgot">forgot password?</Link>
      </p>
      <p className="muted">
        no account? <Link to="/register">register →</Link>
      </p>
    </div>
  );
}

/** Asks the API once whether SSO is configured. A failed probe reads as "off":
 *  the button stays hidden rather than dead-ending the user. */
function useOidcProvider(): { issuer: string } | null {
  const [provider, setProvider] = useState<{ issuer: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .oidcMeta()
      .then((meta) => {
        if (!cancelled && meta.enabled) setProvider({ issuer: meta.issuer });
      })
      .catch(() => {
        /* SSO not available — leave the button hidden. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return provider;
}

function secondFactorError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_code") return "wrong code, try again";
    if (err.code === "invalid_pending_token") return "that login attempt expired — start again";
    if (err.status === 422) return "enter a code first";
  }
  return "could not verify that code";
}
