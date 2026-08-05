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

  it("lets a movement with no household be confirmed exactly once a month", async () => {
    await withClient(uri, async (c) => {
      const owner = "44444444-4444-4444-4444-444444444444";
      const { rows: accounts } = await c.query<{ id: string }>(
        `INSERT INTO core.accounts (owner_user_id, name) VALUES ($1, 'Current'), ($1, 'Pot')
         RETURNING id`,
        [owner],
      );
      const [from, to] = accounts.map((r) => r.id);
      const { rows: inflows } = await c.query<{ id: string }>(
        `INSERT INTO core.inflows
           (account_id, name, source, source_account_id, amount_minor, frequency, anchor_date)
         VALUES ($1, 'Top-up', 'account', $2, 50000, 'monthly', '2026-08-01'),
                ($1, 'ISA', 'account', $2, 10000, 'monthly', '2026-08-01')
         RETURNING id`,
        [to, from],
      );
      const [topUp, isa] = inflows.map((r) => r.id);
      const confirm = (
        inflowId: string | null,
        householdId: string | null = null,
        member = owner,
      ) =>
        c.query(
          `INSERT INTO core.transfer_confirmations
             (household_id, inflow_id, month, from_account_id, to_account_id,
              member_user_id, amount_minor)
           VALUES ($1, $2, '2026-08-01', $3, $4, $5, 1000)`,
          [householdId, inflowId, from, to, member],
        );

      // The whole point: household_id may be null now.
      await expect(confirm(topUp)).resolves.toBeTruthy();
      // …and the same movement cannot be confirmed twice in one month, which is
      // what the old UNIQUE constraint cannot see with a null household.
      await expect(confirm(topUp)).rejects.toThrow(/transfer_confirmations_inflow_month_unique/);
      // A different movement between the same two accounts is a different thing.
      await expect(confirm(isa)).resolves.toBeTruthy();
      // Neither household nor inflow: 0009 refused this as "scoped to nothing",
      // and 0010 accepts it as a transfer the plan derived, scoped by (from, to,
      // month, member) like every other row. Exercised in full further down;
      // here it only has to have stopped being refused.
      await expect(confirm(null)).resolves.toBeTruthy();

      // Household rows behave exactly as they always did: one row per member,
      // and a second for the same member refused by the original constraint.
      const household = "55555555-5555-5555-5555-555555555555";
      const other = "66666666-6666-6666-6666-666666666666";
      await expect(confirm(null, household)).resolves.toBeTruthy();
      await expect(confirm(null, household, other)).resolves.toBeTruthy();
      await expect(confirm(null, household)).rejects.toThrow(/transfer_confirmation_unique/);

      // Deleting the inflow takes its confirmation with it.
      await c.query(`DELETE FROM core.inflows WHERE id = $1`, [topUp]);
      const left = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM core.transfer_confirmations WHERE inflow_id = $1`,
        [topUp],
      );
      expect(left.rows[0]).toEqual({ n: 0 });
    });
  });

  it("confirms a derived transfer that carries neither a household nor an inflow", async () => {
    const owner = "77777777-7777-7777-7777-777777777777";
    const other = "88888888-8888-8888-8888-888888888888";
    const from = await withClient(uri, async (c) => {
      const { rows: accounts } = await c.query<{ id: string }>(
        `INSERT INTO core.accounts (owner_user_id, name)
         VALUES ($1, 'Source'), ($1, 'Bills'), ($1, 'Holiday') RETURNING id`,
        [owner],
      );
      const [source, bills, holiday] = accounts.map((r) => r.id);
      const confirm = (to: string, member = owner, month = "2026-08-01") =>
        c.query(
          `INSERT INTO core.transfer_confirmations
             (household_id, inflow_id, month, from_account_id, to_account_id,
              member_user_id, amount_minor)
           VALUES (NULL, NULL, $3, $1, $2, $4, 30320)`,
          [source, to, month, member],
        );

      // The shape 0009's CHECK called "scoped to nothing" and refused outright.
      await expect(confirm(bills)).resolves.toBeTruthy();
      // …recorded once a month and no more, which is what neither older unique
      // key can see with both scope columns null.
      await expect(confirm(bills)).rejects.toThrow(/transfer_confirmations_derived_month_unique/);
      // Another pot, another actor, another month: three different movements.
      await expect(confirm(holiday)).resolves.toBeTruthy();
      await expect(confirm(bills, other)).resolves.toBeTruthy();
      await expect(confirm(bills, owner, "2026-09-01")).resolves.toBeTruthy();
      return source;
    });

    // The hazard this migration has to survive: 0009 re-runs immediately before
    // 0010 on every sync and re-adds `transfer_confirmation_scope` whenever it
    // finds the name free. With derived rows in the table that ADD would
    // validate against them, fail, and wedge every future deploy. Applying
    // everything again — twice — proves the name stays held and the rows stay.
    await applyMigrations(uri);
    await applyMigrations(uri);
    await withClient(uri, async (c) => {
      const derived = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM core.transfer_confirmations
         WHERE household_id IS NULL AND inflow_id IS NULL AND from_account_id = $1`,
        [from],
      );
      expect(derived.rows[0]).toEqual({ n: 4 });
      const scope = await c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'transfer_confirmation_scope'
           AND conrelid = 'core.transfer_confirmations'::regclass`,
      );
      expect(scope.rows).toHaveLength(1);
      expect(scope.rows[0]!.def).not.toContain("inflow_id");
    });
  });

  /**
   * 0011's whole argument, exercised: the rule holds against a `psql` prompt,
   * and it applies cleanly to a database that already breaks it.
   *
   * A `CREATE UNIQUE INDEX (user_id)` would state the same rule and would fail
   * on the second half of this test — and, because every file here is
   * re-applied in full on every sync, would then fail on every deploy after it,
   * forever, with no `DELETE` available to clear the way. A trigger is never
   * validated against rows that already exist, so it constrains the next write
   * and leaves history alone. That difference is the reason this file exists.
   */
  it("refuses a second household at the database, and applies over one that already has two", async () => {
    const user = "99999999-9999-9999-9999-999999999999";
    await withClient(uri, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO auth.households (name, created_by) VALUES ('Home', $1), ('Flat', $1)
         RETURNING id`,
        [user],
      );
      const [home, flat] = rows.map((r) => r.id);
      const join = (householdId: string, member = user) =>
        c.query(`INSERT INTO auth.household_memberships (household_id, user_id) VALUES ($1, $2)`, [
          householdId,
          member,
        ]);

      await expect(join(home)).resolves.toBeTruthy();
      await expect(join(flat)).rejects.toThrow(/already belongs to a household/);
      // Somebody else joining the second one is nobody's business but theirs.
      await expect(join(flat, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).resolves.toBeTruthy();
      // A duplicate row for the household they are *already* in is a different
      // hole, guarded by the auth service, and deliberately not this trigger's.
      await expect(join(home)).resolves.toBeTruthy();
    });

    // A database that predates the rule and breaks it: 0001–0010, a user in two
    // households, then every migration applied twice on top.
    await withClient(uri, (c) => c.query("CREATE DATABASE exclusivity_probe"));
    const probe = new URL(uri);
    probe.pathname = "/exclusivity_probe";
    const probeUri = probe.toString();
    await applyMigrations(probeUri, "0010_zzz");
    await withClient(probeUri, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO auth.households (name, created_by) VALUES ('Legacy home', $1),
                                                              ('Legacy flat', $1) RETURNING id`,
        [user],
      );
      for (const r of rows) {
        await c.query(
          `INSERT INTO auth.household_memberships (household_id, user_id) VALUES ($1, $2)`,
          [r.id, user],
        );
      }
    });

    await applyMigrations(probeUri);
    await applyMigrations(probeUri);

    await withClient(probeUri, async (c) => {
      // The offending rows are still there — untouched, not deleted, exactly as
      // an additive migration must leave them.
      const legacy = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM auth.household_memberships WHERE user_id = $1`,
        [user],
      );
      expect(legacy.rows[0]).toEqual({ n: 2 });
      // …and the rule is in force from here on, for that same user.
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO auth.households (name, created_by) VALUES ('A third', $1) RETURNING id`,
        [user],
      );
      await expect(
        c.query(`INSERT INTO auth.household_memberships (household_id, user_id) VALUES ($1, $2)`, [
          rows[0]!.id,
          user,
        ]),
      ).rejects.toThrow(/already belongs to a household/);
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
