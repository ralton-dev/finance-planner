-- 0005_auth_hardening.sql — harden sign-in.
-- Adds TOTP two-factor enrolment on users, hashed single-use recovery codes,
-- and short-lived password-reset tokens (mirroring email_verification_tokens).
-- Idempotent: safe to apply against an already-migrated database.

-- Two-factor enrolment. The secret is staged by /auth/totp/setup and only
-- becomes binding once totp_enabled_at is set (a valid code was proven).
-- Clearing the secret clears the timestamp, so 2FA can never be half-on.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;

-- Single-use fallbacks for a lost authenticator. Hashed at rest (scrypt), and
-- kept after use (used_at set) so a replay is recognisably spent, not unknown.
CREATE TABLE IF NOT EXISTS auth.recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON auth.recovery_codes (user_id);

-- "Set a new password" tickets, mailed as a link. Single-use: the row is
-- deleted on redemption; expiry is enforced by the service, not the schema.
CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON auth.password_reset_tokens (user_id);
