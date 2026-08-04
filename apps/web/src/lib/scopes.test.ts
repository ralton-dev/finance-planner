import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteScope,
  MAX_SAVED_SCOPES,
  readScopes,
  type SavedScope,
  saveScope,
  SCOPES_STORAGE_KEY,
} from "./scopes.js";

const scope = (name: string): SavedScope => ({
  name,
  accountIds: ["a", "b"],
  hiddenAccountIds: ["b"],
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("saved scopes", () => {
  it("saves newest first and replaces a name rather than duplicating it", () => {
    saveScope(scope("home"));
    saveScope(scope("flat"));
    expect(readScopes().map((s) => s.name)).toEqual(["flat", "home"]);

    saveScope({ ...scope("home"), accountIds: ["c"] });
    expect(readScopes().map((s) => s.name)).toEqual(["home", "flat"]);
    expect(readScopes()[0]!.accountIds).toEqual(["c"]);
  });

  it("forgets one by name and leaves the rest", () => {
    saveScope(scope("home"));
    saveScope(scope("flat"));
    expect(deleteScope("home").map((s) => s.name)).toEqual(["flat"]);
  });

  it("keeps the list to a length somebody can read down", () => {
    for (let i = 0; i <= MAX_SAVED_SCOPES; i++) saveScope(scope(`scope-${i}`));
    expect(readScopes()).toHaveLength(MAX_SAVED_SCOPES);
    // The newest survives; the oldest falls off.
    expect(readScopes()[0]!.name).toBe(`scope-${MAX_SAVED_SCOPES}`);
    expect(readScopes().some((s) => s.name === "scope-0")).toBe(false);
  });

  it("reads nothing rather than throwing at anything it did not write", () => {
    localStorage.setItem(SCOPES_STORAGE_KEY, "not json");
    expect(readScopes()).toEqual([]);
    localStorage.setItem(SCOPES_STORAGE_KEY, '{"name":"home"}');
    expect(readScopes()).toEqual([]);
    // A list with one usable entry keeps the entry and drops the rest.
    localStorage.setItem(
      SCOPES_STORAGE_KEY,
      JSON.stringify([scope("home"), { name: "" }, { name: "x", accountIds: [1] }, null]),
    );
    expect(readScopes()).toEqual([scope("home")]);
  });

  it("still works as a list when there is nowhere to persist it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    // Saving cannot fail loudly — the page would break for a reason that has
    // nothing to do with the diagram.
    expect(saveScope(scope("home")).map((s) => s.name)).toEqual(["home"]);
  });
});
