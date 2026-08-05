import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto } from "../lib/types.js";
import { AccountSettingsDrawer } from "./AccountSettingsDrawer.js";

const account: AccountDto = {
  id: "acc-1",
  name: "Test Account",
  description: "primary current account",
  currency: "GBP",
  openingBalanceMinor: 25000,
  monthlyBufferMinor: 10000,
  owner: true,
  permission: "edit",
};

const noop = (): void => {};

beforeEach(() => {
  // Default: every fetch succeeds with the account back.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => account,
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountSettingsDrawer", () => {
  it("renders nothing when account is null", () => {
    const { container } = render(
      <AccountSettingsDrawer account={null} onClose={noop} onSaved={noop} onDeleted={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("pre-fills the form from the account", () => {
    render(
      <AccountSettingsDrawer account={account} onClose={noop} onSaved={noop} onDeleted={noop} />,
    );
    expect(screen.getByDisplayValue("Test Account")).toBeInTheDocument();
    expect(screen.getByDisplayValue("primary current account")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100.00")).toBeInTheDocument();
  });

  it("shows the currency as a fact, with no input to change it", () => {
    render(
      <AccountSettingsDrawer account={account} onClose={noop} onSaved={noop} onDeleted={noop} />,
    );
    expect(screen.getByText("GBP")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("GBP")).toBeNull();
    expect(screen.getByText(/fixed when the account was created/)).toBeInTheDocument();
  });

  it("disables the delete button until the user types the exact account name", () => {
    render(
      <AccountSettingsDrawer account={account} onClose={noop} onSaved={noop} onDeleted={noop} />,
    );
    const deleteBtn = screen.getByRole("button", { name: /delete account/i });
    expect(deleteBtn).toBeDisabled();

    const confirm = screen.getByLabelText(/type account name to confirm/i);
    fireEvent.change(confirm, { target: { value: "wrong" } });
    expect(deleteBtn).toBeDisabled();

    fireEvent.change(confirm, { target: { value: "Test Account" } });
    expect(deleteBtn).not.toBeDisabled();
  });

  it("posts a PATCH when save is clicked and calls onSaved", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <AccountSettingsDrawer
        account={account}
        onClose={onClose}
        onSaved={onSaved}
        onDeleted={noop}
      />,
    );

    const nameInput = screen.getByDisplayValue("Test Account");
    fireEvent.change(nameInput, { target: { value: "Test Account Personal" } });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/accounts/acc-1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      name: "Test Account Personal",
      monthlyBufferMinor: 10000,
    });
    // The server refuses a *different* currency, not the field's presence — so
    // this is the client no longer asking, which is what makes it moot.
    expect(body).not.toHaveProperty("currency");
  });

  it("hides the danger zone for non-owners and disables the form", () => {
    const sharedView: AccountDto = { ...account, owner: false, permission: "view" };
    render(
      <AccountSettingsDrawer account={sharedView} onClose={noop} onSaved={noop} onDeleted={noop} />,
    );
    expect(screen.queryByRole("button", { name: /delete account/i })).toBeNull();
    expect(screen.getByDisplayValue("Test Account")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument();
  });
});
