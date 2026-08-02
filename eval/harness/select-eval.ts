import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCostFileTotal } from "../../src/cli/cost-line.ts";
import { filterCases, type AuditEvalOptions } from "./audit-eval.ts";
import { listFixtureSpecKeys, loadCases } from "./cases.ts";
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
  computeSelectMetrics,
  parseSelectOutput,
  scoreSelectCase,
  type SelectMetrics,
  type SelectSpecOutcome,
} from "./score-select.ts";

export type SelectEvalOptions = AuditEvalOptions;

export interface SelectCaseResult {
  name: string;
  title: string;
  outcomes: SelectSpecOutcome[];
}

export interface SelectEvalSummary {
  meta: ResultMeta;
  cases: SelectCaseResult[];
  metrics: SelectMetrics;
  resultPath: string;
}

/**
 * Run `ccqa select-specs` between each case's two commits and score the
 * verdicts against the case's expected spec set.
 */
export async function runSelectEval(opts: SelectEvalOptions = {}): Promise<SelectEvalSummary> {
  const model = opts.model ?? "haiku";
  const appDir = opts.appDir ?? DEFAULT_APP_DIR;
  const casesDir = opts.casesDir ?? DEFAULT_CASES_DIR;
  const resultsDir = opts.resultsDir ?? DEFAULT_RESULTS_DIR;

  const specKeys = await listFixtureSpecKeys(appDir);
  if (specKeys.length === 0) throw new Error(`no specs found under ${join(appDir, ".ccqa")}`);
  const cases = filterCases(await loadCases(casesDir, specKeys), "select", opts.filter);

  const say = (line: string) => {
    if (!opts.quiet) console.log(line);
  };
  const startedAt = new Date().toISOString();
  const costDir = await mkdtemp(join(tmpdir(), "ccqa-eval-cost-"));
  const costFile = join(costDir, "cost.jsonl");
  try {
    const results: SelectCaseResult[] = [];
    for (const evalCase of cases) {
      say(`case ${evalCase.name} — ${evalCase.title}`);
      const repo = await buildCaseRepo(appDir, evalCase.mutations);
      try {
        const res = await runCcqa(
          ["select-specs", "--base", repo.baseSha, "--head", repo.headSha, "--format", "json", "--model", model],
          { cwd: repo.dir, env: { CCQA_COST_FILE: costFile, ...opts.env } },
        );
        if (res.exitCode !== 0) {
          throw new Error(`select-specs failed for case ${evalCase.name} (exit ${res.exitCode}):\n${res.stderr}`);
        }
        results.push({
          name: evalCase.name,
          title: evalCase.title,
          outcomes: scoreSelectCase(evalCase.expect.select ?? {}, parseSelectOutput(res.stdout)),
        });
      } finally {
        await repo.cleanup();
      }
    }

    const metrics = computeSelectMetrics(results.flatMap((r) => r.outcomes));
    const meta: ResultMeta = {
      kind: "select",
      startedAt,
      model,
      // The selection prompt declares no version constant, so there is
      // nothing honest to record here.
      promptVersion: null,
      cost: await readCostFileTotal(costFile),
    };
    const resultPath = await writeResultFile(resultsDir, meta, { cases: results, metrics });
    if (!opts.quiet) printSelectSummary({ meta, cases: results, metrics, resultPath });
    return { meta, cases: results, metrics, resultPath };
  } finally {
    await rm(costDir, { recursive: true, force: true });
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
  if (meta.cost) {
    console.log(`cost ${formatUsd(meta.cost.totalUsd)} over ${meta.cost.invocations} invocation(s)`);
  }
  console.log(`model ${meta.model}`);
  console.log(`results: ${summary.resultPath}`);
}
