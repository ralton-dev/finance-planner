/**
 * Money arithmetic shared by the engine and the web client.
 *
 * Its own module, reachable as `@finance-planner/contracts/money`, so the
 * browser can have the split without the zod schemas (and zod itself) that the
 * package index pulls in. Everything here is integer **minor units** — never
 * floats in a result.
 */

/**
 * Split an integer `amount` across `weights`, every part a whole minor unit.
 *
 * Each part is that member's exact share **rounded up**: nobody is ever asked
 * for less than they owe. A penny over costs nothing; a penny under means the
 * bill does not clear. So this does *not* conserve — the parts sum to `amount`
 * only when every share divides exactly, and otherwise overshoot it by up to
 * `weights.length - 1` minor units, which lands in the pot as reserve.
 *
 * The household engine splits each obligation on its own and sums, so the
 * overshoot accumulates per line, not per member per month. That is intended;
 * see `computeHouseholdPlan`.
 *
 * Non-positive total weight falls back to an equal split — defensive; the
 * engine pre-normalises.
 */
export function splitByShares(amount: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const safe = weights.map((w) => Math.max(0, w));
  const total = safe.reduce((s, w) => s + w, 0);
  const effective = total > 0 ? safe : safe.map(() => 1);
  const denom = total > 0 ? total : n;
  // `amount * w` stays far inside 2^53 for real money, so a share that divides
  // exactly divides exactly here too and gains no spurious penny.
  return effective.map((w) => Math.ceil((amount * w) / denom));
}
