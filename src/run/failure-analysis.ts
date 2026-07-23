import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { analyzeDrift } from "../drift/analyze.ts";
import { analyzeFailure } from "../report/analyze.ts";
import type { SpecResult } from "../drift/types.ts";
import type { ReportSpecResult } from "../report/schema.ts";
import { type AnalysisCustomPrompt, resolveCustomPromptForTarget } from "../prompts/custom-prompt.ts";
import { AGENT_BROWSER_TARGET } from "../spec/yaml-schema.ts";
import { loadAvailableBlocks, specKey, type SpecRef } from "../store/index.ts";
import { specArtifactsDir } from "../targets/run-artifacts.ts";
import { loadGeneratedManifest } from "../targets/llm-engine.ts";
import type { DraftIssue } from "../types.ts";
import { C } from "../cli/colors.ts";
import * as log from "../cli/logger.ts";
import type { DiffProvider } from "./diff-provider.ts";

/**
 * `ccqa run`'s failure-analysis phase, shared by the script-driven execution
 * paths: the built-in deterministic (vitest) path and external targets running
 * through their `runCommand`. Both hand the classifier the same evidence —
 * generated test source, failure log, spec.yaml, the spec-scoped source diff,
 * and the drift audit — so report rows and CI logs look the same whichever
 * target a project's specs use.
 *
 * It is one *phase*, not one call per path: `beginFailureAnalysis` runs the
 * audit for every failing spec of the run at once and hands back the shared
 * state, so a mixed run prints one `failure analysis` banner in one place
 * rather than one per execution path. It runs after every spec has executed,
 * so no Claude turn is spent on triage while tests are still running.
 *
 * The live path builds its evidence from a Claude transcript instead of a
 * script, so it keeps its own caller in `cli/run-live.ts`; only the
 * `ANALYSIS_DISABLED` string is shared with it.
 */

/** `analysisSkipped` for a failed row when `--failure-analysis` was not requested. */
export const ANALYSIS_DISABLED = "skipped: --failure-analysis not enabled";

/** Result of `driftAuthAvailable()`, probed once per run by the pipeline. */
export type ClaudeAuth = { ok: true } | { ok: false; reason: string };

/** What an analysis pass needs that does not vary spec to spec. */
export interface FailureAnalysisDeps {
  /**
   * Per-spec source-diff resolver, present exactly when `--failure-analysis`
   * was requested. Null disables both the classification and the drift audit —
   * they are one unit, since the audit's findings feed the classifier prompt.
   */
  diffProvider: DiffProvider | null;
  auth: ClaudeAuth;
  cwd: string;
  /** Absolute report directory — locates a spec's run artifacts for the prompt. */
  reportDir: string;
  model?: string;
  language?: string;
  /**
   * The project's stored analysis custom prompt (may carry per-target overlays).
   * Resolved per spec by its target at analyze time — never injected whole — so
   * one target's calibration can't contaminate another's classification.
   */
  customPrompt: AnalysisCustomPrompt | null;
  triageUserPrompt: string | null;
}

/** One failing spec's evidence, as the classifier consumes it. */
export interface SpecFailureInput {
  featureName: string;
  specName: string;
  /**
   * Generated test source for the prompt's script block. A thunk because a
   * spec whose analysis is skipped must not pay for the file reads.
   */
  readScript: () => Promise<string>;
  failureLog: string;
  /** Null when the spec file is gone; the classification is then withheld. */
  specYaml: string | null;
  /** This spec's generation target — selects the custom-prompt overlay to apply. */
  target: string;
  driftIssues: DraftIssue[] | null;
  /**
   * cwd-relative directory holding this spec's run artifacts, when it has one
   * the classifier's read-only tools can reach. Named in the prompt so the
   * model can open the runner's own failure context (a trace, an
   * accessibility-tree dump) instead of working from the log tail alone.
   */
  artifactsDir?: string | null;
}

/** The analysis-related fields of one failed report row. */
export interface SpecFailureFields {
  analysis: ReportSpecResult["analysis"];
  analysisSkipped: string | null;
  diffExcerpt: string | null;
  analysisBase?: { ref: string; sha: string };
  /** The overlay version actually applied to this row; absent when none was injected. */
  customPromptVersion?: string;
}

export interface FailureAnalysisPass {
  analyze(input: SpecFailureInput): Promise<SpecFailureFields>;
}

/**
 * Create one analysis pass. The returned object is stateful on purpose: the
 * "source diff unavailable" notice and the summary block's header are printed
 * once per pass, not once per spec.
 */
export function createFailureAnalysisPass(deps: FailureAnalysisDeps): FailureAnalysisPass {
  let printedHeader = false;
  let warnedDiffUnavailable = false;

  return {
    async analyze(input) {
      const { featureName, specName } = input;
      const specDiffResult = deps.diffProvider
        ? await deps.diffProvider.forSpec({ featureName, specName })
        : null;
      const specDiff = specDiffResult?.ok ? specDiffResult : null;
      if (specDiff?.error && !warnedDiffUnavailable) {
        warnedDiffUnavailable = true;
        log.info(
          `failure analysis: source diff unavailable (${specDiff.error}) — analyzing without diff context`,
        );
      }
      // Pick the overlay for THIS spec's target (its byTarget entry, else the
      // un-scoped fallback). Resolved here, not once per run, so a mixed-target
      // run injects the right calibration per row.
      const customPrompt = resolveCustomPromptForTarget(deps.customPrompt, input.target);

      // The diff fields are recorded even when the classification below is
      // withheld: they are evidence a reviewer still wants on the row.
      const fields: SpecFailureFields = {
        analysis: null,
        analysisSkipped: null,
        diffExcerpt: specDiff?.patch ?? null,
        ...(specDiff ? { analysisBase: { ref: specDiff.base.ref, sha: specDiff.base.sha } } : {}),
      };

      if (!specDiffResult) return { ...fields, analysisSkipped: ANALYSIS_DISABLED };
      // No usable baseline for THIS spec (last-green: never green yet, or its
      // commit isn't fetched) — withhold the classification honestly.
      if (!specDiffResult.ok) return { ...fields, analysisSkipped: specDiffResult.skip };
      if (!deps.auth.ok) return { ...fields, analysisSkipped: deps.auth.reason };
      if (input.specYaml === null) {
        return { ...fields, analysisSkipped: "no spec.yaml found for this spec" };
      }

      log.info(`failure analysis: ${featureName}/${specName}`);
      const outcome = await analyzeFailure(
        {
          script: await input.readScript(),
          specYaml: input.specYaml,
          failureLog: input.failureLog,
          diffPatch: specDiffResult.patch,
          changedFiles: specDiffResult.nameStatus,
          baseRef: specDiffResult.base.ref,
          baseSource: specDiffResult.base.source,
          range: specDiffResult.range,
          driftIssues: input.driftIssues,
          ...(input.artifactsDir ? { artifactsDir: input.artifactsDir } : {}),
          ...(deps.language ? { outputLanguage: deps.language } : {}),
          ...(deps.triageUserPrompt ? { triageUserPrompt: deps.triageUserPrompt } : {}),
          ...(customPrompt ? { customPrompt } : {}),
        },
        {
          ...(deps.model ? { model: deps.model } : {}),
          cwd: deps.cwd,
          getFileDiff: specDiffResult.fileDiff,
        },
      );

      if (!printedHeader) {
        printedHeader = true;
        log.emitRaw(`\n${C.cyan}${C.bold}──────── failure analysis ────────${C.reset}\n`);
      }
      printAnalysis(featureName, specName, outcome.analysis);
      return {
        ...fields,
        analysis: outcome.analysis,
        ...(customPrompt ? { customPromptVersion: customPrompt.customPromptVersion } : {}),
      };
    },
  };
}

/** One classified spec's line in the failure-analysis block. */
function printAnalysis(
  featureName: string,
  specName: string,
  analysis: NonNullable<ReportSpecResult["analysis"]>,
): void {
  const pct = Math.round(analysis.confidence * 100);
  const oneLine = analysis.headline.trim() || (analysis.reasoning.split("\n")[0] ?? "").trim();
  log.emitRaw(
    `${C.red}✖${C.reset} ${C.bold}${featureName}/${specName}${C.reset} → ` +
      `${C.bold}${analysis.label}${C.reset} (${pct}%)` +
      `${oneLine ? ` ${C.dim}${oneLine}${C.reset}` : ""}\n`,
  );
  const recommendation = analysis.recommendation.trim();
  if (recommendation) log.emitRaw(`  ${C.dim}→ ${recommendation}${C.reset}\n`);
}

/**
 * Audit the failing specs against the current source, as evidence for their
 * classification. Returns `specKey → issues`, with null for a spec whose audit
 * errored so its row records "audit unavailable" rather than a false clean
 * bill. The audit is advisory: a failure warns and never aborts the run.
 *
 * Target-agnostic by construction — it compares `spec.yaml` against the
 * codebase (Read/Grep/Glob) and never looks at generated test code — so
 * external-target specs get the same evidence as agent-browser ones.
 *
 * Two deliberate differences from the earlier deterministic-only pass:
 * every failing spec is audited (it used to build its target list from the
 * feature tree, so a failed spec missing from that walk was silently skipped),
 * and `SpecTarget.relatedPaths` / `includedBlocks` are no longer populated.
 * The audit never reads those two fields — only `ccqa drift --changed` does,
 * to decide *which* specs to audit — so passing them here was inert. Don't
 * "restore" them.
 */
export async function runDriftAudit(
  specs: readonly SpecRef[],
  deps: FailureAnalysisDeps,
): Promise<Map<string, DraftIssue[] | null>> {
  const byKey = new Map<string, DraftIssue[] | null>();
  if (specs.length === 0 || deps.diffProvider === null || !deps.auth.ok) return byKey;

  let results: SpecResult[];
  try {
    results = await analyzeDrift({
      targets: specs.map((s) => ({ featureName: s.featureName, specName: s.specName })),
      cwd: deps.cwd,
      blocks: await loadAvailableBlocks(deps.cwd),
      concurrency: Math.min(3, specs.length),
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.language ? { language: deps.language } : {}),
      onSpecStart: (t) => log.info(`drift audit: ${t.featureName}/${t.specName}`),
    });
  } catch (err) {
    log.warn(`drift audit failed: ${err instanceof Error ? err.message : String(err)}`);
    return byKey;
  }

  for (const r of results) {
    if (!r.ok) log.warn(`drift audit failed for ${specKey(r.target)}: ${r.error ?? "no result"}`);
    byKey.set(specKey(r.target), r.ok ? r.issues : null);
  }
  return byKey;
}

/** Run-level state every path of one run's analysis phase shares. */
export interface FailureAnalysisRun {
  deps: FailureAnalysisDeps;
  pass: FailureAnalysisPass;
  driftByKey: Map<string, DraftIssue[] | null>;
}

/**
 * Open the run's single analysis phase over every spec that failed, whatever
 * executed it: one auth notice, one drift audit (batched across paths), and
 * one `failure analysis` banner for the rows that follow.
 */
export async function beginFailureAnalysis(
  failedSpecs: readonly SpecRef[],
  deps: FailureAnalysisDeps,
): Promise<FailureAnalysisRun> {
  if (deps.diffProvider !== null && !deps.auth.ok && failedSpecs.length > 0) {
    log.info(`failure analysis skipped (${deps.auth.reason})`);
  }
  return {
    deps,
    pass: createFailureAnalysisPass(deps),
    driftByKey: await runDriftAudit(failedSpecs, deps),
  };
}

/** True for a failed row the classifier should look at. See `analyzeExternalRows`. */
export function needsAnalysis(row: ReportSpecResult): boolean {
  return row.status === "failed" && row.analysisSkipped === null;
}

/**
 * Attach the analysis fields to the failed rows an external target's runner
 * produced; every other row passes through untouched.
 *
 * A failed row that already carries an `analysisSkipped` reason is one that
 * never executed a test — nothing was generated, the command could not be
 * spawned, the runner crashed. Classifying those would hand the model an empty
 * script and a log telling a human to run `ccqa generate`, and the label it
 * invents would land in the confusion matrix and the project's learned prompt.
 * The recorded reason is both accurate and cheaper.
 */
export async function analyzeExternalRows(
  rows: readonly ReportSpecResult[],
  run: FailureAnalysisRun,
): Promise<ReportSpecResult[]> {
  const { deps, pass, driftByKey } = run;
  const out: ReportSpecResult[] = [];
  for (const row of rows) {
    if (!needsAnalysis(row)) {
      out.push(row);
      continue;
    }
    const ref: SpecRef = { featureName: row.feature, specName: row.spec };
    const driftIssues = driftByKey.get(specKey(ref)) ?? null;
    const fields = await pass.analyze({
      ...ref,
      readScript: () => readGeneratedTestSources(ref, deps.cwd),
      failureLog: row.failureLogExcerpt ?? "",
      specYaml: row.specYaml,
      target: row.target ?? AGENT_BROWSER_TARGET,
      driftIssues,
      artifactsDir: readableArtifactsDir(ref, deps),
    });
    // `fields` only carries customPromptVersion when an overlay was applied
    // (optional, never present-with-undefined), so the plain spread is enough —
    // same as analysisBase above.
    out.push({ ...row, ...fields, driftIssues });
  }
  return out;
}

/**
 * The spec's artifacts directory as the classifier can reach it: relative to
 * `cwd`, since its Read/Grep/Glob tools are scoped there. Null when the report
 * directory sits outside `cwd` — the path would be unusable, so the prompt
 * says nothing rather than pointing at something the model cannot open.
 */
function readableArtifactsDir(ref: SpecRef, deps: FailureAnalysisDeps): string | null {
  const rel = relative(deps.cwd, specArtifactsDir(deps.reportDir, ref.featureName, ref.specName));
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

/**
 * Budget for the generated test sources inlined into one external-target
 * spec's prompt. A target may generate several test files; the classifier only
 * needs to see how the spec was compiled, and its read-only tools can open the
 * rest on demand.
 */
const GENERATED_SOURCE_CAP = 32 * 1024;

/**
 * The spec's generated test files (the manifest's `kind: "test"` entries),
 * concatenated and each preceded by its path so the model can tell them apart.
 * Best-effort: a missing manifest or an unreadable file just means less
 * context, never a failed analysis — the empty string simply omits the script
 * section from the prompt.
 */
async function readGeneratedTestSources(ref: SpecRef, cwd: string): Promise<string> {
  const manifest = await loadGeneratedManifest(ref, cwd);
  if (manifest === null) return "";

  const parts: string[] = [];
  let budget = GENERATED_SOURCE_CAP;
  for (const file of manifest.files) {
    if (file.kind !== "test") continue;
    if (budget <= 0) {
      parts.push(`// [truncated: further generated files omitted — Read them for their full state]`);
      break;
    }
    const body = await readFile(resolve(cwd, file.path), "utf8").catch(() => null);
    if (body === null) continue;
    const kept =
      body.length > budget
        ? `${body.slice(0, budget)}\n// [truncated — Read this file for its full state]`
        : body;
    budget -= Math.min(body.length, budget);
    parts.push(`// ${file.path}\n${kept}`);
  }
  return parts.join("\n\n");
}
