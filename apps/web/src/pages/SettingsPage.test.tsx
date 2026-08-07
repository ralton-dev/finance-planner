import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes as RouterRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { api } from "../lib/api.js";
import type { UserDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { SettingsPage } from "./SettingsPage.js";

// The one seam the download goes through: an object URL and a synthetic anchor
// click, neither of which jsdom can do. Stubbing it here keeps the assertion on
// "what got saved, and under what name".
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("../lib/files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/files.js")>()),
  saveBlob,
}));

const RECOVERY_CODES = [
  "aaaa-1111",
  "bbbb-2222",
  "cccc-3333",
  "dddd-4444",
  "eeee-5555",
  "ffff-6666",
  "gggg-7777",
  "hhhh-8888",
];

let me: UserDto;
let stub: FetchStub;

beforeEach(() => {
  me = {
    id: "u1",
    email: "ada@example.com",
    displayName: "Ada",
    totpEnabled: false,
    notifyEmail: false,
  };
  saveBlob.mockClear();
  // The client keeps its access token in memory — don't leak it between tests.
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(routes: Routes = {}): void {
  stub = stubApiFetch({
    // Re-read on every call so a refetch sees the post-change state.
    "GET /api/auth/me": () => ({ body: me }),
    // Boot refresh fails (anon) unless a test says otherwise; the danger zone
    // needs a real AuthProvider around it for its logout.
    "POST /api/auth/refresh": { status: 401, body: {} },
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AuthProvider>
        <RouterRoutes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/login" element={<p>login stub</p>} />
        </RouterRoutes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Pick a file in the "import from export" input. */
function chooseFile(contents: string, name = "export.json"): void {
  const file = new File([contents], name, { type: "application/json" });
  fireEvent.change(screen.getByLabelText(/import from export/i), { target: { files: [file] } });
}

const EXPORT_FILE = JSON.stringify({
  version: 1,
  exportedAt: "2026-08-04T09:00:00.000Z",
  accounts: [
    { name: "Everyday", incomes: [{ name: "Salary" }], payments: [{ name: "Rent" }] },
    { name: "Savings", incomes: [], payments: [] },
  ],
  projects: [{ name: "Kitchen" }],
});

const setupReply = {
  body: {
    secret: "JBSWY3DPEHPK3PXP",
    otpauthUri: "otpauth://totp/finance-planner:ada@example.com?secret=JBSWY3DPEHPK3PXP",
  },
};

describe("SettingsPage — account", () => {
  it("shows the identity read-only from /me", async () => {
    renderPage();
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    // No password-change UI: the API has no endpoint for it.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
});

describe("SettingsPage — notifications", () => {
  it("reflects me().notifyEmail and PATCHes the flip", async () => {
    renderPage({ "PATCH /api/auth/me": () => ({ body: { ...me, notifyEmail: true } }) });

    const toggle = await screen.findByRole("checkbox", { name: /daily email digest/i });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/needs SMTP configured on the server/i)).toBeInTheDocument();

    fireEvent.click(toggle);

    // Optimistic: on before the request has been answered.
    //
    // This assertion was intermittently red — roughly one full-suite run in
    // eight, only under the load of every file running at once, and the
    // received element was unchecked *and still disabled*, i.e. mid-request.
    // The cause was the section's own `useEffect(() => setOn(notifyEmail),
    // [notifyEmail])`: on a slow first paint that effect flushes after the
    // click, React cannot bail the no-op `setOn(false)` out once the click has
    // queued an update on the same hook, and the stale value wins. The switch
    // really did snap back with the PATCH in the air. Fixed in the component,
    // which syncs the prop during render instead.
    //
    // Do NOT settle this with a `waitFor` — the whole point of the assertion is
    // that the switch is on *before* the request is answered, and a waitFor
    // would pass either way.
    expect(toggle).toBeChecked();
    await waitFor(() => expect(stub.calls("PATCH /api/auth/me")).toBe(1));
    expect(stub.bodyOf("PATCH /api/auth/me")).toEqual({ notifyEmail: true });
    expect(toggle).toBeChecked();
  });

  it("starts on when the digest is already enabled", async () => {
    me = { ...me, notifyEmail: true };
    renderPage();
    expect(await screen.findByRole("checkbox", { name: /daily email digest/i })).toBeChecked();
  });

  it("reverts the switch when the save fails", async () => {
    renderPage({ "PATCH /api/auth/me": { status: 500, body: {} } });

    const toggle = await screen.findByRole("checkbox", { name: /daily email digest/i });
    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save that/i);
    expect(toggle).not.toBeChecked();
  });
});

describe("SettingsPage — data: export", () => {
  it("saves the export under the server's filename", async () => {
    renderPage({
      "GET /api/export": {
        body: { version: 1, accounts: [] },
        headers: {
          "content-disposition": 'attachment; filename="finance-planner-2026-08-04.json"',
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /export everything/i }));

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(saveBlob.mock.calls[0][1]).toBe("finance-planner-2026-08-04.json");
    expect(saveBlob.mock.calls[0][0]).toBeInstanceOf(Blob);
  });

  it("falls back to a name of its own when the header says nothing", async () => {
    renderPage({ "GET /api/export": { body: { version: 1, accounts: [] } } });

    fireEvent.click(await screen.findByRole("button", { name: /export everything/i }));

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(saveBlob.mock.calls[0][1]).toBe("finance-planner-export.json");
  });

  it("reports a failed export instead of saving an error page", async () => {
    renderPage({ "GET /api/export": { status: 500, body: {} } });

    fireEvent.click(await screen.findByRole("button", { name: /export everything/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not build that export/i);
    expect(saveBlob).not.toHaveBeenCalled();
  });
});

describe("SettingsPage — data: import", () => {
  it("confirms first, then reports what the server created", async () => {
    renderPage({
      "POST /api/import": {
        body: {
          accounts: 2,
          incomes: 1,
          payments: 5,
          contributions: 0,
          balanceSnapshots: 0,
          closes: 0,
          projects: 1,
        },
      },
    });

    await screen.findByLabelText(/import from export/i);
    chooseFile(EXPORT_FILE);

    // What the file says it carries, before anything is sent.
    expect(
      await screen.findByText(/adds 2 accounts · 1 income · 1 payment · 1 project/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/import is additive, nothing is deleted/i)).toBeInTheDocument();
    expect(stub.calls("POST /api/import")).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    expect(
      await screen.findByText(/imported 2 accounts · 1 income · 5 payments · 1 project/i),
    ).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/import")).toEqual(JSON.parse(EXPORT_FILE));
  });

  it("cancels without sending anything", async () => {
    renderPage();
    await screen.findByLabelText(/import from export/i);
    chooseFile(EXPORT_FILE);

    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByText(/import is additive/i)).toBeNull());
    expect(stub.calls("POST /api/import")).toBe(0);
  });

  it("rejects broken json locally, without a request", async () => {
    renderPage();
    await screen.findByLabelText(/import from export/i);
    chooseFile("{not json");

    expect(await screen.findByRole("alert")).toHaveTextContent(/that file isn't valid json/i);
    expect(screen.queryByText(/import is additive/i)).toBeNull();
    expect(stub.calls("POST /api/import")).toBe(0);
  });

  it("explains a 422 in the user's terms", async () => {
    renderPage({
      "POST /api/import": {
        status: 422,
        body: { error: { code: "validation_error", message: "bad shape" } },
      },
    });

    await screen.findByLabelText(/import from export/i);
    chooseFile(JSON.stringify({ version: 9, accounts: [] }));
    fireEvent.click(await screen.findByRole("button", { name: /^import$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /that file doesn't look like a finance-planner export/i,
    );
    // The file is rejected outright, so the confirmation goes with it.
    expect(screen.queryByText(/import is additive/i)).toBeNull();
  });
});

describe("SettingsPage — danger zone", () => {
  async function openDangerZone(routes: Routes = {}): Promise<void> {
    renderPage(routes);
    fireEvent.click(await screen.findByRole("button", { name: /delete account and all data/i }));
  }

  function fill(email: string, password: string): void {
    fireEvent.change(screen.getByLabelText(/type your email to confirm deletion/i), {
      target: { value: email },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: password } });
  }

  it("stays disabled until the email matches exactly and a password is typed", async () => {
    await openDangerZone();
    const confirm = screen.getByRole("button", { name: /delete my account/i });
    expect(confirm).toBeDisabled();

    fill("ada@example.co", "hunter2hunter2");
    expect(confirm).toBeDisabled();

    fill("ada@example.com", "");
    expect(confirm).toBeDisabled();

    fill("ada@example.com", "hunter2hunter2");
    expect(confirm).toBeEnabled();
    expect(screen.getByText(/signed in with sso only\? type anything here/i)).toBeInTheDocument();
  });

  it("shows a wrong password inline and keeps the account", async () => {
    await openDangerZone({
      "DELETE /api/auth/me": {
        status: 403,
        body: { error: { code: "invalid_credentials", message: "nope" } },
      },
    });

    fill("ada@example.com", "wrong-password");
    fireEvent.click(screen.getByRole("button", { name: /delete my account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("wrong password");
    expect(screen.queryByText("login stub")).toBeNull();
  });

  it("deletes, logs out and lands on the login screen", async () => {
    await openDangerZone({
      "DELETE /api/auth/me": { status: 204 },
      "POST /api/auth/logout": { status: 204 },
    });

    fill("ada@example.com", "hunter2hunter2");
    fireEvent.click(screen.getByRole("button", { name: /delete my account/i }));

    expect(await screen.findByText("login stub")).toBeInTheDocument();
    expect(stub.bodyOf("DELETE /api/auth/me")).toEqual({ password: "hunter2hunter2" });
    expect(stub.calls("POST /api/auth/logout")).toBe(1);
  });
});

describe("SettingsPage — two-factor", () => {
  it("reflects me().totpEnabled in the status line", async () => {
    me = { ...me, totpEnabled: true };
    renderPage();
    expect(await screen.findByText("enabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable 2fa/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable 2fa/i })).toBeNull();
  });

  it("enables 2fa and shows the recovery codes until they are acknowledged", async () => {
    renderPage({
      "POST /api/auth/totp/setup": setupReply,
      "POST /api/auth/totp/enable": () => {
        me = { ...me, totpEnabled: true };
        return { body: { enabled: true, recoveryCodes: RECOVERY_CODES } };
      },
    });

    expect(await screen.findByText("not enabled")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /enable 2fa/i }));

    // The secret is shown in readable groups, alongside the otpauth uri.
    expect(await screen.findByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    expect(screen.getByText(setupReply.body.otpauthUri)).toBeInTheDocument();
    expect(screen.getByText(/scan or paste into your authenticator/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/code from your app/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    const panel = await screen.findByLabelText("recovery codes");
    expect(panel.querySelectorAll("code")).toHaveLength(8);
    expect(screen.getByText("aaaa-1111")).toBeInTheDocument();
    expect(screen.getByText(/never be shown again/i)).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/totp/enable")).toEqual({ code: "123456" });

    // The status behind the panel has already flipped (me() was re-read).
    await waitFor(() => expect(screen.getByText("enabled")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /i've saved these/i }));
    expect(screen.queryByLabelText("recovery codes")).toBeNull();
    expect(screen.queryByText("aaaa-1111")).toBeNull();
  });

  it("shows a wrong code inline and does not reveal any codes", async () => {
    renderPage({
      "POST /api/auth/totp/setup": setupReply,
      "POST /api/auth/totp/enable": {
        status: 422,
        body: { error: { code: "invalid_code", message: "nope" } },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /enable 2fa/i }));
    fireEvent.change(await screen.findByLabelText(/code from your app/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("wrong code, try again");
    expect(screen.queryByLabelText("recovery codes")).toBeNull();
    expect(screen.getByLabelText(/code from your app/i)).toBeInTheDocument();
  });

  it("explains a setup that has already been used up", async () => {
    renderPage({
      "POST /api/auth/totp/setup": {
        status: 409,
        body: { error: { code: "totp_already_enabled", message: "on" } },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /enable 2fa/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already on for this account/i);
  });

  it("disables 2fa with a code and updates the status", async () => {
    me = { ...me, totpEnabled: true };
    renderPage({
      "POST /api/auth/totp/disable": () => {
        me = { ...me, totpEnabled: false };
        return { body: { enabled: false } };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /disable 2fa/i }));
    fireEvent.change(screen.getByLabelText(/code or recovery code/i), {
      target: { value: "recovery-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm disable/i }));

    expect(await screen.findByText("not enabled")).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/totp/disable")).toEqual({ code: "recovery-1" });
    expect(screen.getByRole("button", { name: /enable 2fa/i })).toBeInTheDocument();
  });

  it("keeps the user on the disable form when the code is wrong", async () => {
    me = { ...me, totpEnabled: true };
    renderPage({
      "POST /api/auth/totp/disable": {
        status: 422,
        body: { error: { code: "invalid_code", message: "nope" } },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /disable 2fa/i }));
    fireEvent.change(screen.getByLabelText(/code or recovery code/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm disable/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("wrong code, try again");
    expect(screen.getByText("enabled")).toBeInTheDocument();
  });
});
