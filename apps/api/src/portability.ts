import type { ExportAccount, ExportFile } from "@finance-planner/contracts";
import type { Account, Store } from "@finance-planner/data";

/** The ISO first-of-month a date falls in — how a confirmation is keyed. */
const monthStart = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;

/** What an import created, so the caller can show "imported N accounts, …". */
export interface ImportCounts {
  accounts: number;
  incomes: number;
  /** Movements between two of the imported accounts. */
  accountInflows: number;
  /** "I moved the money", restored against those movements. */
  accountInflowConfirmations: number;
  /** "I moved the money" for a transfer the plan derived, which has no movement
   *  to be restored against. */
  derivedTransferConfirmations: number;
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
 * Household-level data (memberships, shares, household transfer confirmations,
 * household month closes) is likewise absent: it describes an arrangement
 * between people, not one person's records.
 *
 * A **standalone** confirmation is not household-level and does travel. "I moved
 * this money" between two accounts you own is a fact about two of your own rows,
 * and since WP-H it drives `confirmedInflowMinor` and whether a line reads
 * funded or `awaiting_transfer` — so leaving it behind meant a restore silently
 * un-moved money that had moved. See `inflowConfirmations` for which months are
 * carried.
 *
 * There are **two** shapes of that, not one, and both travel. A confirmation of
 * an authored movement rides on the movement (`accountInflows[].confirmations`);
 * a confirmation of a transfer the plan *derived* has no movement to ride on —
 * nobody wrote the feed down — so it rides on the receiving account, naming its
 * sender (`derivedTransferConfirmations`). Carrying only the first meant a
 * backup of a solo user's fed pot came back with every "I moved it" undone.
 *
 * Money arriving is read from `inflows`, both faces of it. Reading it through
 * `listIncomes` — which projects the external rows only — silently dropped every
 * movement between the user's own accounts the moment they authored one, from
 * export *and* from the import that reads it back: a backup that quietly loses
 * part of the plan it claims to hold.
 */
export async function buildExport(
  store: Store,
  userId: string,
  asOfDate: string,
): Promise<ExportFile> {
  const owned = await store.listAccountsForOwner(userId);
  // Movements name their source account by name, so a source outside this
  // export cannot be represented — see `exportAccountInflow`.
  const nameById = new Map(owned.map((a) => [a.id, a.name]));

  const accounts: ExportFile["accounts"] = [];
  for (const account of owned) {
    const [inflows, payments, contributions, balances, closes] = await Promise.all([
      store.listInflows(account.id),
      store.listPayments(account.id),
      store.listContributionsForAccount(account.id),
      store.listBalanceSnapshots(account.id),
      store.listMonthCloses({ accountId: account.id }),
    ]);
    const incomes = inflows.filter((i) => i.source === "external");
    const movements = inflows.filter(
      (i) => i.source === "account" && i.sourceAccountId && nameById.has(i.sourceAccountId),
    );

    const byPayment = new Map<string, typeof contributions>();
    for (const c of contributions) {
      const list = byPayment.get(c.paymentId) ?? [];
      list.push(c);
      byPayment.set(c.paymentId, list);
    }

    // Which months to look in. The store reads confirmations one month at a
    // time — it is a "has this happened *this* month" question everywhere else
    // — so the export asks about the months this file already describes: every
    // month it carries a contribution or a close for, plus the month it is
    // being taken in. That covers everything a restore can act on; the current
    // month is the one that decides whether a line comes back funded or
    // awaiting a transfer, and a closed month is frozen history either way. A
    // confirmation in a month with no other trace at all is not carried, which
    // is a limit of asking month by month rather than a decision about it.
    const months = new Set<string>([monthStart(asOfDate)]);
    for (const c of contributions) months.add(c.month);
    for (const c of closes) months.add(c.month);
    const confirmedByInflow = new Map<string, { month: string; amountMinor: number }[]>();
    const derivedConfirmations: ExportAccount["derivedTransferConfirmations"] = [];
    for (const month of [...months].sort()) {
      // Skipped entirely for an account with no movements, which is every
      // account until the user authors one.
      if (movements.length > 0) {
        for (const c of await store.listTransferConfirmationsForAccount(account.id, month)) {
          // Only the arriving side: a movement's confirmation is exported once,
          // under the account the money lands in, which is the account the row
          // itself lives on.
          if (!c.inflowId || c.householdId !== null || c.toAccountId !== account.id) continue;
          const list = confirmedByInflow.get(c.inflowId) ?? [];
          list.push({ month: c.month, amountMinor: c.amountMinor });
          confirmedByInflow.set(c.inflowId, list);
        }
      }
      // The other kind, which has no movement to hang off and so no `movements`
      // gate either: a transfer the plan derived, confirmed by a user with no
      // household (migration 0010). Left out of the file, a restore quietly
      // flipped those lines back to `awaiting_transfer` — the user's record of
      // money they really moved, dropped without a word.
      for (const c of await store.listDerivedTransferConfirmationsForAccount(account.id, month)) {
        // Arriving side only, same rule as above.
        if (c.toAccountId !== account.id) continue;
        // Not the exporter's to carry: a confirmation somebody else recorded is
        // their record of their own money, and re-creating it under the
        // importing user would invent a fact — the reasoning that keeps
        // household-level rows out of the file entirely.
        if (c.memberUserId !== userId) continue;
        const fromAccountName = nameById.get(c.fromAccountId);
        // A sender this file does not carry cannot be named, so it cannot be
        // restored — the rule `exportAccountInflow` already applies.
        if (fromAccountName === undefined) continue;
        derivedConfirmations.push({
          fromAccountName,
          month: c.month,
          amountMinor: c.amountMinor,
        });
      }
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
      accountInflows: movements.map((i) => ({
        name: i.name,
        fromAccountName: nameById.get(i.sourceAccountId!)!,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        recurrence: i.recurrence,
        anchorDate: i.anchorDate,
        priority: i.priority,
        active: i.active,
        confirmations: confirmedByInflow.get(i.id) ?? [],
      })),
      derivedTransferConfirmations: derivedConfirmations,
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
 *
 * Accounts are all created first, before anything inside them, because a
 * movement names the account it comes from and that account may appear later in
 * the file than the account it pays into — or, in a chain, may pay into it.
 * There is no ordering of one pass that always works, so there are two.
 */
export async function importExport(
  store: Store,
  userId: string,
  file: ExportFile,
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    accounts: 0,
    incomes: 0,
    accountInflows: 0,
    accountInflowConfirmations: 0,
    derivedTransferConfirmations: 0,
    payments: 0,
    contributions: 0,
    balanceSnapshots: 0,
    closes: 0,
    projects: 0,
  };

  // Pass one: the accounts themselves, and the name → id map a movement needs.
  // A file naming two accounts the same keeps the first, which is the same rule
  // `accountPlacements` uses for an account assigned twice: deterministic, and
  // never a reference to nothing.
  const created = new Map<string, string>();
  const accounts: { input: ExportFile["accounts"][number]; account: Account }[] = [];
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
    if (!created.has(a.name)) created.set(a.name, account.id);
    accounts.push({ input: a, account });
  }

  for (const { input: a, account } of accounts) {
    for (const m of a.accountInflows) {
      const sourceAccountId = created.get(m.fromAccountName);
      // A movement out of an account this file does not carry, or out of the
      // account it arrives in, cannot be recreated: it would be a reference to
      // nothing, or a row the store refuses. Dropped rather than mangled.
      if (!sourceAccountId || sourceAccountId === account.id) continue;
      const inflow = await store.createInflow({
        accountId: account.id,
        name: m.name,
        source: "account",
        sourceAccountId,
        amountMinor: m.amountMinor,
        frequency: m.frequency,
        recurrence: m.recurrence,
        anchorDate: m.anchorDate,
        priority: m.priority,
        active: m.active,
      });
      counts.accountInflows += 1;

      // Standalone, so `householdId` is null and the confirming member is the
      // importing user: there is nobody else in a movement between two of your
      // own accounts. One per month is the store's rule, so a hand-edited file
      // repeating a month keeps its first entry — the same treatment a repeated
      // month close gets.
      //
      // The contributions a confirmation once created are imported separately,
      // under the payments they were booked against, and arrive unlinked
      // (`transferConfirmationId: null`, as every imported contribution does).
      // Both facts survive the trip; what does not is the tie between them, so
      // un-confirming an imported movement leaves its imported contributions
      // where they are rather than taking them with it.
      const seenMonths = new Set<string>();
      for (const c of m.confirmations) {
        if (seenMonths.has(c.month)) continue;
        seenMonths.add(c.month);
        await store.createTransferConfirmation({
          householdId: null,
          inflowId: inflow.id,
          month: c.month,
          fromAccountId: sourceAccountId,
          toAccountId: account.id,
          memberUserId: userId,
          amountMinor: c.amountMinor,
        });
        counts.accountInflowConfirmations += 1;
      }
    }

    // The confirmations with no movement to hang off, restored the same way:
    // household-free, member is the importing user, one per (sender, month)
    // because that is what the store keys them by. The contributions such a
    // confirmation once booked come back under their payments and arrive
    // unlinked, exactly as an authored movement's do — the limitation above,
    // unchanged and not widened: what is lost is the tie, never the row.
    const seenDerived = new Set<string>();
    for (const c of a.derivedTransferConfirmations) {
      const fromAccountId = created.get(c.fromAccountName);
      if (!fromAccountId || fromAccountId === account.id) continue;
      const key = `${fromAccountId}|${c.month}`;
      if (seenDerived.has(key)) continue;
      seenDerived.add(key);
      await store.createTransferConfirmation({
        householdId: null,
        inflowId: null,
        month: c.month,
        fromAccountId,
        toAccountId: account.id,
        memberUserId: userId,
        amountMinor: c.amountMinor,
      });
      counts.derivedTransferConfirmations += 1;
    }

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
