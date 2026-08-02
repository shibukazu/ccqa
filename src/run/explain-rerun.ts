import type { PredictedLabel, ReportSpecResult } from "../report/schema.ts";
import type { SpecRef } from "../store/index.ts";
import { C } from "../cli/colors.ts";
import * as log from "../cli/logger.ts";
import { errMessage } from "./errors.ts";

/**
 * `ccqa run --on-fail-explain-rerun`: run a failed spec a second time and let
 * the result settle what one run cannot.
 *
 * `ENVIRONMENT` is the only cause with no artifact to read — a service that is
 * down, an expired credential, a timing race. When the log names it the
 * classifier can call it, and when it does not the honest answer is `UNKNOWN`
 * (ADR-0016). The evidence that would settle either is whether a second
 * attempt at the same commit passes, and this phase is what collects it.
 *
 * It runs after the classification, on the rows it produced, because `auto`
 * keys off the label. The second attempt is discarded except for its verdict:
 * it is not a row of this run, it is why one of the rows is red.
 */

export const EXPLAIN_RERUN_MODES = ["auto", "always", "never"] as const;
export type ExplainRerunMode = (typeof EXPLAIN_RERUN_MODES)[number];

/** What a second attempt showed. "failed" means the failure reproduced. */
export type RerunOutcome = "passed" | "failed";

/**
 * The labels a second attempt can settle. `UNKNOWN` is the refusal the feature
 * exists to turn into an answer; `ENVIRONMENT` is rerun to confirm, since a
 * failure that reproduces is not the timing race that reading alone cannot
 * rule out.
 */
const RERUNNABLE_LABELS: readonly PredictedLabel[] = ["UNKNOWN", "ENVIRONMENT"];

/** Evidence sentences the rerun writes onto the row, in the classifier's own currency. */
const DID_NOT_REPRODUCE = "a second attempt at the same commit passed: the failure is not reproducible";
const REPRODUCED = "a second attempt at the same commit failed too: the failure is reproducible";

/**
 * Confidence for a label the rerun settled. High, because the observation is
 * direct rather than read out of a diff — but short of certainty, since "did
 * not reproduce" is still an inference about the first attempt.
 */
const RERUN_SETTLED_CONFIDENCE = 0.95;

export interface ExplainRerunOptions {
  mode: ExplainRerunMode;
  /** How many specs may be rerun; null is uncapped. See `--on-fail-explain-rerun-max-specs`. */
  maxSpecs: number | null;
  /** Re-executes one spec on the path that just ran it and reports what happened. */
  execute: (ref: SpecRef) => Promise<RerunOutcome>;
}

/** Whether this row is one `mode` asks for a second attempt at. */
function wantsRerun(row: ReportSpecResult, mode: ExplainRerunMode): boolean {
  if (mode === "never" || row.status !== "failed" || row.analysis === null) return false;
  return mode === "always" || RERUNNABLE_LABELS.includes(row.analysis.label);
}

/**
 * Rerun the failures `mode` selects and fold each verdict into its row.
 * Returns every row in the order given; the ones not rerun pass through
 * untouched.
 *
 * A rerun that throws leaves its row as the classifier left it, named in a
 * warning: a second attempt that never ran has established nothing, and
 * pretending otherwise is the one thing this phase must not do.
 */
export async function rerunExplainedFailures(
  rows: readonly ReportSpecResult[],
  opts: ExplainRerunOptions,
): Promise<ReportSpecResult[]> {
  const eligible = rows.filter((row) => wantsRerun(row, opts.mode));
  if (eligible.length === 0) return [...rows];

  const budget = opts.maxSpecs ?? eligible.length;
  const skipped = eligible.slice(budget);
  log.emitRaw(`\n${C.cyan}${C.bold}──────── failure rerun ────────${C.reset}\n\n`);

  const applied = new Map<string, ReportSpecResult>();
  for (const row of eligible.slice(0, budget)) {
    const key = `${row.feature}/${row.spec}`;
    log.info(`rerun: ${key}`);
    let outcome: RerunOutcome;
    try {
      outcome = await opts.execute({ featureName: row.feature, specName: row.spec });
    } catch (err) {
      log.warn(`rerun failed to execute ${key} (${errMessage(err)}); its label stands as first classified`);
      continue;
    }
    const next = applyRerun(row, outcome);
    applied.set(key, next);
    printRerun(key, outcome, next);
  }

  // Named, not counted: a truncated list of what was checked reads as a list
  // of everything that failed.
  if (skipped.length > 0) {
    log.warn(
      `--on-fail-explain-rerun-max-specs ${budget} reached: not rerun, so their labels stand as ` +
        `first classified — ` +
        skipped.map((row) => `${row.feature}/${row.spec}`).join(", "),
    );
  }
  return rows.map((row) => applied.get(`${row.feature}/${row.spec}`) ?? row);
}

/**
 * Fold one verdict into its row. The row stays failed either way — the spec
 * failed, and what the rerun changes is why.
 *
 * A failure that did not reproduce is environmental, so the label says so.
 * One that did reproduce names no artifact it did not name before, so the
 * label stands: ADR-0016 asks a label to be earned, and "not a flake" earns
 * none of the three that point at something in the repository. What was
 * learned lands in the evidence instead, where a human triaging the row reads
 * it.
 */
function applyRerun(row: ReportSpecResult, outcome: RerunOutcome): ReportSpecResult {
  const analysis = row.analysis;
  if (analysis === null) return { ...row, rerun: { outcome } };
  const evidence = [
    ...analysis.evidence,
    { detail: outcome === "passed" ? DID_NOT_REPRODUCE : REPRODUCED },
  ];
  if (outcome === "failed" || !RERUNNABLE_LABELS.includes(analysis.label)) {
    return { ...row, analysis: { ...analysis, evidence }, rerun: { outcome } };
  }
  return {
    ...row,
    analysis: {
      ...analysis,
      label: "ENVIRONMENT",
      confidence: RERUN_SETTLED_CONFIDENCE,
      headline: "the failure did not reproduce on a second attempt",
      recommendation:
        "treat the first attempt as environmental (a transient service, credential, seed-data or timing problem); nothing in the repository is implicated.",
      // The model's argument for its first label is kept, with the observation
      // that overtook it appended — a reader deciding whether to trust the
      // label needs both.
      reasoning: `${analysis.reasoning}\n\n${DID_NOT_REPRODUCE}`.trim(),
      evidence,
    },
    rerun: { outcome },
  };
}

/** One rerun spec's line in the rerun block: what happened, and where it left the label. */
function printRerun(key: string, outcome: RerunOutcome, row: ReportSpecResult): void {
  const icon = outcome === "passed" ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
  const what = outcome === "passed" ? "did not reproduce" : "reproduced";
  const label = row.analysis?.label;
  log.emitRaw(
    `${icon} ${C.bold}${key}${C.reset} → ${what}` +
      `${label ? ` ${C.dim}(${label})${C.reset}` : ""}\n`,
  );
}
