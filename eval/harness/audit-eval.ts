import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCostFileTotal } from "../../src/cli/cost-line.ts";
import { DRIFT_PROMPT_VERSION } from "../../src/prompts/drift.ts";
import { listFixtureSpecKeys, loadCases, type EvalCase } from "./cases.ts";
import { runCcqa } from "./ccqa-cli.ts";
import { buildCaseRepo } from "./fixture-repo.ts";
import {
  DEFAULT_APP_DIR,
  DEFAULT_CASES_DIR,
  DEFAULT_RESULTS_DIR,
  formatUsd,
  renderTable,
  writeResultFile,
  type ResultMeta,
} from "./results.ts";
import {
  buildConfusionMatrix,
  EXPECTED_LABELS,
  parseAuditOutput,
  PREDICTED_LABELS,
  scoreAuditCase,
  type AuditSpecOutcome,
  type ConfusionMatrix,
} from "./score-audit.ts";

export interface AuditEvalOptions {
  model?: string;
  /** Substring filter on case names. */
  filter?: string;
  appDir?: string;
  casesDir?: string;
  resultsDir?: string;
  /** Extra env for the ccqa subprocesses; the wiring test injects the Claude mock here. */
  env?: Record<string, string>;
  quiet?: boolean;
}

export interface AuditCaseResult {
  name: string;
  title: string;
  outcomes: AuditSpecOutcome[];
}

export interface AuditEvalSummary {
  meta: ResultMeta;
  cases: AuditCaseResult[];
  confusion: ConfusionMatrix;
  resultPath: string;
}

/** Keep the cases that answer for this eval, then apply the name filter. */
export function filterCases(cases: EvalCase[], kind: "audit" | "select", filter?: string): EvalCase[] {
  const withKind = cases.filter((c) => c.expect[kind] !== undefined);
  const filtered = filter ? withKind.filter((c) => c.name.includes(filter)) : withKind;
  if (filtered.length === 0) {
    throw new Error(filter ? `no ${kind} case matches "${filter}"` : `no ${kind} cases found`);
  }
  return filtered;
}

/**
 * Run `ccqa audit` over each case's mutated checkout and score the verdicts.
 * Cases run one at a time: the sweep already audits its specs concurrently,
 * and a serial outer loop keeps one case's failure attributable.
 */
export async function runAuditEval(opts: AuditEvalOptions = {}): Promise<AuditEvalSummary> {
  const model = opts.model ?? "haiku";
  const appDir = opts.appDir ?? DEFAULT_APP_DIR;
  const casesDir = opts.casesDir ?? DEFAULT_CASES_DIR;
  const resultsDir = opts.resultsDir ?? DEFAULT_RESULTS_DIR;

  const specKeys = await listFixtureSpecKeys(appDir);
  if (specKeys.length === 0) throw new Error(`no specs found under ${join(appDir, ".ccqa")}`);
  const cases = filterCases(await loadCases(casesDir, specKeys), "audit", opts.filter);

  const say = (line: string) => {
    if (!opts.quiet) console.log(line);
  };
  const startedAt = new Date().toISOString();
  const costDir = await mkdtemp(join(tmpdir(), "ccqa-eval-cost-"));
  const costFile = join(costDir, "cost.jsonl");
  try {
    const results: AuditCaseResult[] = [];
    for (const evalCase of cases) {
      say(`case ${evalCase.name} — ${evalCase.title}`);
      const repo = await buildCaseRepo(appDir, evalCase.mutations);
      try {
        const res = await runCcqa(["audit", "--report-format", "json", "--model", model], {
          cwd: repo.dir,
          env: { CCQA_COST_FILE: costFile, ...opts.env },
        });
        // Exit 1 is the audit reporting drift — the expected outcome for most
        // cases here. Anything past that is the command itself failing.
        if (res.exitCode !== 0 && res.exitCode !== 1) {
          throw new Error(`audit failed for case ${evalCase.name} (exit ${res.exitCode}):\n${res.stderr}`);
        }
        const output = parseAuditOutput(res.stdout);
        if (output.specs.length === 0) {
          throw new Error(`audit swept no specs for case ${evalCase.name} (skipped: ${output.skipped ?? "unknown"})`);
        }
        results.push({
          name: evalCase.name,
          title: evalCase.title,
          outcomes: scoreAuditCase(evalCase.expect.audit ?? {}, output),
        });
      } finally {
        await repo.cleanup();
      }
    }

    const confusion = buildConfusionMatrix(results.flatMap((r) => r.outcomes));
    const meta: ResultMeta = {
      kind: "audit",
      startedAt,
      model,
      promptVersion: DRIFT_PROMPT_VERSION,
      cost: await readCostFileTotal(costFile),
    };
    const resultPath = await writeResultFile(resultsDir, meta, { cases: results, confusion });
    if (!opts.quiet) printAuditSummary({ meta, cases: results, confusion, resultPath });
    return { meta, cases: results, confusion, resultPath };
  } finally {
    await rm(costDir, { recursive: true, force: true });
  }
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
  console.log(`labels ${confusion.correct}/${confusion.total} correct (${pct}%)`);
  if (confusion.subAnswers.total > 0) {
    console.log(`sub-answers ${confusion.subAnswers.correct}/${confusion.subAnswers.total} correct (among label-correct predictions)`);
  }
  if (meta.cost) {
    console.log(`cost ${formatUsd(meta.cost.totalUsd)} over ${meta.cost.invocations} invocation(s)`);
  }
  console.log(`prompt v${meta.promptVersion} · model ${meta.model}`);
  console.log(`results: ${summary.resultPath}`);
}
