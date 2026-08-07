import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import type { PlanDebugDto } from "../lib/types.js";
import { DebugPlanPage } from "./DebugPlanPage.js";

const emptyDebug: PlanDebugDto = {
  asOfDate: "2026-08-06",
  subject: { kind: "user" },
  scopes: [],
};

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DebugPlanPage", () => {
  it("defaults the hidden debug flag when the query string is missing", async () => {
    const debugPlan = vi.spyOn(api, "debugPlan").mockResolvedValue(emptyDebug);
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);

    render(
      <MemoryRouter initialEntries={["/debug/plan"]}>
        <Routes>
          <Route
            path="/debug/plan"
            element={
              <>
                <LocationProbe />
                <DebugPlanPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("location")).toHaveTextContent("/debug/plan?debug=engine"),
    );
    expect(screen.getByRole("dialog", { name: /full household finance trace/i })).toBeVisible();
    expect(debugPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /show full debug trace/i }));

    await waitFor(() =>
      expect(debugPlan).toHaveBeenCalledWith({
        account: undefined,
        household: undefined,
        asOf: undefined,
        ack: "full-household-finance",
      }),
    );
  });
});
