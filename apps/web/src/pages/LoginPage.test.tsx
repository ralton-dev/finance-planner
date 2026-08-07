import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { api } from "../lib/api.js";
import { stubApiFetch, type FetchStub, type Routes as StubRoutes } from "../test/apiMock.js";
import { LoginPage } from "./LoginPage.js";

const session = {
  body: {
    accessToken: "at_1",
    user: { id: "u1", email: "ada@example.com", displayName: "Ada", totpEnabled: false },
  },
};

/** Boot refresh fails (anon) and SSO is off, unless a test overrides them. */
function baseRoutes(): StubRoutes {
  return {
    "POST /api/auth/refresh": { status: 401, body: {} },
    "GET /api/auth/oidc/meta": { body: { enabled: false } },
  };
}

let stub: FetchStub;

beforeEach(() => {
  // The client keeps its access token in memory — don't leak it between tests.
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLogin(routes: StubRoutes = {}): void {
  stub = stubApiFetch({ ...baseRoutes(), ...routes });
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>overview stub</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function submitCredentials(): void {
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "hunter2hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));
}

describe("LoginPage — password login", () => {
  it("logs in and lands on the overview", async () => {
    renderLogin({ "POST /api/auth/login": session });
    submitCredentials();

    expect(await screen.findByText("overview stub")).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/login")).toEqual({
      email: "ada@example.com",
      password: "hunter2hunter2",
    });
  });

  it("shows an error when the credentials are rejected", async () => {
    renderLogin({
      "POST /api/auth/login": {
        status: 401,
        body: { error: { code: "invalid_credentials", message: "nope" } },
      },
    });
    submitCredentials();

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid email or password/i);
  });

  it("links to the forgot-password flow", async () => {
    renderLogin();
    expect(await screen.findByRole("link", { name: /forgot password\?/i })).toHaveAttribute(
      "href",
      "/forgot",
    );
  });
});

describe("LoginPage — two-factor step-up", () => {
  const challenge = { body: { totpRequired: true, pendingToken: "pt_1" } };

  it("swaps in the code stage when the account needs a second factor", async () => {
    renderLogin({ "POST /api/auth/login": challenge });
    submitCredentials();

    expect(await screen.findByRole("heading", { name: /two-factor/i })).toBeInTheDocument();
    expect(screen.getByText(/6-digit code from your authenticator/i)).toBeInTheDocument();
    // Credentials are gone; only the code is asked for.
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.getByLabelText(/^code$/i)).toHaveFocus();
  });

  it("submits the code with the pending token and finishes the login", async () => {
    renderLogin({ "POST /api/auth/login": challenge, "POST /api/auth/login/totp": session });
    submitCredentials();

    fireEvent.change(await screen.findByLabelText(/^code$/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByText("overview stub")).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/login/totp")).toEqual({
      pendingToken: "pt_1",
      code: "123456",
    });
  });

  it("toggles to a recovery code and sends it as recoveryCode", async () => {
    renderLogin({ "POST /api/auth/login": challenge, "POST /api/auth/login/totp": session });
    submitCredentials();

    fireEvent.click(await screen.findByRole("button", { name: /use a recovery code instead/i }));
    const field = screen.getByLabelText(/^recovery code$/i);
    fireEvent.change(field, { target: { value: "abcd-1234" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByText("overview stub")).toBeInTheDocument();
    expect(stub.bodyOf("POST /api/auth/login/totp")).toEqual({
      pendingToken: "pt_1",
      recoveryCode: "abcd-1234",
    });
  });

  it("renders invalid_code inline and keeps the user on the code stage", async () => {
    renderLogin({
      "POST /api/auth/login": challenge,
      "POST /api/auth/login/totp": {
        status: 401,
        body: { error: { code: "invalid_code", message: "bad code" } },
      },
    });
    submitCredentials();

    fireEvent.change(await screen.findByLabelText(/^code$/i), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("wrong code, try again");
    expect(screen.getByLabelText(/^code$/i)).toBeInTheDocument();
    // A bad code is a domain error, not an expired token — nothing to refresh.
    expect(stub.calls("POST /api/auth/refresh")).toBe(1);
  });

  it("explains an expired pending token", async () => {
    renderLogin({
      "POST /api/auth/login": challenge,
      "POST /api/auth/login/totp": {
        status: 401,
        body: { error: { code: "invalid_pending_token", message: "expired" } },
      },
    });
    submitCredentials();

    fireEvent.change(await screen.findByLabelText(/^code$/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/expired — start again/i);
  });

  it("goes back to the credentials form", async () => {
    renderLogin({ "POST /api/auth/login": challenge });
    submitCredentials();

    fireEvent.click(await screen.findByRole("button", { name: /back/i }));
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /two-factor/i })).toBeNull();
  });
});

describe("LoginPage — SSO", () => {
  it("offers sso when the provider is configured", async () => {
    renderLogin({
      "GET /api/auth/oidc/meta": { body: { enabled: true, issuer: "https://idp.example" } },
    });

    expect(await screen.findByRole("button", { name: /sign in with sso/i })).toBeInTheDocument();
    expect(screen.getByText(/via https:\/\/idp\.example/)).toBeInTheDocument();
  });

  it("hides sso when the provider is off", async () => {
    renderLogin();
    await waitFor(() => expect(stub.calls("GET /api/auth/oidc/meta")).toBe(1));
    expect(screen.queryByRole("button", { name: /sign in with sso/i })).toBeNull();
  });

  it("hides sso when the probe fails", async () => {
    renderLogin({ "GET /api/auth/oidc/meta": { status: 500, body: {} } });
    await waitFor(() => expect(stub.calls("GET /api/auth/oidc/meta")).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /sign in with sso/i })).toBeNull();
  });
});
