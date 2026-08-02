import { SelectReportSchema, type SelectReport, type SelectVerdict } from "../../src/select/types.ts";
import type { SelectExpectation } from "./cases.ts";

export function parseSelectOutput(stdout: string): SelectReport {
  return SelectReportSchema.parse(JSON.parse(stdout));
}

export interface SelectSpecOutcome {
  spec: string;
  expected: SelectExpectation;
  verdict: SelectVerdict;
  /** Whether the caller would run it — `needed` and `unknown` both run. */
  selected: boolean;
}

/**
 * Score one case's selection: every spec in the report against the case's
 * expectation map, specs absent from the map expected `notNeeded`. Scored on
 * what actually runs, so an `unknown` verdict counts as a selection — safe
 * for the suite, but paid for in CI minutes, which is what precision prices.
 */
export function scoreSelectCase(
  expectations: Readonly<Record<string, SelectExpectation>>,
  report: SelectReport,
): SelectSpecOutcome[] {
  return report.specs.map((row) => {
    const key = `${row.featureName}/${row.specName}`;
    return {
      spec: key,
      expected: expectations[key] ?? "notNeeded",
      verdict: row.verdict,
      selected: row.verdict !== "notNeeded",
    };
  });
}

export interface SelectMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Null when nothing was selected — 0/0 is "no claim made", not a score. */
  precision: number | null;
  /** Null when nothing was expected needed. */
  recall: number | null;
  /** Exact verdict matches; `unknown` never matches exactly. */
  verdictAccuracy: number;
}

export function computeSelectMetrics(outcomes: readonly SelectSpecOutcome[]): SelectMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let exact = 0;
  for (const o of outcomes) {
    if (o.selected && o.expected === "needed") tp++;
    else if (o.selected && o.expected === "notNeeded") fp++;
    else if (!o.selected && o.expected === "needed") fn++;
    else tn++;
    if (o.verdict === o.expected) exact++;
  }
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    verdictAccuracy: outcomes.length === 0 ? 0 : exact / outcomes.length,
  };
}
