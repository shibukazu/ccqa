import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { analyzeFailure } from "../report/analyze.ts";
import type { ReportSpecResult } from "../report/schema.ts";
import { type AnalysisCustomPrompt, resolveCustomPromptForTarget } from "../prompts/custom-prompt.ts";
import { buildProseEnvScrubMap } from "../runtime/env-scrub.ts";
import { expandSpec } from "../spec/expand.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import { AGENT_BROWSER_TARGET, type BlockSpec } from "../spec/yaml-schema.ts";
import { loadAllBlocks, type AvailableBlock, type SpecRef } from "../store/index.ts";
import { specArtifactsDir } from "../targets/run-artifacts.ts";
import { loadGeneratedManifest } from "../targets/llm-engine.ts";
import { C } from "../cli/colors.ts";
import * as log from "../cli/logger.ts";
import type { DiffProvider } from "./diff-provider.ts";

/**
 * `ccqa run`'s failure-analysis phase, shared by the script-driven execution
 * paths: the built-in deterministic (vitest) path and external targets running
 * through their `runCommand`. Both hand the classifier the same evidence —
 * generated test source, failure log, spec.yaml and the spec-scoped source
 * diff — so report rows and CI logs look the same whichever target a
 * project's specs use.
 *
 * One Claude call per failing spec, which reads the source itself rather than
 * deferring to a drift audit run beforehand. It is still one *phase*:
 * `beginFailureAnalysis` hands back the state every path shares, so a mixed
 * run prints one `failure analysis` banner in one place rather than one per
 * execution path. It runs after every spec has executed, so no Claude turn is
 * spent on triage while tests are still running.
 *
 * The live path builds its evidence from a Claude transcript instead of a
 * script, so it keeps its own caller in `cli/run-live.ts`; only the
 * `ANALYSIS_DISABLED` string is shared with it.
 */

/** `analysisSkipped` for a failed row when `--on-fail-explain` was not requested. */
export const ANALYSIS_DISABLED = "skipped: --on-fail-explain not enabled";

/** Result of `driftAuthAvailable()`, probed once per run by the pipeline. */
export type ClaudeAuth = { ok: true } | { ok: false; reason: string };

/** What an analysis pass needs that does not vary spec to spec. */
export interface FailureAnalysisDeps {
  /**
   * Per-spec source-diff resolver, present exactly when `--on-fail-explain`
   * was requested. Null turns the classification off entirely.
   */
  diffProvider: DiffProvider | null;
  auth: ClaudeAuth;
  cwd: string;
  /** Absolute report directory — locates a spec's run artifacts for the prompt. */
  reportDir: string;
  /** Blocks under `.ccqa/blocks/`, so the prompt can check an `include:` step's target still exists. */
  blocks: AvailableBlock[];
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
  // Parsed blocks for the scrub map below, read at most once per pass.
  // `deps.blocks` won't do — it is the prompt's projection, with no step
  // bodies, and that is where a block's own `${VAR}` refs live.
  let parsedBlocks: Promise<Map<string, BlockSpec>> | null = null;

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
      if (!deps.auth.ok) return { ...fields, analysisSkipped: deps.auth.reason };
      if (input.specYaml === null) {
        return { ...fields, analysisSkipped: "no spec.yaml found for this spec" };
      }
      // No usable baseline for THIS spec (last-green: never green yet, or its
      // commit isn't fetched) — still classify, from the failure evidence plus
      // current-repository inspection; the prompt switches to its no-baseline
      // guidance and the row carries no analysisBase.
      const baselineMissing = specDiffResult.ok ? null : specDiffResult.skip;

      log.info(
        `failure analysis: ${featureName}/${specName}${baselineMissing ? " (no baseline — classifying from current source)" : ""}`,
      );
      // A block that no longer parses costs the scrub map, not the classification.
      parsedBlocks ??= loadAllBlocks(deps.cwd).catch(() => new Map<string, BlockSpec>());
      const envScrubMap = specEnvScrubMap(input.specYaml, await parsedBlocks);
      const outcome = await analyzeFailure(
        {
          script: await input.readScript(),
          // Both paths sharing this pass (det, external-target) always run
          // code `ccqa generate` produced; only `mode: live` (a different
          // caller, cli/run-live.ts) has no generated surface.
          hasGeneratedSurface: true,
          blocks: deps.blocks,
          specYaml: input.specYaml,
          failureLog: input.failureLog,
          diffPatch: specDiff?.patch ?? null,
          changedFiles: specDiff?.nameStatus ?? null,
          baseRef: specDiff?.base.ref ?? null,
          baseSource: specDiff?.base.source ?? null,
          range: specDiff?.range ?? null,
          ...(baselineMissing ? { baselineMissing } : {}),
          ...(input.artifactsDir ? { artifactsDir: input.artifactsDir } : {}),
          ...(deps.language ? { outputLanguage: deps.language } : {}),
          ...(deps.triageUserPrompt ? { triageUserPrompt: deps.triageUserPrompt } : {}),
          ...(customPrompt ? { customPrompt } : {}),
        },
        {
          ...(deps.model ? { model: deps.model } : {}),
          cwd: deps.cwd,
          getFileDiff: specDiff?.fileDiff ?? (() => null),
          envScrubMap,
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

/**
 * The `${VAR}` values this spec resolved, for masking them out of the
 * classifier's prose. Read from `process.env` here rather than at run start
 * (where the live path builds its own): a profile is applied once per
 * invocation, so this is still what the spec ran against.
 */
function specEnvScrubMap(
  specYaml: string,
  blocks: Map<string, BlockSpec>,
): Array<[string, string]> {
  const spec = tryParseTestSpec(specYaml);
  if (spec === null) return [];
  try {
    return buildProseEnvScrubMap(spec, expandSpec(spec, { blocks }));
  } catch {
    // An include that no longer resolves costs the refs inside that block's
    // steps; the spec's own, include params included, still scrub.
    return buildProseEnvScrubMap(spec, []);
  }
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

/** Run-level state every path of one run's analysis phase shares. */
export interface FailureAnalysisRun {
  deps: FailureAnalysisDeps;
  pass: FailureAnalysisPass;
}

/**
 * Open the run's single analysis phase over every spec that failed, whatever
 * executed it: one auth notice, and one `failure analysis` banner for the rows
 * that follow.
 */
export function beginFailureAnalysis(
  failedSpecs: readonly SpecRef[],
  deps: FailureAnalysisDeps,
): FailureAnalysisRun {
  if (deps.diffProvider !== null && !deps.auth.ok && failedSpecs.length > 0) {
    log.info(`failure analysis skipped (${deps.auth.reason})`);
  }
  return { deps, pass: createFailureAnalysisPass(deps) };
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
  const { deps, pass } = run;
  const out: ReportSpecResult[] = [];
  for (const row of rows) {
    if (!needsAnalysis(row)) {
      out.push(row);
      continue;
    }
    const ref: SpecRef = { featureName: row.feature, specName: row.spec };
    const fields = await pass.analyze({
      ...ref,
      readScript: () => readGeneratedTestSources(ref, deps.cwd),
      failureLog: row.failureLogExcerpt ?? "",
      specYaml: row.specYaml,
      target: row.target ?? AGENT_BROWSER_TARGET,
      artifactsDir: readableArtifactsDir(ref, deps),
    });
    // `fields` only carries customPromptVersion when an overlay was applied
    // (optional, never present-with-undefined), so the plain spread is enough —
    // same as analysisBase above.
    out.push({ ...row, ...fields });
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
