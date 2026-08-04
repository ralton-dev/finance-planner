import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, sha256, verifyPassword } from "./passwords.js";
import {
  signAccessToken,
  signPendingTotpToken,
  verifyAccessToken,
  verifyPendingTotpToken,
} from "./tokens.js";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotpCode,
  totpCode,
  verifyTotp,
} from "./totp.js";

describe("passwords", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces unique salts per hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "garbage")).toBe(false);
  });

  it("hashes tokens deterministically", () => {
    const t = randomToken();
    expect(sha256(t)).toBe(sha256(t));
    expect(sha256(t)).toHaveLength(64);
  });
});

describe("tokens", () => {
  it("round-trips an access token", async () => {
    const token = await signAccessToken("secret", { sub: "user-1", email: "a@b.com" });
    const claims = await verifyAccessToken("secret", token);
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("a@b.com");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signAccessToken("secret", { sub: "user-1" });
    await expect(verifyAccessToken("other", token)).rejects.toThrow();
  });

  it("round-trips a pending two-factor token", async () => {
    const token = await signPendingTotpToken("secret", { sub: "user-1", email: "a@b.com" });
    const claims = await verifyPendingTotpToken("secret", token);
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("a@b.com");
  });

  it("keeps pending tokens and access tokens apart", async () => {
    const pending = await signPendingTotpToken("secret", { sub: "user-1" });
    // A step-up ticket must never authenticate a request.
    await expect(verifyAccessToken("secret", pending)).rejects.toThrow();
    // …and an access token must never satisfy the step-up step.
    const access = await signAccessToken("secret", { sub: "user-1" });
    await expect(verifyPendingTotpToken("secret", access)).rejects.toThrow();
  });

  it("expires pending tokens", async () => {
    const token = await signPendingTotpToken("secret", { sub: "user-1" }, -1);
    await expect(verifyPendingTotpToken("secret", token)).rejects.toThrow();
  });
});

describe("base32", () => {
  it("matches the RFC 4648 test vectors (unpadded)", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
  });

  it("round-trips random bytes and tolerates padding / case / spacing", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes → 32 chars, no padding
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode("mzxw6ytb oi").toString()).toBe("foobar");
    expect(base32Decode("MZXW6===").toString()).toBe("foo");
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("MZXW6!")).toThrow(/invalid base32/);
  });
});

describe("totp", () => {
  // RFC 4226 Appendix D uses the ASCII secret "12345678901234567890".
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890"));
  const rfcCodes = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  it("reproduces the RFC 4226 HOTP vectors", () => {
    rfcCodes.forEach((expected, counter) => {
      expect(hotpCode(rfcSecret, counter)).toBe(expected);
    });
  });

  it("derives TOTP counters from the clock", () => {
    // t=0 and t=29s share step 0; t=30s moves to step 1.
    expect(totpCode(rfcSecret, 0)).toBe(rfcCodes[0]);
    expect(totpCode(rfcSecret, 29_999)).toBe(rfcCodes[0]);
    expect(totpCode(rfcSecret, 30_000)).toBe(rfcCodes[1]);
    // A custom step re-slices the same counter sequence.
    expect(totpCode(rfcSecret, 60_000, { step: 60 })).toBe(rfcCodes[1]);
  });

  it("accepts codes inside the drift window and rejects the ones outside it", () => {
    const now = 300_000; // step 10
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, now), now)).toBe(true);
    // ±1 step of clock drift is forgiven by default…
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, now + 30_000), now)).toBe(true);
    // …two steps away is not.
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, now - 60_000), now)).toBe(false);
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, now + 60_000), now)).toBe(false);
    // window: 0 pins verification to the current step only.
    expect(verifyTotp(rfcSecret, totpCode(rfcSecret, now - 30_000), now, { window: 0 })).toBe(
      false,
    );
  });

  it("rejects wrong, malformed and empty codes", () => {
    const now = Date.now();
    expect(verifyTotp(rfcSecret, "000000", 0)).toBe(false); // step 0 is 755224
    expect(verifyTotp(rfcSecret, "", now)).toBe(false);
    expect(verifyTotp(rfcSecret, "12345", now)).toBe(false); // too short
    expect(verifyTotp(rfcSecret, "abcdef", now)).toBe(false); // not digits
    expect(verifyTotp(rfcSecret, "aaaa-bbbb", now)).toBe(false); // a recovery code
  });

  it("ignores the spacing authenticator apps like to add", () => {
    const now = 300_000;
    const code = totpCode(rfcSecret, now);
    expect(verifyTotp(rfcSecret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });

  it("builds an otpauth URI apps can scan", () => {
    const uri = buildOtpauthUri("JBSWY3DPEHPK3PXP", "user@example.com");
    expect(uri).toBe(
      "otpauth://totp/Finance%20Planner:user%40example.com" +
        "?secret=JBSWY3DPEHPK3PXP&issuer=Finance%20Planner&algorithm=SHA1&digits=6&period=30",
    );
    expect(buildOtpauthUri("JBSWY3DPEHPK3PXP", "user@example.com", "Acme")).toContain(
      "otpauth://totp/Acme:user%40example.com?",
    );
  });
});
