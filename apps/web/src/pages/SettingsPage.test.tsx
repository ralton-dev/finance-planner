import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { SettingsPage } from "./SettingsPage.js";

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
  me = { id: "u1", email: "ada@example.com", displayName: "Ada", totpEnabled: false };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(routes: Routes = {}): void {
  stub = stubApiFetch({
    // Re-read on every call so a refetch sees the post-change state.
    "GET /api/auth/me": () => ({ body: me }),
    ...routes,
  });
  render(<SettingsPage />);
}

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
