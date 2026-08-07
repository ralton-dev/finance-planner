/**
 * The one account the e2e stack seeds and the suite signs in as. Shared by the
 * harness that creates it and the spec that logs in with it, so the two cannot
 * drift apart into a suite that fails on credentials rather than on the app.
 */
export const E2E_USER = {
  email: "e2e@finance-planner.test",
  password: "correct-horse-battery-staple",
  displayName: "E2E Runner",
};

/** What the harness seeded, served by the harness at `/__e2e__/seeded`. */
export interface SeededIds {
  accountId: string;
  householdId: string;
}
