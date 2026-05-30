import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Drawer } from "./Drawer.js";

describe("Drawer", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Drawer open={false} onClose={() => {}} title="hidden">
        hidden body
      </Drawer>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("hidden body")).toBeNull();
  });

  it("renders title and body when open", () => {
    render(
      <Drawer open onClose={() => {}} title="account settings">
        the form goes here
      </Drawer>,
    );
    expect(screen.getByText("account settings")).toBeInTheDocument();
    expect(screen.getByText("the form goes here")).toBeInTheDocument();
  });

  it("calls onClose when ESC is pressed", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="x">
        body
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="x">
        body
      </Drawer>,
    );
    fireEvent.click(screen.getByTestId("drawer-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="x">
        body
      </Drawer>,
    );
    fireEvent.click(screen.getByLabelText("Close drawer"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
