export interface Mailer {
  sendVerificationEmail(to: string, token: string): Promise<void>;
}

/**
 * Dev/test mailer: records sent mail in-memory and logs it. No external
 * provider required to build or run. An SmtpMailer can be added for production
 * (decision #11) without touching call sites.
 */
export class LogMailer implements Mailer {
  public readonly sent: { to: string; token: string }[] = [];

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    this.sent.push({ to, token });
    console.log(`[mailer] verification token for ${to}: ${token}`);
  }
}
