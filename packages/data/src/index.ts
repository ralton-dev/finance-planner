export * from "./entities.js";
export * from "./store.js";
export * from "./memory-store.js";
export * from "./schema.js";
export * from "./pg-store.js";
export * from "./db.js";

import { createDb } from "./db.js";
import { MemoryStore } from "./memory-store.js";
import { PgStore } from "./pg-store.js";
import type { Store } from "./store.js";

export interface StoreHandle {
  store: Store;
  close: () => Promise<void>;
}

/**
 * Construct a Store. With a connection string, uses Postgres (production path);
 * without one, falls back to the in-memory store (tests / DB-less local dev).
 */
export function createStore(databaseUrl?: string): StoreHandle {
  if (databaseUrl) {
    const { db, close } = createDb(databaseUrl);
    return { store: new PgStore(db), close };
  }
  return { store: new MemoryStore(), close: async () => {} };
}
