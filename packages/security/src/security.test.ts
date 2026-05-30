import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, sha256, verifyPassword } from "./passwords.js";
import { signAccessToken, verifyAccessToken } from "./tokens.js";

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
});
