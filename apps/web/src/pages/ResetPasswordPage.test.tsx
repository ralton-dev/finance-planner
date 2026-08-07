import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApiFetch, type FetchStub, type Routes as StubRoutes } from "../test/apiMock.js";
import { ResetPasswordPage } from "./ResetPasswordPage.js";

let stub: FetchStub;

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(entry: string, routes: StubRoutes = {}): void {
  stub = stubApiFetch({ "POST /api/auth/password/reset": { body: { reset: true } }, ...routes });
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/reset" element={<ResetPasswordPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fill(password: string, confirm: string): void {
  fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: /set password/i }));
}

describe("ResetPasswordPage", () => {
  it("errors when the link has no token", () => {
    renderPage("/reset");
    expect(screen.getByRole("alert")).toHaveTextContent(/missing its reset token/i);
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
    expect(screen.getByRole("link", { name: /request a new link/i })).toHaveAttribute(
      "href",
      "/forgot",
    );
  });

  it("rejects a password under 8 characters before calling the api", () => {
    renderPage("/reset?token=tok_1");
    fill("short", "short");

    expect(screen.getByRole("alert")).toHaveTextContent(/at least 8 characters/i);
    expect(stub.calls("POST /api/auth/password/reset")).toBe(0);
  });

  it("rejects a mismatched confirmation", () => {
    renderPage("/reset?token=tok_1");
    fill("hunter2hunter2", "hunter2hunter3");

    expect(screen.getByRole("alert")).toHaveTextContent(/passwords do not match/i);
    expect(stub.calls("POST /api/auth/password/reset")).toBe(0);
  });

  it("posts the token and confirms the change", async () => {
    renderPage("/reset?token=tok_1");
    fill("hunter2hunter2", "hunter2hunter2");

    expect(await screen.findByRole("heading", { name: /password updated/i })).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/password/reset")).toEqual({
      token: "tok_1",
      password: "hunter2hunter2",
    });
    expect(screen.getByRole("link", { name: /go to log in/i })).toHaveAttribute("href", "/login");
  });

  it("explains an invalid or expired token", async () => {
    renderPage("/reset?token=stale", {
      "POST /api/auth/password/reset": {
        status: 422,
        body: { error: { code: "invalid_token", message: "nope" } },
      },
    });
    fill("hunter2hunter2", "hunter2hunter2");

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or has expired/i);
    expect(screen.queryByRole("heading", { name: /password updated/i })).toBeNull();
  });
});
