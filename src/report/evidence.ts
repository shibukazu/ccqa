import { readdir, readFile } from "node:fs/promises";
import { join, posix as posixPath, resolve } from "node:path";

import { FAILURE_STEP_ID } from "../runtime/evidence-constants.ts";
import { expandSpec } from "../spec/expand.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import { EVIDENCE_SUBDIR } from "../run/report-constants.ts";
import type { BlockSpec } from "../types.ts";
import { ReportEvidenceSchema, type ReportEvidence } from "./schema.ts";

/**
 * Step-boundary screenshot evidence: where it lives on disk and how a
 * directory of `<id>.png` + `<id>.json` pairs becomes report rows.
 *
 * Producer-agnostic on purpose. Two very different writers fill these
 * directories — `abStepEvidence()` for agent-browser replays and
 * `ccqa/step-evidence` for external targets' generated tests — and both only
 * have to agree on the file-pair convention documented here, not on how the
 * screenshot was taken.
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
  metas.sort((a, b) => {
    // Failure capture sinks to the end so per-step screenshots stay chronological.
    if (a.stepId === FAILURE_STEP_ID) return 1;
    if (b.stepId === FAILURE_STEP_ID) return -1;
    return a.stepId.localeCompare(b.stepId);
  });
  return metas.length > 0 ? metas : null;
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
  // Producers that shoot both step boundaries (ccqa/step-evidence) name the
  // entry shot here; the single-shot producers omit it.
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
 * Build `step id → expected` so the report can caption each evidence
 * screenshot. Returns an empty map on expansion failure (evidence still
 * surfaces, just without captions).
 */
export function buildStepDescriptions(
  spec: TestSpec | null,
  blocks: Map<string, BlockSpec>,
): Map<string, string> {
  if (!spec) return new Map();
  try {
    const expanded = expandSpec(spec, { blocks });
    return new Map(expanded.map((s) => [s.id, s.expected.trim()]));
  } catch {
    return new Map();
  }
}

export function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}
