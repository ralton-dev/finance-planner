import type { ExportFile } from "@finance-planner/contracts";
import type { Store } from "@finance-planner/data";

/** What an import created, so the caller can show "imported N accounts, …". */
export interface ImportCounts {
  accounts: number;
  incomes: number;
  payments: number;
  contributions: number;
  balanceSnapshots: number;
  closes: number;
  projects: number;
}

/**
 * Everything the user owns, as one portable document.
 *
 * Owned accounts only. An account shared *into* one of the user's households is
 * visible to them but belongs to its owner — exporting it here would hand one
 * member a copy of another member's finances, and importing it back would fork
 * a second, silently diverging copy. The owner exports their own.
 *
 * Household-level data (memberships, shares, transfer confirmations, household
 * month closes) is likewise absent: it describes an arrangement between people,
 * not one person's records.
 */
export async function buildExport(store: Store, userId: string): Promise<ExportFile> {
  const owned = await store.listAccountsForOwner(userId);

  const accounts: ExportFile["accounts"] = [];
  for (const account of owned) {
    const [incomes, payments, contributions, balances, closes] = await Promise.all([
      store.listIncomes(account.id),
      store.listPayments(account.id),
      store.listContributionsForAccount(account.id),
      store.listBalanceSnapshots(account.id),
      store.listMonthCloses({ accountId: account.id }),
    ]);

    const byPayment = new Map<string, typeof contributions>();
    for (const c of contributions) {
      const list = byPayment.get(c.paymentId) ?? [];
      list.push(c);
      byPayment.set(c.paymentId, list);
    }

    accounts.push({
      name: account.name,
      description: account.description,
      currency: account.currency,
      openingBalanceMinor: account.openingBalanceMinor,
      monthlyBufferMinor: account.monthlyBufferMinor,
      incomes: incomes.map((i) => ({
        name: i.name,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        recurrence: i.recurrence,
        anchorDate: i.anchorDate,
        active: i.active,
      })),
      payments: payments.map((p) => ({
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate,
        recurrence: p.recurrence,
        targetDate: p.targetDate,
        priority: p.priority,
        alreadySavedMinor: p.alreadySavedMinor,
        autoRenew: p.autoRenew,
        active: p.active,
        notes: p.notes,
        scope: p.scope,
        fixedMonthlyMinor: p.fixedMonthlyMinor,
        tag: p.tag,
        // bearerUserId and projectId are deliberately not exported: they are ids
        // of rows this document doesn't carry, so they cannot survive a trip
        // into another account (or another deployment) as anything but a
        // dangling reference.
        contributions: (byPayment.get(p.id) ?? []).map((c) => ({
          month: c.month,
          amountMinor: c.amountMinor,
          note: c.note,
        })),
      })),
      balanceSnapshots: balances.map((b) => ({
        asOfDate: b.asOfDate,
        balanceMinor: b.balanceMinor,
      })),
      closes: closes.map((c) => ({
        month: c.month,
        incomeMinor: c.incomeMinor,
        plannedMinor: c.plannedMinor,
        contributedMinor: c.contributedMinor,
      })),
    });
  }

  const projects = (await store.listProjectsForOwner(userId)).map((p) => ({
    name: p.name,
    description: p.description,
    color: p.color,
    targetDate: p.targetDate,
  }));

  return { version: 1, exportedAt: new Date().toISOString(), accounts, projects };
}

/**
 * Recreate an export under `userId`, with fresh ids throughout.
 *
 * Additive by design: nothing existing is wiped, so importing twice gives two
 * copies rather than a silent overwrite. Anyone wanting a clean slate can
 * delete their accounts first — a destructive import would be a much sharper
 * tool than a restore button needs to be.
 *
 * Imported contributions are attributed to the importing user and carry no
 * transfer confirmation: the household transfer they may once have recorded
 * doesn't exist on this side of the import.
 */
export async function importExport(
  store: Store,
  userId: string,
  file: ExportFile,
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    accounts: 0,
    incomes: 0,
    payments: 0,
    contributions: 0,
    balanceSnapshots: 0,
    closes: 0,
    projects: 0,
  };

  for (const a of file.accounts) {
    const account = await store.createAccount({
      ownerUserId: userId,
      name: a.name,
      description: a.description,
      currency: a.currency,
      openingBalanceMinor: a.openingBalanceMinor,
      monthlyBufferMinor: a.monthlyBufferMinor,
    });
    counts.accounts += 1;

    for (const i of a.incomes) {
      await store.createIncome({
        accountId: account.id,
        name: i.name,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        recurrence: i.recurrence,
        anchorDate: i.anchorDate,
        active: i.active,
      });
      counts.incomes += 1;
    }

    for (const p of a.payments) {
      const payment = await store.createPayment({
        accountId: account.id,
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate,
        recurrence: p.recurrence,
        targetDate: p.targetDate,
        priority: p.priority,
        alreadySavedMinor: p.alreadySavedMinor,
        autoRenew: p.autoRenew,
        active: p.active,
        notes: p.notes,
        projectId: null, // not exported; see buildExport
        scope: p.scope,
        bearerUserId: null, // not exported; see buildExport
        fixedMonthlyMinor: p.fixedMonthlyMinor,
        tag: p.tag,
      });
      counts.payments += 1;

      for (const c of p.contributions) {
        await store.createContribution({
          paymentId: payment.id,
          accountId: account.id,
          userId,
          month: c.month,
          amountMinor: c.amountMinor,
          note: c.note,
          transferConfirmationId: null,
        });
        counts.contributions += 1;
      }
    }

    for (const b of a.balanceSnapshots) {
      await store.upsertBalanceSnapshot({
        accountId: account.id,
        asOfDate: b.asOfDate,
        balanceMinor: b.balanceMinor,
      });
      counts.balanceSnapshots += 1;
    }

    // One close per month is the store's rule; a hand-edited file repeating a
    // month keeps its first entry rather than blowing up the whole import.
    const seenMonths = new Set<string>();
    for (const c of a.closes) {
      if (seenMonths.has(c.month)) continue;
      seenMonths.add(c.month);
      await store.createMonthClose({
        householdId: null,
        accountId: account.id,
        month: c.month,
        incomeMinor: c.incomeMinor,
        plannedMinor: c.plannedMinor,
        contributedMinor: c.contributedMinor,
        closedBy: userId,
      });
      counts.closes += 1;
    }
  }

  for (const p of file.projects) {
    await store.createProject({
      ownerUserId: userId,
      name: p.name,
      description: p.description,
      color: p.color,
      targetDate: p.targetDate,
    });
    counts.projects += 1;
  }

  return counts;
}
