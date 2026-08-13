import { SELECTION_ABANDONED_MARKER } from "../../src/select/analyze.ts";
import { CaseAbandonedError, runEval, type CaseContext, type EvalCaseResult, type EvalOptions } from "./eval-runner.ts";
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
  // An abandoned selection exits 0 with every spec `unknown` — running
  // everything is the command's intended degradation, but scoring it would
  // grade the fallback, not the model: on a case expecting all-`needed`, a
  // dead credential would post precision and recall 1.0. One retry, because a
  // single malformed reply is a flake, not an answer about the prompt.
  for (let attempt = 1; ; attempt++) {
    const res = await ccqa(["select-specs", "--base", repo.baseSha, "--head", repo.headSha, "--format", "json", "--model", model]);
    if (res.exitCode !== 0) {
      throw new Error(`select-specs failed for case ${evalCase.name} (exit ${res.exitCode}):\n${res.stderr}`);
    }
    if (!res.stderr.includes(SELECTION_ABANDONED_MARKER)) {
      return scoreSelectCase(evalCase.expect.select ?? {}, parseSelectOutput(res.stdout));
    }
    if (attempt >= 2) {
      throw new CaseAbandonedError(
        `select-specs abandoned its selection for case ${evalCase.name} twice — the model never ` +
          `produced a usable answer, so there is nothing to score:\n${res.stderr.trim()}`,
      );
    }
  }
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
  // Abandoned cases are excluded from every number above, so their absence
  // must be said — a metric over fewer cases silently reads as a full run.
  const abandoned = summary.cases.filter((c) => c.abandoned);
  if (abandoned.length > 0) {
    console.log(`ABANDONED ${abandoned.length} case(s), excluded from the metrics: ${abandoned.map((c) => c.name).join(", ")}`);
    process.exitCode = 1;
  }
  if (meta.cost) {
    console.log(`cost ${formatUsd(meta.cost.totalUsd)} over ${meta.cost.invocations} invocation(s)`);
  }
  console.log(`model ${meta.model}`);
  console.log(`results: ${summary.resultPath}`);
}
