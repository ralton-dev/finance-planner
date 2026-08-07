import { expect, test } from "@playwright/test";

test.describe("app shell", () => {
  test("redirects to the login screen and renders the form", async ({ page }) => {
    await page.goto("/");
    // A fresh context carries no refresh cookie, so the session probe 401s and
    // the shell falls through to login. (There *is* a backend now — see
    // e2e/stack.mts — so this is the app's real answer, not the absence of one.)
    await expect(page.getByRole("heading", { name: /log in/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("can navigate to the register screen", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: /create account/i })).toBeVisible();
  });
});
