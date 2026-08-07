/**
 * The spec that would have caught #42.
 *
 * `1409e5f` deleted six close routes while the client still called all six. The
 * account page and the household plan page fetched 404s on every load and CI
 * stayed green through it, because the only e2e test in the repo loaded the
 * login screen and the pages themselves *rendered* — a `useAsync` that fails
 * paints an error strip inside an otherwise perfectly good page, and two of the
 * call sites, on the overview and the household plan, swallowed the failure
 * entirely with `.catch(() => null)`, leaving no mark on screen at all.
 *
 * Those two are gone (`4e56de7`, `a2acd76`) and both pages now say what they
 * could not read. It changes nothing here: a strip a person has to notice is
 * still not a failing build, and this suite is what makes a 404 into one.
 *
 * So this suite does not assert on text. It signs in, walks the pages, and
 * **fails the run on any response the browser received with a status of 400 or
 * more**. That is the assertion; everything else here exists to make sure it is
 * given something to look at.
 *
 * Guarding against the way this kind of spec usually fails — passing because it
 * checked nothing:
 *
 *   - the listener is attached before the first navigation, never after;
 *   - every visit asserts a floor on the number of `/api` responses *it*
 *     recorded, so a page that silently stopped fetching fails rather than
 *     coasts;
 *   - the run asserts that specific endpoints were among them, so a page that
 *     404s its way to an empty render cannot pass on volume alone;
 *   - and the totals are printed, so a green run says how much it looked at.
 */
import { expect, test } from "@playwright/test";
import { E2E_USER, type SeededIds } from "./fixture.js";

/** One response the browser received, and whether we had signed in yet. */
interface Seen {
  method: string;
  url: string;
  path: string;
  status: number;
  beforeLogin: boolean;
}

/**
 * The only non-2xx a healthy run is allowed to contain.
 *
 * `POST /api/auth/refresh` → 401 on a cold boot: the SPA probes for an existing
 * session before it renders anything, and on a browser with no refresh cookie
 * the honest answer is 401. It is allowed **only before the login succeeds** —
 * a blanket "ignore 401" would be useless, because 401 is exactly what a broken
 * auth route returns. After sign-in, a 401 from refresh fails the run.
 *
 * Redirects are not failures: `status >= 400` is the bar, so a 302 or a 304 on
 * a static asset passes, as it should.
 */
function isAllowed(seen: Seen): boolean {
  if (seen.status < 400) return true;
  return seen.status === 401 && seen.path === "/api/auth/refresh" && seen.beforeLogin;
}

function format(seen: Seen): string {
  return `${seen.status} ${seen.method} ${seen.url}`;
}

test.describe("a signed-in session fetches nothing broken", () => {
  // Seven navigations, each waiting for the page's own fetches to settle. Five
  // seconds locally; the default 30s per test leaves no room on a cold shared
  // runner, and a timeout here would be a red that says nothing about the app.
  test.describe.configure({ timeout: 120_000 });

  // One test, one login. Auth throttles login at 5/min per IP and a Playwright
  // run is a single IP; the harness builds auth with `rateLimit: false` so this
  // cannot bite, but a suite that signed in per test would be one config change
  // away from failing on 429s that say nothing about the app.
  test("signs in and opens the overview, an account and a household", async ({ page, request }) => {
    const seen: Seen[] = [];
    let loggedIn = false;

    // Attached before the first goto. A listener added after a navigation
    // records nothing from it and the assertion below would then be checking an
    // empty list — which is the failure this whole file is a reaction to.
    page.on("response", (res) => {
      const url = res.url();
      seen.push({
        method: res.request().method(),
        url,
        path: new URL(url).pathname,
        status: res.status(),
        beforeLogin: !loggedIn,
      });
    });
    page.on("requestfailed", (req) => {
      seen.push({
        method: req.method(),
        url: req.url(),
        path: new URL(req.url()).pathname,
        // A request that never got a response is not a status, but it is
        // certainly a failure, and 599 sorts with the rest of them.
        status: 599,
        beforeLogin: !loggedIn,
      });
    });

    const seeded = (await (await request.get("/__e2e__/seeded")).json()) as SeededIds;

    /** Navigate, let the page's fetches settle, and hand back only what this
     *  visit recorded. */
    async function visit(path: string): Promise<Seen[]> {
      const from = seen.length;
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      return seen.slice(from);
    }

    /** Every `/api` response a visit produced. */
    const apiOf = (visited: Seen[]): Seen[] => visited.filter((s) => s.path.startsWith("/api/"));

    // ---- sign in ----
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /log in/i })).toBeVisible();
    await page.getByLabel(/email/i).fill(E2E_USER.email);
    await page.getByLabel(/password/i).fill(E2E_USER.password);
    await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/login"),
      page.getByRole("button", { name: /^log in$/i }).click(),
    ]);
    loggedIn = true;
    await page.waitForLoadState("networkidle");
    expect(
      seen.some((s) => s.path === "/api/auth/login" && s.status === 200),
      "the login request itself was never observed",
    ).toBe(true);

    // ---- the walk ----
    const pages: { label: string; path: string; expect: string[]; floor: number }[] = [
      {
        label: "overview",
        path: "/",
        // Five reads of its own, plus householdPlan per household. That last
        // one used to be `.catch(() => null)`, so a 404 there was invisible on
        // screen and visible only here; it now paints a strip above the fold,
        // which somebody still has to be looking at. Here it fails the run.
        expect: ["/api/auth/me", "/api/overview", "/api/accounts", "/api/upcoming"],
        floor: 5,
      },
      {
        label: "accounts list",
        path: "/accounts",
        expect: ["/api/accounts", "/api/overview"],
        floor: 2,
      },
      {
        label: "account",
        path: `/accounts/${seeded.accountId}`,
        // Six on mount, and AccountMovements adds more beneath it.
        expect: [`/api/accounts/${seeded.accountId}`, `/api/accounts/${seeded.accountId}/plan`],
        floor: 6,
      },
      {
        label: "household",
        path: `/households/${seeded.householdId}`,
        // getHousehold is served by the auth service through the api's proxy —
        // the one hop a same-process harness gets wrong, and the route whose
        // deletion this suite is meant to notice.
        expect: [
          `/api/auth/households/${seeded.householdId}`,
          `/api/households/${seeded.householdId}/plan`,
        ],
        floor: 4,
      },
      {
        label: "household plan",
        path: `/households/${seeded.householdId}/plan`,
        expect: [
          `/api/households/${seeded.householdId}/plan`,
          `/api/households/${seeded.householdId}/transfers/confirmations`,
        ],
        floor: 4,
      },
      {
        label: "household flow",
        path: `/flow?household=${seeded.householdId}`,
        expect: [`/api/households/${seeded.householdId}/accounts`, "/api/flow"],
        floor: 2,
      },
    ];

    const counted: string[] = [];
    for (const step of pages) {
      const visited = await visit(step.path);
      const apiCalls = apiOf(visited);
      counted.push(`${step.label}: ${apiCalls.length} api of ${visited.length} responses`);
      expect(
        apiCalls.length,
        `${step.label} (${step.path}) asked the API ${apiCalls.length} times; ` +
          `expected at least ${step.floor}. A page that stopped fetching cannot be ` +
          `allowed to pass this suite by making nothing to check.`,
      ).toBeGreaterThanOrEqual(step.floor);
      for (const wanted of step.expect) {
        expect(
          apiCalls.map((s) => s.path),
          `${step.label} never called ${wanted}`,
        ).toContain(wanted);
      }
    }

    // ---- the assertion the suite exists for ----
    const broken = seen.filter((s) => !isAllowed(s));
    expect(
      broken.map(format),
      "the pages fetched something that failed — a client method pointing at a " +
        "route that no longer exists looks exactly like this",
    ).toEqual([]);

    // A green run reports its own coverage, so "it passed" can be told apart
    // from "it looked at nothing".
    const api = seen.filter((s) => s.path.startsWith("/api/"));
    const allowed = seen.filter((s) => s.status >= 400);
    console.log(
      [
        `inspected ${seen.length} responses, ${api.length} of them /api`,
        ...counted,
        `allowed by exception: ${allowed.map(format).join(", ") || "none"}`,
      ].join("\n  "),
    );
    expect(api.length, "the response listener recorded no API traffic at all").toBeGreaterThan(20);
  });
});
