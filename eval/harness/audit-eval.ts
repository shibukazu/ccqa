import { ZodError } from "zod";
import { DRIFT_PROMPT_VERSION } from "../../src/prompts/drift.ts";
import { CaseAbandonedError, runEval, type CaseContext, type EvalCaseResult, type EvalOptions } from "./eval-runner.ts";
import { formatUsd, renderTable, type ResultMeta } from "./results.ts";
import {
  buildConfusionMatrix,
  EXPECTED_LABELS,
  parseAuditOutput,
  PREDICTED_LABELS,
  scoreAuditCase,
  type AuditSpecOutcome,
  type ConfusionMatrix,
} from "./score-audit.ts";

export interface AuditEvalSummary {
  meta: ResultMeta;
  cases: EvalCaseResult<AuditSpecOutcome>[];
  confusion: ConfusionMatrix;
  resultPath: string;
}

/**
 * Run `ccqa audit` over each case's mutated checkout and score the verdicts.
 */
export async function runAuditEval(opts: EvalOptions = {}): Promise<AuditEvalSummary> {
  const { meta, cases, aggregate, resultPath } = await runEval(
    {
      kind: "audit",
      promptVersion: DRIFT_PROMPT_VERSION,
      runCase: runAuditCase,
      aggregate: buildConfusionMatrix,
      aggregateKey: "confusion",
      printSummary: (s) =>
        printAuditSummary({ meta: s.meta, cases: s.cases, confusion: s.aggregate, resultPath: s.resultPath }),
    },
    opts,
  );
  return { meta, cases, confusion: aggregate, resultPath };
}

async function runAuditCase({ evalCase, model, ccqa }: CaseContext): Promise<AuditSpecOutcome[]> {
  // Unparsable output gets one more attempt, then abandons the case instead
  // of killing the whole paid run — same posture as the select eval.
  let parseFailure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Concurrency matches how the audit runs in CI; serial sweeps of the
    // layered fixture run past the child-process timeout.
    const res = await ccqa(["audit", "--report-format", "json", "--model", model, "--concurrency", "4"]);
    // Exit 1 is the audit reporting drift — the expected outcome for most
    // cases here. Anything past that is the command itself failing.
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`audit failed for case ${evalCase.name} (exit ${res.exitCode}):\n${res.stderr}`);
    }
    let output;
    try {
      output = parseAuditOutput(res.stdout);
    } catch (err) {
      if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
      parseFailure = err;
      continue;
    }
    if (output.specs.length === 0) {
      throw new Error(`audit swept no specs for case ${evalCase.name} (skipped: ${output.skipped ?? "unknown"})`);
    }
    return scoreAuditCase(evalCase.expect.audit ?? {}, output);
  }
  throw new CaseAbandonedError(
    `audit output unparsable for case ${evalCase.name} after 2 attempts: ${String(parseFailure)}`,
  );
}

function printAuditSummary(summary: AuditEvalSummary): void {
  const { confusion, meta } = summary;
  console.log("");
  console.log(
    renderTable([
      ["expected \\ predicted", ...PREDICTED_LABELS],
      ...EXPECTED_LABELS.map((e) => [e, ...PREDICTED_LABELS.map((p) => String(confusion.matrix[e][p]))]),
    ]),
  );
  console.log("");
  for (const caseResult of summary.cases) {
    for (const outcome of caseResult.outcomes) {
      if (outcome.labelMatch) continue;
      const headline = outcome.headline ? ` — ${outcome.headline}` : "";
      console.log(`MISS ${caseResult.name} ${outcome.spec}: expected ${outcome.expected}, got ${outcome.predicted}${headline}`);
    }
  }
  const pct = (confusion.accuracy * 100).toFixed(1);
  const { cleanRecall, driftRecall } = confusion;
  console.log(
    `labels ${confusion.correct}/${confusion.total} correct (${pct}%) — ` +
      `CLEAN recall ${cleanRecall.correct}/${cleanRecall.total}, drift recall ${driftRecall.correct}/${driftRecall.total}`,
  );
  // Abandoned cases are excluded from every number above, so their absence
  // must be said — a metric over fewer cases silently reads as a full run.
  const abandoned = summary.cases.filter((c) => c.abandoned);
  if (abandoned.length > 0) {
    console.log(`ABANDONED ${abandoned.length} case(s), excluded from the metrics: ${abandoned.map((c) => c.name).join(", ")}`);
    process.exitCode = 1;
  }
  if (confusion.subAnswers.total > 0) {
    console.log(`sub-answers ${confusion.subAnswers.correct}/${confusion.subAnswers.total} correct (among label-correct predictions)`);
  }
  if (meta.cost) {
    console.log(`cost ${formatUsd(meta.cost.totalUsd)} over ${meta.cost.invocations} invocation(s)`);
  }
  console.log(`prompt v${meta.promptVersion} · model ${meta.model}`);
  console.log(`results: ${summary.resultPath}`);
}
