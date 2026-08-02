import { SELECTION_ABANDONED_MARKER } from "../../src/select/analyze.ts";
import { runEval, type CaseContext, type EvalCaseResult, type EvalOptions } from "./eval-runner.ts";
import { formatUsd, renderTable, type ResultMeta } from "./results.ts";
import {
  computeSelectMetrics,
  parseSelectOutput,
  scoreSelectCase,
  type SelectMetrics,
  type SelectSpecOutcome,
} from "./score-select.ts";

export interface SelectEvalSummary {
  meta: ResultMeta;
  cases: EvalCaseResult<SelectSpecOutcome>[];
  metrics: SelectMetrics;
  resultPath: string;
}

/**
 * Run `ccqa select-specs` between each case's two commits and score the
 * verdicts against the case's expected spec set.
 */
export async function runSelectEval(opts: EvalOptions = {}): Promise<SelectEvalSummary> {
  const { meta, cases, aggregate, resultPath } = await runEval(
    {
      kind: "select",
      promptVersion: null,
      runCase: runSelectCase,
      aggregate: computeSelectMetrics,
      aggregateKey: "metrics",
      printSummary: (s) =>
        printSelectSummary({ meta: s.meta, cases: s.cases, metrics: s.aggregate, resultPath: s.resultPath }),
    },
    opts,
  );
  return { meta, cases, metrics: aggregate, resultPath };
}

async function runSelectCase({ evalCase, repo, model, ccqa }: CaseContext): Promise<SelectSpecOutcome[]> {
  const res = await ccqa(["select-specs", "--base", repo.baseSha, "--head", repo.headSha, "--format", "json", "--model", model]);
  if (res.exitCode !== 0) {
    throw new Error(`select-specs failed for case ${evalCase.name} (exit ${res.exitCode}):\n${res.stderr}`);
  }
  // An abandoned selection exits 0 with every spec `unknown` — running
  // everything is the command's intended degradation, but scoring it would
  // grade the fallback, not the model: on a case expecting all-`needed`, a
  // dead credential would post precision and recall 1.0.
  if (res.stderr.includes(SELECTION_ABANDONED_MARKER)) {
    throw new Error(
      `select-specs abandoned its selection for case ${evalCase.name} — the model never produced ` +
        `a usable answer, so there is nothing to score:\n${res.stderr.trim()}`,
    );
  }
  return scoreSelectCase(evalCase.expect.select ?? {}, parseSelectOutput(res.stdout));
}

function printSelectSummary(summary: SelectEvalSummary): void {
  console.log("");
  console.log(
    renderTable([
      ["case", "spec", "expected", "verdict", ""],
      ...summary.cases.flatMap((c) =>
        c.outcomes.map((o) => [c.name, o.spec, o.expected, o.verdict, o.verdict === o.expected ? "" : "MISS"]),
      ),
    ]),
  );
  const { metrics, meta } = summary;
  const fmt = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  console.log("");
  console.log(
    `selected-set precision ${fmt(metrics.precision)}, recall ${fmt(metrics.recall)} ` +
      `(tp ${metrics.truePositives}, fp ${metrics.falsePositives}, fn ${metrics.falseNegatives})`,
  );
  console.log(`exact verdicts ${fmt(metrics.verdictAccuracy)}`);
  if (metrics.unknowns > 0) {
    console.log(`undecided ${metrics.unknowns} verdict(s) came back unknown — selected, but the model declined them`);
  }
  if (meta.cost) {
    console.log(`cost ${formatUsd(meta.cost.totalUsd)} over ${meta.cost.invocations} invocation(s)`);
  }
  console.log(`model ${meta.model}`);
  console.log(`results: ${summary.resultPath}`);
}
