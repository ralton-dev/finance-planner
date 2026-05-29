import { expect, test } from "@playwright/test";

test.describe("home page", () => {
  test("renders the application shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /finance planner/i })).toBeVisible();
    await expect(page.getByText(/plan your savings/i)).toBeVisible();
  });

  test("reports API health status", async ({ page }) => {
    await page.goto("/");
    // The indicator resolves to "reachable" or "unreachable" depending on the
    // API; either proves the health-probe wiring rendered.
    await expect(page.getByText(/reachable|unreachable/)).toBeVisible();
  });
});
