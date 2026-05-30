import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto } from "../lib/types.js";
import { AccountSettingsDrawer } from "./AccountSettingsDrawer.js";

const account: AccountDto = {
  id: "acc-1",
  name: "Ben Monzo",
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
    expect(screen.getByDisplayValue("Ben Monzo")).toBeInTheDocument();
    expect(screen.getByDisplayValue("primary current account")).toBeInTheDocument();
    expect(screen.getByDisplayValue("GBP")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100.00")).toBeInTheDocument();
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

    fireEvent.change(confirm, { target: { value: "Ben Monzo" } });
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

    const nameInput = screen.getByDisplayValue("Ben Monzo");
    fireEvent.change(nameInput, { target: { value: "Ben Monzo Personal" } });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/accounts/acc-1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      name: "Ben Monzo Personal",
      currency: "GBP",
      monthlyBufferMinor: 10000,
    });
  });

  it("hides the danger zone for non-owners and disables the form", () => {
    const sharedView: AccountDto = { ...account, owner: false, permission: "view" };
    render(
      <AccountSettingsDrawer account={sharedView} onClose={noop} onSaved={noop} onDeleted={noop} />,
    );
    expect(screen.queryByRole("button", { name: /delete account/i })).toBeNull();
    expect(screen.getByDisplayValue("Ben Monzo")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument();
  });
});
