import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { api } from "../lib/api.js";
import { stubApiFetch, type FetchStub, type Routes as StubRoutes } from "../test/apiMock.js";
import { RegisterPage } from "./RegisterPage.js";

const session = {
  body: {
    accessToken: "at_1",
    user: { id: "u1", email: "debug@example.com", displayName: "Debug", totpEnabled: false },
  },
};

function baseRoutes(): StubRoutes {
  return {
    "POST /api/auth/refresh": { status: 401, body: {} },
    "POST /api/auth/register": { status: 201, body: { userId: "u1" } },
    "POST /api/auth/login": session,
  };
}

let stub: FetchStub;

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderRegister(routes: StubRoutes): void {
  stub = stubApiFetch({ ...baseRoutes(), ...routes });
  render(
    <MemoryRouter initialEntries={["/register"]}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<p>overview stub</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function submit(): void {
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Debug" } });
  fireEvent.change(screen.getByLabelText(/^email$/i), {
    target: { value: "debug@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: /^create account$/i }));
}

describe("RegisterPage", () => {
  it("loads demo data for a fresh registration when the deployment enables it", async () => {
    renderRegister({
      "GET /api/meta": { body: { demoSeedEnabled: true } },
      "POST /api/demo/seed": {
        body: {
          users: 1,
          households: 1,
          householdMemberships: 2,
          accounts: 4,
          accountShares: 1,
          accountAssignments: 4,
          incomes: 2,
          accountInflows: 1,
          payments: 4,
          contributions: 1,
          balanceSnapshots: 4,
        },
      },
    });
    submit();

    expect(await screen.findByText("overview stub")).toBeInTheDocument();
    expect(stub.calls("POST /api/demo/seed")).toBe(1);
  });

  it("still registers normally when demo data is off", async () => {
    renderRegister({ "GET /api/meta": { body: { demoSeedEnabled: false } } });
    submit();

    expect(await screen.findByText("overview stub")).toBeInTheDocument();
    expect(stub.calls("POST /api/demo/seed")).toBe(0);
  });
});
