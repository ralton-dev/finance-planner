import { describe, expect, it } from "vitest";
import { createMailer, LogMailer, SmtpMailer } from "./mailer.js";

describe("LogMailer", () => {
  it("records what it was asked to send and logs a line per message", async () => {
    const lines: string[] = [];
    const mailer = new LogMailer((msg) => lines.push(msg));

    await mailer.sendVerificationEmail("user@example.com", "tok-123");
    await mailer.sendPasswordReset("user@example.com", "https://app.test/reset?token=tok-456");
    await mailer.sendDigest("user@example.com", "Your digest", "Phone bill — 45.00 GBP");

    expect(mailer.sent).toEqual([{ to: "user@example.com", token: "tok-123" }]);
    expect(mailer.passwordResets).toEqual([
      { to: "user@example.com", link: "https://app.test/reset?token=tok-456" },
    ]);
    expect(mailer.digests).toEqual([
      { to: "user@example.com", subject: "Your digest", textBody: "Phone bill — 45.00 GBP" },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("tok-123");
  });

  it("works with no logger injected (defaults to stdout)", async () => {
    const mailer = new LogMailer();
    await mailer.sendDigest("a@b.test", "s", "body");
    expect(mailer.digests).toHaveLength(1);
  });
});

describe("createMailer", () => {
  it("falls back to the log mailer when no SMTP URL is configured", () => {
    const mailer = createMailer({ mailFrom: "Test <no-reply@test.local>" }, () => {});
    expect(mailer).toBeInstanceOf(LogMailer);
  });

  it("builds an SMTP mailer once a transport URL is set", () => {
    const mailer = createMailer(
      { smtpUrl: "smtp://user:pass@smtp.test:2525", mailFrom: "Test <no-reply@test.local>" },
      () => {},
    );
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it("routes log-mailer output through the injected logger", async () => {
    const lines: string[] = [];
    const mailer = createMailer({}, (msg) => lines.push(msg));
    await mailer.sendPasswordReset("user@example.com", "https://app.test/reset");
    expect(lines[0]).toContain("user@example.com");
  });
});
