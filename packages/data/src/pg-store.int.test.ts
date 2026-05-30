import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDb, type DbHandle } from "./db.js";
import { PgStore } from "./pg-store.js";
import { exerciseStore } from "./store-contract.js";

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations/0001_init.sql",
);

describe("PgStore (Postgres via Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const uri = container.getConnectionUri();
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    await client.query(readFileSync(migrationPath, "utf8"));
    await client.end();
    handle = createDb(uri);
  });

  afterAll(async () => {
    await handle?.close();
    await container?.stop();
  });

  it("satisfies the store contract against real Postgres", async () => {
    await exerciseStore(new PgStore(handle.db));
  });
});
