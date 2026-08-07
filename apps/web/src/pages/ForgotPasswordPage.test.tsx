import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { ForgotPasswordPage } from "./ForgotPasswordPage.js";

const NEUTRAL = /if that email has an account, a reset link is on its way/i;

let stub: FetchStub;

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(routes: Routes = {}): void {
  stub = stubApiFetch({ "POST /api/auth/password/forgot": { status: 204 }, ...routes });
  render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

function requestLink(email: string): void {
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
}

describe("ForgotPasswordPage", () => {
  it("shows the same neutral confirmation whatever the address", async () => {
    renderPage();
    requestLink("ada@example.com");

    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/password/forgot")).toEqual({ email: "ada@example.com" });
    // Nothing on the screen distinguishes a known address from an unknown one.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText(/^email$/i)).toBeNull();
  });

  it("says nothing different for an address with no account", async () => {
    renderPage();
    requestLink("nobody@example.com");
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  });

  it("reports a transport failure without revealing anything", async () => {
    renderPage({ "POST /api/auth/password/forgot": { status: 500, body: {} } });
    requestLink("ada@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not send the reset link/i);
    expect(screen.queryByText(NEUTRAL)).toBeNull();
  });
});
