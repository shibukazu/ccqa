import { readdir, readFile } from "node:fs/promises";
import { join, posix as posixPath, resolve } from "node:path";

import { FAILURE_STEP_ID } from "../runtime/evidence-constants.ts";
import { isExpandedJudgeByLlmStep } from "../spec/expand.ts";
import type { TestCase } from "../cases/case.ts";
import { EVIDENCE_SUBDIR } from "../run/report-constants.ts";
import { ReportEvidenceSchema, type ReportEvidence } from "./schema.ts";

/**
 * Step-boundary screenshot evidence: where it lives on disk and how a
 * directory of `<id>.png` + `<id>.json` pairs becomes report rows.
 *
 * Producer-agnostic on purpose. Very different writers fill these directories
 * — `abStepEvidence()` during an agent-browser replay, and, for a Playwright
 * target, frames read back out of the run's trace once the command has exited
 * — and they only have to agree on the file-pair convention documented here,
 * not on how or when the screenshot was taken. `pngFile` names the image
 * whatever its format: a trace's screencast frames are JPEG.
 */

/** `<reportDir>/evidence/<feature>/<spec>` — one directory per spec. */
export function specEvidenceDir(reportDir: string, feature: string, spec: string): string {
  return join(reportDir, EVIDENCE_SUBDIR, feature, spec);
}

/**
 * Read a spec's evidence-meta files and rewrite the PNG references to posix
 * relpaths (relative to the report dir) that report.json carries and the hub
 * UI resolves. Missing/malformed files are silently dropped so an
 * evidence-capture failure doesn't surface as a different failure mode.
 * Returns null when the spec has no evidence directory at all.
 */
export async function loadEvidenceForSpec(
  evidenceDir: string | null,
  reportDir: string,
  descriptionByStepId: Map<string, string>,
): Promise<ReportEvidence[] | null> {
  if (!evidenceDir) return null;
  let entries: string[];
  try {
    entries = await readdir(evidenceDir);
  } catch {
    return null;
  }
  const reportRoot = resolve(reportDir);
  const jsonFiles = entries.filter((n) => n.endsWith(".json"));
  const metas = (
    await Promise.all(
      jsonFiles.map((name) =>
        readEvidenceMeta(join(evidenceDir, name), evidenceDir, reportRoot, descriptionByStepId),
      ),
    )
  ).filter((m): m is ReportEvidence => m !== null);
  // The order a case runs in: its steps, then its undo, then the capture taken
  // where it failed. Ids alone do not say that — `cleanup-01` sorts before
  // `step-01` — and a filmstrip that opens with the teardown reads as a case
  // that undid something before it did it.
  metas.sort((a, b) => phase(a.stepId) - phase(b.stepId) || a.stepId.localeCompare(b.stepId));
  return metas.length > 0 ? metas : null;
}

/** Steps, then cleanup, then the failure capture. */
function phase(stepId: string): number {
  if (stepId === FAILURE_STEP_ID) return 2;
  return stepId.startsWith("cleanup-") ? 1 : 0;
}

async function readEvidenceMeta(
  metaPath: string,
  evidenceDir: string,
  reportRoot: string,
  descriptionByStepId: Map<string, string>,
): Promise<ReportEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pngFile = (parsed as { pngFile?: unknown }).pngFile;
  if (typeof pngFile !== "string") return null;
  const relToReport = (file: string): string =>
    posixPath.relative(toPosix(reportRoot), toPosix(join(evidenceDir, file)));
  const pngPath = relToReport(pngFile);
  // Producers that have both step boundaries name the entry shot here; the
  // single-shot producers omit it.
  const beforePngFile = (parsed as { beforePngFile?: unknown }).beforePngFile;
  const beforePngPath = typeof beforePngFile === "string" ? relToReport(beforePngFile) : null;
  const stepId = (parsed as { stepId?: unknown }).stepId;
  const failureSummary = (parsed as { failureSummary?: unknown }).failureSummary;
  const hasFailure = typeof failureSummary === "string" && failureSummary.length > 0;
  // Description comes from spec.yaml's `expected`; failure detail lives in
  // `failureSummary` as its own field so the renderer can stack them.
  let description: string | null = null;
  if (typeof stepId === "string") {
    description = descriptionByStepId.get(stepId) ?? null;
  }
  // Fallback failure capture (legacy scripts without __setCurrentStep) has no
  // spec entry — surface failureSummary as description so it isn't blank.
  if (!description && hasFailure) description = failureSummary as string;
  const candidate = {
    ...(parsed as Record<string, unknown>),
    pngPath,
    beforePngPath,
    description,
    status: hasFailure ? "failed" : "passed",
    failureSummary: hasFailure ? failureSummary : null,
  };
  const result = ReportEvidenceSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Build `step id → caption` so the report can label each evidence screenshot.
 * Empty when the case could not be read — evidence still surfaces, just
 * without captions.
 *
 * What the step must make true, falling back to what it does. A case that
 * states its expectations once for the whole flow leaves every step's own
 * `expected` empty, and a filmstrip captioned with blanks says less than the
 * instructions the case's author wrote.
 *
 * Cleanup steps are captioned too: they have step ids of their own and leave
 * screenshots of their own, and an uncaptioned row reads as a step nobody
 * described rather than as the undo it is.
 */
export function stepCaptions(testCase: TestCase | null): Map<string, string> {
  if (!testCase) return new Map();
  return new Map(
    [...testCase.steps, ...testCase.cleanup].map((s) => {
      // A judge step's claim is what it asserts, so it is the evidence line too.
      if (isExpandedJudgeByLlmStep(s)) return [s.id, s.judgeByLlm.trim()];
      return [s.id, (s.expected.trim() || s.instruction).trim()];
    }),
  );
}

export function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}
