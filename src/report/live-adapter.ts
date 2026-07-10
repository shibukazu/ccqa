import { cp, mkdir } from "node:fs/promises";
import { basename, join, posix as posixPath, resolve } from "node:path";
import * as log from "../cli/logger.ts";
import { EVIDENCE_SUBDIR } from "../run/report-constants.ts";
import { toPosix } from "../run/pipeline.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import type { LiveRunResult } from "../runtime/live-executor.ts";
import type { LiveReportRun, LiveReportStep, ReportSpecResult } from "./schema.ts";

/**
 * Convert one live-mode (`mode: live`) execution result into the
 * persistence-layer `ReportSpecResult` shape written to report.json (and
 * rendered by the hub UI). The conversion does two non-trivial things:
 *
 *   - copies the executor's absolute `beforePng`/`afterPng` files into
 *     `<reportDir>/evidence/<feature>/<spec>/` and rewrites the fields as
 *     `reportDir`-relative posix hrefs, mirroring the deterministic
 *     (`ccqa run --drift-report`) evidence layout — so `reportDir` is
 *     self-contained and can be tar.gz'd on its own for a hub push, without
 *     also shipping the `.ccqa` runs dir
 *   - nulls out every vitest-only field so the result surfaces via its
 *     `liveRun` branch
 *
 * Lives in `src/report/` (not the CLI) because the relative-path contract
 * on `LiveReportStep.beforePng`/`afterPng` is a report-layer invariant,
 * documented next to the schema, and the CLI should not own it.
 */
export async function liveRunToReportResult(args: {
  featureName: string;
  specName: string;
  specYaml: string;
  result: LiveRunResult;
  reportDir: string;
}): Promise<ReportSpecResult> {
  const { featureName, specName, specYaml, result, reportDir } = args;
  // One evidence dir per spec: create it once up front rather than letting
  // every step's copy call `mkdir(..., { recursive: true })` redundantly.
  const evidenceDir = join(reportDir, EVIDENCE_SUBDIR, featureName, specName);
  await mkdir(evidenceDir, { recursive: true });
  const steps: LiveReportStep[] = await Promise.all(
    result.steps.map(async (s) => {
      const [beforePng, afterPng] = await Promise.all([
        copyEvidenceIntoReport(s.beforePng, evidenceDir, reportDir),
        copyEvidenceIntoReport(s.afterPng, evidenceDir, reportDir),
      ]);
      return {
        stepId: s.stepId,
        source: s.source,
        instruction: s.instruction,
        expected: s.expected,
        status: s.status,
        reasoning: s.reasoning,
        beforePng,
        afterPng,
        durationMs: s.durationMs,
        cost: { ...s.cost },
        commands: s.commands,
      };
    }),
  );
  const liveRun: LiveReportRun = {
    runId: result.runId,
    sessionName: result.sessionName,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    steps,
    cost: { ...result.cost },
  };
  return {
    feature: featureName,
    spec: specName,
    title: tryParseTestSpec(specYaml)?.title ?? null,
    status: result.status,
    testCounts: null,
    durationMs: result.durationMs,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    driftIssues: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml,
    evidence: null,
    liveRun,
  };
}

/**
 * Copy one evidence PNG into `evidenceDir` and return its path relative to
 * `reportDir` (posix, so it matches the deterministic path's
 * `ReportEvidenceSchema.pngPath` convention). Returns `null` (and logs a
 * warning) when the source is missing or the copy fails, rather than
 * surfacing a dangling absolute path in report.json. `evidenceDir` is created
 * by the caller once per spec, not per PNG.
 */
async function copyEvidenceIntoReport(
  absPath: string | null,
  evidenceDir: string,
  reportDir: string,
): Promise<string | null> {
  if (absPath === null) return null;
  const dest = join(evidenceDir, basename(absPath));
  try {
    await cp(absPath, dest);
    // posixPath.relative already returns a `/`-separated path, so no outer toPosix.
    return posixPath.relative(toPosix(resolve(reportDir)), toPosix(dest));
  } catch (err) {
    log.warn(`failed to copy live evidence ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
