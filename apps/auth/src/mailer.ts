import nodemailer, { type Transporter } from "nodemailer";
import type { AuthEnv } from "./env.js";

export interface Mailer {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  /** `link` is a fully-formed reset URL on the public web origin. */
  sendPasswordReset(to: string, link: string): Promise<void>;
}

/**
 * Dev/test mailer: records sent mail in-memory and logs it. No external
 * provider required to build or run.
 */
export class LogMailer implements Mailer {
  public readonly sent: { to: string; token: string }[] = [];
  public readonly passwordResets: { to: string; link: string }[] = [];

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    this.sent.push({ to, token });
    console.log(`[mailer] verification token for ${to}: ${token}`);
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.passwordResets.push({ to, link });
    console.log(`[mailer] password reset link for ${to}: ${link}`);
  }
}

/**
 * Production mailer. Built from a nodemailer transport URL
 * (e.g. `smtps://user:pass@smtp.example.com:465`). Plain-text only — these are
 * two transactional messages, not a newsletter.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: "Verify your Finance Planner email",
      text: `Use this code to verify your email address:\n\n${token}\n\nIf you didn't create an account, ignore this message.`,
    });
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: "Reset your Finance Planner password",
      text: `Set a new password using this link (valid for one hour):\n\n${link}\n\nIf you didn't ask for a reset, ignore this message — your password is unchanged.`,
    });
  }
}

/** SMTP when configured, otherwise log-only. */
export function createMailer(env: AuthEnv): Mailer {
  return env.smtpUrl ? new SmtpMailer(env.smtpUrl, env.mailFrom) : new LogMailer();
}
