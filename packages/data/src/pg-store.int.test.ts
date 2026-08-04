import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./db.js";
import { PgStore } from "./pg-store.js";
import { exerciseStore } from "./store-contract.js";

/** Apply every SQL file in db/migrations/ in lexical order. New migrations
 *  drop in as 000N_*.sql and are picked up automatically — no test edit. */
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);

const migrationFiles = (): string[] =>
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

/** Apply migrations to one database, `upTo` a prefix if given. */
async function applyMigrations(uri: string, upTo?: string): Promise<void> {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    for (const f of migrationFiles()) {
      if (upTo && f > upTo) continue;
      await client.query(readFileSync(path.join(migrationsDir, f), "utf8"));
    }
  } finally {
    await client.end();
  }
}

async function withClient<T>(uri: string, f: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    return await f(client);
  } finally {
    await client.end();
  }
}

describe("PgStore (Postgres via Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let uri: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    uri = container.getConnectionUri();
    // Twice, deliberately. The cluster re-applies every file on every sync, so
    // a migration that only works the first time wedges every future deploy.
    await applyMigrations(uri);
    await applyMigrations(uri);
    handle = createDb(uri);
  });

  afterAll(async () => {
    await handle?.close();
    await container?.stop();
  });

  it("satisfies the store contract against real Postgres", async () => {
    await exerciseStore(new PgStore(handle.db));
  });

  it("refuses malformed inflows at the database, not merely in code", async () => {
    await withClient(uri, async (c) => {
      const owner = "11111111-1111-1111-1111-111111111111";
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO core.accounts (owner_user_id, name) VALUES ($1, 'A'), ($1, 'B') RETURNING id`,
        [owner],
      );
      const [a, b] = rows.map((r) => r.id);
      const insert = (source: string, sourceAccountId: string | null, into = a) =>
        c.query(
          `INSERT INTO core.inflows
             (account_id, name, source, source_account_id, amount_minor, frequency, anchor_date)
           VALUES ($1, 'x', $2, $3, 1000, 'monthly', '2026-08-01')`,
          [into, source, sourceAccountId],
        );

      // The well-formed pair both go in.
      await expect(insert("external", null)).resolves.toBeTruthy();
      await expect(insert("account", b)).resolves.toBeTruthy();

      // …and each CHECK refuses its case.
      await expect(insert("account", null)).rejects.toThrow(/inflow_source_account_scope/);
      await expect(insert("external", b)).rejects.toThrow(/inflow_source_account_scope/);
      await expect(insert("account", a)).rejects.toThrow(/inflow_not_self_sourced/);
      await expect(insert("borrowed", null)).rejects.toThrow(/inflow_source_known/);
    });
  });

  it("backfills incomes exactly once, and never resurrects a deleted inflow", async () => {
    // A separate database, so the backfill can be watched from before it runs:
    // 0001–0007 first, a legacy income row, then 0008 for the first time.
    await withClient(uri, (c) => c.query("CREATE DATABASE backfill_probe"));
    const probe = new URL(uri);
    probe.pathname = "/backfill_probe";
    const probeUri = probe.toString();

    await applyMigrations(probeUri, "0007_zzz");

    const incomeId = "22222222-2222-2222-2222-222222222222";
    await withClient(probeUri, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO core.accounts (owner_user_id, name) VALUES
           ('33333333-3333-3333-3333-333333333333', 'Legacy') RETURNING id`,
      );
      await c.query(
        `INSERT INTO core.incomes (id, account_id, name, amount_minor, frequency, anchor_date)
         VALUES ($1, $2, 'Salary', 300000, 'monthly', '2026-01-25')`,
        [incomeId, rows[0]!.id],
      );
    });

    await applyMigrations(probeUri);

    // The income arrived as an external inflow, under its own id.
    await withClient(probeUri, async (c) => {
      const { rows } = await c.query(`SELECT * FROM core.inflows WHERE id = $1`, [incomeId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "external",
        source_account_id: null,
        name: "Salary",
        amount_minor: "300000",
      });
    });

    // The user deletes it. Every later sync re-runs the backfill; it must stay
    // deleted, forever.
    await withClient(probeUri, (c) =>
      c.query(`DELETE FROM core.inflows WHERE id = $1`, [incomeId]),
    );
    await applyMigrations(probeUri);
    await applyMigrations(probeUri);

    await withClient(probeUri, async (c) => {
      const inflows = await c.query(`SELECT count(*)::int AS n FROM core.inflows`);
      expect(inflows.rows[0]).toEqual({ n: 0 });
      // And the source table is exactly as it was — additive only.
      const incomes = await c.query(`SELECT count(*)::int AS n FROM core.incomes`);
      expect(incomes.rows[0]).toEqual({ n: 1 });
    });
  });
});
