import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outbound mail for the whole platform. Lives in its own package because two
 * services now send: auth (verification + password reset) and api (the daily
 * digest). Plain text only — these are transactional messages, not a newsletter.
 */
export interface Mailer {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  /** `link` is a fully-formed reset URL on the public web origin. */
  sendPasswordReset(to: string, link: string): Promise<void>;
  /** A pre-rendered plain-text digest. The caller owns the wording. */
  sendDigest(to: string, subject: string, textBody: string): Promise<void>;
}

/** Where a mailer gets its transport from. A subset of each service's env. */
export interface MailerEnv {
  /** nodemailer transport URL. Unset → mail is logged instead of sent. */
  smtpUrl?: string;
  /** From: header for outbound mail. */
  mailFrom?: string;
}

const DEFAULT_FROM = "Finance Planner <no-reply@finance-planner.local>";

/**
 * Dev/test mailer: records sent mail in-memory and logs it. No external
 * provider required to build or run.
 */
export class LogMailer implements Mailer {
  public readonly sent: { to: string; token: string }[] = [];
  public readonly passwordResets: { to: string; link: string }[] = [];
  public readonly digests: { to: string; subject: string; textBody: string }[] = [];

  /** Defaults to stdout so `new LogMailer()` still works in tests and scripts. */
  constructor(private readonly log: (msg: string) => void = (msg) => console.log(msg)) {}

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    this.sent.push({ to, token });
    this.log(`[mailer] verification token for ${to}: ${token}`);
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.passwordResets.push({ to, link });
    this.log(`[mailer] password reset link for ${to}: ${link}`);
  }

  async sendDigest(to: string, subject: string, textBody: string): Promise<void> {
    this.digests.push({ to, subject, textBody });
    this.log(`[mailer] digest for ${to}: ${subject}`);
  }
}

/**
 * Production mailer. Built from a nodemailer transport URL
 * (e.g. `smtps://user:pass@smtp.example.com:465`).
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string = DEFAULT_FROM,
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

  async sendDigest(to: string, subject: string, textBody: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text: textBody });
  }
}

/**
 * SMTP when configured, otherwise log-only. `log` is where the LogMailer's
 * output goes — pass the service logger so dev mail lands in the same stream as
 * everything else.
 */
export function createMailer(env: MailerEnv, log: (msg: string) => void): Mailer {
  return env.smtpUrl
    ? new SmtpMailer(env.smtpUrl, env.mailFrom ?? DEFAULT_FROM)
    : new LogMailer(log);
}
