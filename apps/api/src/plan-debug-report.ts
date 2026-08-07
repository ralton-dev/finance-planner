import type { ScopeCurrencyDebugTrace, ScopeInput, ScopePlan } from "@finance-planner/domain";

/**
 * The engine debug trace, laid out as text.
 *
 * This lives in the API and not in `@finance-planner/domain` on purpose. The
 * *explanations* inside the trace — why a payment required what it did, how an
 * income normalised — are built during the pass itself, out of intermediate
 * values that exist nowhere else, so they stay in the engine. This function is
 * the other half: pure formatting over `explainScopePlan`'s published output,
 * reaching for nothing the trace does not already carry. Keeping it here holds
 * the engine package to its coverage gate rather than spending it on a string
 * builder, and leaves the domain free of presentation.
 */
export function renderScopeDebugReport(
  input: ScopeInput,
  plan: ScopePlan,
  traces: readonly ScopeCurrencyDebugTrace[],
): string {
  const accountName = new Map(input.accounts.map((a) => [a.accountId, a.name ?? "account"]));
  const memberName = new Map(input.members.map((m) => [m.userId, m.displayName ?? "user"]));
  const movementName = new Map<string, string>();
  for (const trace of traces) {
    for (const edge of trace.savings.edges) {
      if (edge.name) movementName.set(edge.inflowId, edge.name);
    }
    for (const account of trace.savings.accountSteps) {
      for (const movement of account.movements) {
        if (movement.name) movementName.set(movement.inflowId, movement.name);
      }
    }
    for (const movement of trace.savings.unknownSources) {
      if (movement.name) movementName.set(movement.inflowId, movement.name);
    }
  }
  const accountLabel = (id: string): string => accountName.get(id) ?? "unknown account";
  const memberLabel = (id: string): string => memberName.get(id) ?? "unknown user";
  const movementLabel = (id: string): string => movementName.get(id) ?? "authored movement";
  const out: string[] = [
    "Finance Planner engine debug report",
    `scope: ${plan.householdId ? "household account set" : "account set"}`,
    `household: ${plan.householdId ? "yes" : "none"}`,
    `as of: ${plan.asOfDate}`,
    "",
    "This report follows the one scope pass: account inputs, member budgets, global funding rank, derived transfers, authored movements, account residuals, then user rollup.",
  ];

  for (const trace of traces) {
    const partition = plan.partitions.find((p) => p.currency === trace.currency);
    out.push("", `Currency ${trace.currency}`, "====================");

    out.push("", "Phase 1 - account income and buffers");
    for (const account of trace.accounts) {
      out.push(
        `- ${accountLabel(account.accountId)} role=${account.role} owner=${memberLabel(account.ownerUserId)} rosterMember=${account.memberUserId ? memberLabel(account.memberUserId) : "none"}`,
        `  income total: ${moneyMinor(trace.currency, account.monthlyIncomeMinor)}; buffer: ${moneyMinor(trace.currency, account.monthlyBufferMinor)}`,
      );
      if (account.incomes.length === 0) {
        out.push("  incomes: none");
      } else {
        for (const income of account.incomes) {
          out.push(
            `  income ${income.name ?? "income"}: amount ${moneyMinor(trace.currency, income.amountMinor)}, frequency ${income.frequency}, active=${income.active} -> monthly ${moneyMinor(trace.currency, income.monthlyMinor)} (${income.explanation})`,
          );
        }
      }
    }

    out.push("", "Phase 1 - member attribution");
    for (const member of trace.members) {
      out.push(
        `- ${memberLabel(member.userId)} shareWeight=${member.shareWeight}/${trace.totalShareBp || 0}, normalisedShareBp=${member.shareBp}`,
        `  income ${moneyMinor(trace.currency, member.incomeMinor)} - personal buffers ${moneyMinor(trace.currency, member.bufferMinor)} = budget ${moneyMinor(trace.currency, member.budgetMinor)}`,
        `  transfer source account: ${member.sourceAccountId ? accountLabel(member.sourceAccountId) : "none"}`,
      );
    }

    out.push("", "Phase 1 - payment requirements and allocation");
    if (trace.payments.length === 0) out.push("- no active payments in this currency");
    for (const payment of trace.payments) {
      out.push(
        `- ${payment.name} on ${accountLabel(payment.accountId)} priority=${payment.priority}, sortDate=${payment.sortDate}`,
        `  category=${payment.category}, scope=${payment.scope}, amount=${moneyMinor(trace.currency, payment.amountMinor)}, alreadySaved=${moneyMinor(trace.currency, payment.alreadySavedMinor)}`,
        `  required=${moneyMinor(trace.currency, payment.requiredMonthlyMinor)}, effectiveDate=${payment.effectiveDate}, months=${payment.monthsUntilDue}, occurrencesThisMonth=${payment.occurrencesThisMonth}`,
        `  formula: ${payment.explanation}`,
      );
      for (const allocation of payment.allocations) {
        out.push(
          `  allocation -> ${memberLabel(allocation.userId)} requires ${moneyMinor(trace.currency, allocation.requiredMinor)}`,
        );
      }
    }

    out.push("", "Phase 2 - global funding queue by rank");
    if (trace.fundingSteps.length === 0) out.push("- no obligations queued");
    for (const step of trace.fundingSteps) {
      const target = step.kind === "payment" ? (step.paymentName ?? "payment") : "buffer reserve";
      out.push(
        `#${step.rank} ${target} on ${accountLabel(step.accountId)} for ${memberLabel(step.memberUserId)}`,
        `  priority=${step.priority}, sortDate=${step.sortDate}, required=${moneyMinor(trace.currency, step.requiredMinor)}`,
        `  member budget before ${moneyMinor(trace.currency, step.budgetBeforeMinor)}; funded ${moneyMinor(trace.currency, step.fundedMinor)}; after ${moneyMinor(trace.currency, step.budgetAfterMinor)}; shortfall ${moneyMinor(trace.currency, step.shortfallMinor)}`,
      );
    }

    out.push("", "Phase 2b - destination account self-funding");
    if (trace.selfFundingSteps.length === 0)
      out.push("- no destination account income covered its own obligations");
    for (const step of trace.selfFundingSteps) {
      const target = step.kind === "payment" ? (step.paymentName ?? "payment") : "buffer reserve";
      out.push(
        `#${step.rank} ${accountLabel(step.accountId)} ${target} draws from ${step.pool} pool`,
        `  pool owner=${step.ownerUserId ? memberLabel(step.ownerUserId) : "unowned in this scope"}, wanted=${moneyMinor(trace.currency, step.wantMinor)}, pool before=${moneyMinor(trace.currency, step.poolBeforeMinor)}, covered=${moneyMinor(trace.currency, step.coveredMinor)}, pool after=${moneyMinor(trace.currency, step.poolAfterMinor)}`,
      );
      for (const entry of step.entries) {
        out.push(
          `  ${memberLabel(entry.memberUserId)} funded ${moneyMinor(trace.currency, entry.fundedMinor)}; already in destination ${moneyMinor(trace.currency, entry.selfFundedMinor)}; transfer still needed ${moneyMinor(trace.currency, entry.transferNeededMinor)}`,
        );
      }
    }

    out.push("", "Phase 3 - derived transfer derivation");
    if (trace.transferDerivations.length === 0) out.push("- no funded obligation needed transport");
    for (const d of trace.transferDerivations) {
      const target = d.kind === "payment" ? (d.paymentName ?? "payment") : "buffer reserve";
      const from = d.fromAccountId ? accountLabel(d.fromAccountId) : "no source account";
      out.push(
        `- ${target} for ${memberLabel(d.memberUserId)} on ${accountLabel(d.toAccountId)}`,
        `  funded=${moneyMinor(trace.currency, d.fundedMinor)}, already in destination=${moneyMinor(trace.currency, d.selfFundedMinor)}, moving=${moneyMinor(trace.currency, d.movingMinor)}, from=${from}, reason=${d.reason}`,
      );
    }
    out.push("  aggregated derived transfers:");
    if (trace.transfers.length === 0) out.push("  - none");
    for (const t of trace.transfers) {
      out.push(
        `  - ${accountLabel(t.fromAccountId)} -> ${accountLabel(t.toAccountId)} for ${memberLabel(t.memberUserId)}: amount ${moneyMinor(trace.currency, t.amountMinor)}, confirmed ${moneyMinor(trace.currency, t.confirmedMinor)}`,
      );
    }

    out.push("", "Phase 3b - expense funding sources by account pool");
    if (trace.expenseSplits.length === 0) out.push("- no payment lines to split");
    for (const split of trace.expenseSplits) {
      out.push(
        `#${split.rank} ${split.name} on ${accountLabel(split.accountId)}`,
        `  paid ${moneyMinor(trace.currency, split.paidMinor)} of required ${moneyMinor(trace.currency, split.requiredMinor)}; line funded total ${moneyMinor(trace.currency, split.fundedMinor)}`,
        `  own pool ${moneyMinor(trace.currency, split.ownPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.ownPoolAfterMinor)}; funded from own ${moneyMinor(trace.currency, split.fundedFromOwnMinor)}`,
        `  inflow pool ${moneyMinor(trace.currency, split.inflowPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.inflowPoolAfterMinor)}; funded from arriving money ${moneyMinor(trace.currency, split.fundedFromInflowMinor)}`,
      );
    }

    out.push("", "Phase 3c - buffer held back from savings");
    for (const held of trace.heldBack) {
      out.push(
        `- ${accountLabel(held.accountId)} buffer ${moneyMinor(trace.currency, held.bufferMinor)} against income ${moneyMinor(trace.currency, held.monthlyIncomeMinor)} -> held back from savings ${moneyMinor(trace.currency, held.heldBackMinor)}`,
      );
    }

    out.push("", "Phase 3d - derived transfers leaving source accounts");
    if (trace.transferOutSplits.length === 0)
      out.push("- no derived transfer leaves a source account");
    for (const split of trace.transferOutSplits) {
      out.push(
        `- ${accountLabel(split.accountId)} sends derived transfers totalling ${moneyMinor(trace.currency, split.transferOutMinor)}`,
        `  own pool ${moneyMinor(trace.currency, split.ownPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.ownPoolAfterMinor)}; paid from own ${moneyMinor(trace.currency, split.fundedFromOwnMinor)}`,
        `  inflow pool ${moneyMinor(trace.currency, split.inflowPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.inflowPoolAfterMinor)}; paid from arriving money ${moneyMinor(trace.currency, split.fundedFromInflowMinor)}`,
      );
    }

    out.push("", "Phase 4 - authored savings movements");
    out.push(
      `graph order: ${trace.savings.order.length ? trace.savings.order.map(accountLabel).join(" -> ") : "none"}`,
    );
    if (trace.savings.edges.length === 0) out.push("graph edges: none");
    for (const edge of trace.savings.edges) {
      out.push(
        `movement ${edge.name ?? movementLabel(edge.inflowId)}: ${accountLabel(edge.fromAccountId)} -> ${accountLabel(edge.toAccountId)}, priority=${edge.priority}, requested=${moneyMinor(trace.currency, edge.requestedMinor)}`,
      );
    }
    if (trace.savings.cycles.length > 0) {
      for (const cycle of trace.savings.cycles) {
        out.push(
          `cycle: accounts ${cycle.accountIds.map(accountLabel).join(" -> ")}; movements ${cycle.inflowIds.map(movementLabel).join(" -> ")}; broken=${movementLabel(cycle.brokenInflowId)}`,
        );
      }
    }
    for (const account of trace.savings.accountSteps) {
      out.push(
        `- ${accountLabel(account.accountId)} starts savings with own pool ${moneyMinor(trace.currency, account.ownPoolStartMinor)} and inflow pool ${moneyMinor(trace.currency, account.inflowPoolStartMinor)} plus arrivals ${moneyMinor(trace.currency, account.arrivalsMinor)}`,
      );
      if (account.arrivals.length > 0) {
        for (const arrival of account.arrivals) {
          out.push(
            `  arrival ${movementLabel(arrival.inflowId)} from ${accountLabel(arrival.fromAccountId)}: ${moneyMinor(trace.currency, arrival.amountMinor)} confirmed ${moneyMinor(trace.currency, arrival.confirmedMinor ?? 0)}`,
          );
        }
      }
      if (account.movements.length === 0) out.push("  no authored movements leave this account");
      for (const movement of account.movements) {
        out.push(
          `  #${movement.rank} movement ${movement.name ?? movementLabel(movement.inflowId)}: ${accountLabel(movement.fromAccountId)} -> ${accountLabel(movement.toAccountId)} priority=${movement.priority}, requested=${moneyMinor(trace.currency, movement.requestedMinor)}, status=${movement.status}`,
          `    own ${moneyMinor(trace.currency, movement.ownBeforeMinor)} -> ${moneyMinor(trace.currency, movement.ownAfterMinor)}; funded from own ${moneyMinor(trace.currency, movement.fundedFromOwnMinor)}`,
          `    inflow ${moneyMinor(trace.currency, movement.inflowBeforeMinor)} -> ${moneyMinor(trace.currency, movement.inflowAfterMinor)}; funded from arriving money ${moneyMinor(trace.currency, movement.fundedFromInflowMinor)}; delivered inside partition=${movement.deliveredToPartition}`,
        );
      }
      out.push(
        `  savings pools end: own ${moneyMinor(trace.currency, account.ownPoolEndMinor)}, inflow ${moneyMinor(trace.currency, account.inflowPoolEndMinor)}`,
      );
    }
    if (trace.savings.unknownSources.length > 0) {
      out.push("unknown-source movement rows:");
      for (const movement of trace.savings.unknownSources) {
        out.push(
          `- ${movement.name ?? movementLabel(movement.inflowId)}: sender account is outside this planned scope; requested ${moneyMinor(trace.currency, movement.requestedMinor)} funds 0`,
        );
      }
    }

    out.push("", "Per account final breakdown");
    for (const account of partition?.accounts ?? []) {
      const authoredFromAvailable =
        account.monthlyIncomeMinor +
        account.transferInMinor -
        account.fundedOutflowMinor -
        account.transferOutMinor -
        account.availableLeftoverMinor;
      out.push(
        `- ${accountLabel(account.accountId)}`,
        `  available left over: income ${moneyMinor(trace.currency, account.monthlyIncomeMinor)} + derived in ${moneyMinor(trace.currency, account.transferInMinor)} - expenses funded ${moneyMinor(trace.currency, account.fundedOutflowMinor)} - derived out ${moneyMinor(trace.currency, account.transferOutMinor)} - authored savings from available money ${moneyMinor(trace.currency, authoredFromAvailable)} = ${moneyMinor(trace.currency, account.availableLeftoverMinor)}`,
        `  flow residual: income ${moneyMinor(trace.currency, account.monthlyIncomeMinor)} + derived in ${moneyMinor(trace.currency, account.transferInMinor)} + movement in ${moneyMinor(trace.currency, account.movementInMinor)} - expenses funded ${moneyMinor(trace.currency, account.fundedOutflowMinor)} - derived out ${moneyMinor(trace.currency, account.transferOutMinor)} - authored out ${moneyMinor(trace.currency, account.committedMinor)} = ${moneyMinor(trace.currency, account.leftoverMinor)}`,
        `  movement in ${moneyMinor(trace.currency, account.movementInMinor)} is reserved/saved money, not counted as available left over; shortfall ${moneyMinor(trace.currency, account.shortfallMinor)}; confirmed arriving ${moneyMinor(trace.currency, account.confirmedInflowMinor)}`,
      );
      const lines = (partition?.lines ?? []).filter((l) => l.accountId === account.accountId);
      if (lines.length === 0) out.push("  expenses: none");
      for (const line of lines) {
        out.push(
          `  expense ${line.name} priority=${line.priority}: required ${moneyMinor(trace.currency, line.requiredMonthlyMinor)}, funded ${moneyMinor(trace.currency, line.fundedMonthlyMinor)} (own ${moneyMinor(trace.currency, line.fundedFromOwnMinor)}, arriving ${moneyMinor(trace.currency, line.fundedFromInflowMinor)}), onTrack=${line.onTrack}`,
        );
        for (const allocation of line.allocations) {
          out.push(
            `    ${memberLabel(allocation.userId)} required ${moneyMinor(trace.currency, allocation.requiredMinor)}, funded ${moneyMinor(trace.currency, allocation.fundedMinor)}`,
          );
        }
      }
      const transfersIn = (partition?.transfers ?? []).filter(
        (t) => t.toAccountId === account.accountId,
      );
      const transfersOut = (partition?.transfers ?? []).filter(
        (t) => t.fromAccountId === account.accountId,
      );
      for (const transfer of transfersIn) {
        out.push(
          `  derived transfer in from ${accountLabel(transfer.fromAccountId)} for ${memberLabel(transfer.memberUserId)}: ${moneyMinor(trace.currency, transfer.amountMinor)} confirmed ${moneyMinor(trace.currency, transfer.confirmedMinor)}`,
        );
      }
      for (const transfer of transfersOut) {
        out.push(
          `  derived transfer out to ${accountLabel(transfer.toAccountId)} for ${memberLabel(transfer.memberUserId)}: ${moneyMinor(trace.currency, transfer.amountMinor)} confirmed ${moneyMinor(trace.currency, transfer.confirmedMinor)}`,
        );
      }
      for (const movement of (partition?.movements ?? []).filter(
        (m) => m.fromAccountId === account.accountId || m.toAccountId === account.accountId,
      )) {
        out.push(
          `  authored movement ${movementLabel(movement.inflowId)} ${accountLabel(movement.fromAccountId)} -> ${accountLabel(movement.toAccountId)}: requested ${moneyMinor(trace.currency, movement.requestedMinor)}, funded ${moneyMinor(trace.currency, movement.fundedMinor)} (own ${moneyMinor(trace.currency, movement.fundedFromOwnMinor)}, arriving ${moneyMinor(trace.currency, movement.fundedFromInflowMinor)}), status=${movement.status}`,
        );
      }
    }

    out.push("", "Per user final breakdown");
    for (const member of partition?.members ?? []) {
      const ownedAccounts = (partition?.accounts ?? []).filter(
        (account) => account.ownerUserId === member.userId,
      );
      out.push(
        `- ${memberLabel(member.userId)}`,
        `  income ${moneyMinor(trace.currency, member.monthlyIncomeMinor)}; obligations required ${moneyMinor(trace.currency, member.obligationMinor)}; funded ${moneyMinor(trace.currency, member.fundedMinor)}; shortfall ${moneyMinor(trace.currency, member.shortfallMinor)}`,
        `  available left over across owned accounts ${moneyMinor(trace.currency, member.availableLeftoverMinor)}`,
      );
      for (const account of ownedAccounts) {
        out.push(
          `    ${accountLabel(account.accountId)} contributes available ${moneyMinor(trace.currency, account.availableLeftoverMinor)}`,
        );
      }
      out.push(
        `  funding budget leftover before authored savings ${moneyMinor(trace.currency, member.leftoverMinor)}; authored savings committed ${moneyMinor(trace.currency, member.committedMinor)}; source account ${member.sourceAccountId ? accountLabel(member.sourceAccountId) : "none"}`,
      );
    }
  }

  return out.join("\n");
}

function moneyMinor(currency: string, minor: number): string {
  return `${currency} ${minor} minor`;
}
