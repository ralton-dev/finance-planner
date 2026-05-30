import { describe, it } from "vitest";
import { MemoryStore } from "./memory-store.js";
import { exerciseStore } from "./store-contract.js";

describe("MemoryStore", () => {
  it("satisfies the store contract", async () => {
    await exerciseStore(new MemoryStore());
  });
});
