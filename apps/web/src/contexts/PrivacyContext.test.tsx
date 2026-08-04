import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Amount } from "../components/Amount.js";
import {
  PRIVACY_CLASS,
  PRIVACY_STORAGE_KEY,
  PrivacyProvider,
  usePrivacy,
} from "./PrivacyContext.js";

function Consumer() {
  const { hidden, toggle } = usePrivacy();
  return (
    <button type="button" onClick={toggle} aria-pressed={hidden}>
      {hidden ? "show amounts" : "hide amounts"}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(PRIVACY_CLASS);
});
afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(PRIVACY_CLASS);
});

describe("PrivacyProvider", () => {
  it("starts visible and stamps the root class the moment it is toggled", () => {
    render(
      <PrivacyProvider>
        <Consumer />
      </PrivacyProvider>,
    );
    expect(document.documentElement).not.toHaveClass(PRIVACY_CLASS);

    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement).toHaveClass(PRIVACY_CLASS);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement).not.toHaveClass(PRIVACY_CLASS);
  });

  it("persists the choice", () => {
    render(
      <PrivacyProvider>
        <Consumer />
      </PrivacyProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(localStorage.getItem(PRIVACY_STORAGE_KEY)).toBe("1");

    fireEvent.click(screen.getByRole("button"));
    expect(localStorage.getItem(PRIVACY_STORAGE_KEY)).toBe("0");
  });

  it("restores a hidden session on the next load", () => {
    localStorage.setItem(PRIVACY_STORAGE_KEY, "1");
    render(
      <PrivacyProvider>
        <Consumer />
      </PrivacyProvider>,
    );
    expect(document.documentElement).toHaveClass(PRIVACY_CLASS);
    expect(screen.getByRole("button")).toHaveTextContent("show amounts");
  });

  it("takes the class with it when the app unmounts", () => {
    const view = render(
      <PrivacyProvider>
        <Consumer />
      </PrivacyProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    view.unmount();
    expect(document.documentElement).not.toHaveClass(PRIVACY_CLASS);
  });

  it("leaves amounts alone outside a provider rather than throwing", () => {
    render(<Consumer />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Amount", () => {
  it("carries the class privacy mode blurs", () => {
    render(<Amount minor={120_000} currency="GBP" />);
    const el = screen.getByText("£1,200.00");
    expect(el).toHaveClass("amount");
  });

  it("keeps any extra class the caller passes", () => {
    render(<Amount minor={0} currency="GBP" className="dim" />);
    expect(screen.getByText("£0.00")).toHaveClass("amount", "dim");
  });
});
