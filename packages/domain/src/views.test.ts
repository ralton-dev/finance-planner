import { describe, expect, it } from "vitest";
// The two view modules, as text. Vite's `?raw` is the only way to read a source
// file here without adding a dependency on node's typings, and reading the file
// rather than the module is the point: an assertion over exported functions
// would miss a helper, and a helper is exactly where a second funding loop would
// go.
// @ts-expect-error — `?raw` is a Vite import form with no ambient declaration.
import flowSource from "./flow.ts?raw";
// @ts-expect-error — `?raw` is a Vite import form with no ambient declaration.
import projectionSource from "./projection.ts?raw";
// @ts-expect-error — `?raw` is a Vite import form with no ambient declaration.
import scopeSource from "./scope.ts?raw";

/**
 * **No view recomputes funding.**
 *
 * This is the property the whole of ONE-ENGINE.md turns on, and it is the one
 * property that cannot be tested by comparing numbers: two funding loops agree
 * on every fixture anyone thinks to write, right up until the day they do not —
 * which is how the household page came to read £2,793 against the flow diagram's
 * £2,093 for the same account in the same month.
 *
 * So it is asserted structurally instead. A funding decision needs two things: a
 * way to turn a payment into a monthly requirement, and a pool to spend down. If
 * neither module can name the first or holds the second, neither module can have
 * an opinion about what got funded — it can only report what `computeScopePlan`
 * decided.
 *
 * `contributionCapMinor` is deliberately not on the list. `projection.ts` reads
 * it to answer "does this goal ever fall *due*?", which is a question about a
 * payment's shape and not about anybody's money.
 */

/** The functions that turn a payment into a claim on somebody's month. */
const FUNDING_PRIMITIVES = ["requiredMonthlyForPayment", "monthlyIncomeMinor", "splitByShares"];

/** A mutable pool is what a funding loop spends. Names as they are used across
 *  the pass and the old account engine: `remainingOwn`, `remainingInflow`,
 *  `ownPool`, `inflowPool`, `budget`, `outboundOwn`. */
const FUNDING_POOL = /\blet\s+(remaining|own|inflow|budget|pool|outbound)/i;

function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part
        .replace(/\btype\b/, "")
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

const modules: [string, string][] = [
  ["flow.ts", flowSource as string],
  ["projection.ts", projectionSource as string],
];

describe("no view recomputes funding", () => {
  for (const [name, source] of modules) {
    it(`${name} cannot name a funding primitive`, () => {
      expect({
        module: name,
        primitives: importedNames(source).filter((n) => FUNDING_PRIMITIVES.includes(n)),
      }).toEqual({ module: name, primitives: [] });
    });

    it(`${name} holds no pool of its own to spend`, () => {
      expect({ module: name, pool: FUNDING_POOL.exec(source)?.[0] ?? null }) //
        .toEqual({ module: name, pool: null });
    });
  }

  it("would notice if one appeared", () => {
    // The assertions above are only worth anything if they can fail, so the one
    // module that *is* allowed a funding loop is the positive control: the pass
    // itself names the primitives and holds the pools. If this ever goes red,
    // the checks above have stopped looking at the right text and the four
    // assertions before it are passing for no reason.
    const pass = scopeSource as string;
    expect(
      importedNames(pass)
        .filter((n) => FUNDING_PRIMITIVES.includes(n))
        .sort(),
    ).toEqual(["monthlyIncomeMinor", "requiredMonthlyForPayment", "splitByShares"]);
    expect(FUNDING_POOL.test(pass)).toBe(true);
  });
});
