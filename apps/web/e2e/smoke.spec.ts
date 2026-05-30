import { expect, test } from "@playwright/test";

test.describe("app shell", () => {
  test("redirects to the login screen and renders the form", async ({ page }) => {
    await page.goto("/");
    // No backend in the E2E harness, so the session can't be restored → login.
    await expect(page.getByRole("heading", { name: /log in/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("can navigate to the register screen", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: /create account/i })).toBeVisible();
  });
});
