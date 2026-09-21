/**
 * What `ccqa audit` leaves behind for a machine.
 *
 * The audit has three audiences: the person reading the terminal, the hub's
 * ledger, and whatever repairs the test. This is the third, and it is one
 * payload — written to `<report-dir>/audit.json` by every completed sweep and
 * printed verbatim by `--report-format json` (ADR-0036).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { caseRefFor, getRecording, matchesGenerationStamp } from "../store/index.ts";
import { caseRecordingPath, caseTestPath, type SpecArtifactsContext } from "./artifacts.ts";
import { recordingNamesRenamed, type Rename } from "./renames.ts";
import { caseIdOf, type DriftDiagnosis, type SpecResult } from "./types.ts";

/** The file the report is written as, inside the report directory. */
export const AUDIT_REPORT_FILE = "audit.json";

/**
 * Why a sweep audited nothing. Carried in the payload because the four are not
 * interchangeable to a CI job: "every spec is current" is the happy path,
 * while "no specs found" usually means a wrong `--cwd` or a checkout without
 * the spec tree, and both looked identical before.
 */
export type NoSpecsReason = "noSpecsFound" | "allCurrent" | "allHeld" | "noDiffIntersection";

export interface AuditReport {
  specs: AuditReportRow[];
  /** Present only when the sweep audited nothing, saying which reason. */
  skipped?: NoSpecsReason;
}

/**
 * One audited case. `feature`, `spec`, `case`, `ok` and `drift` are on every
 * row; `error` only when the audit itself failed; `test`, `document` and
 * `repair` only when `drift` is not null, since they exist to repair it.
 */
export interface AuditReportRow {
  feature: string;
  spec: string;
  /** The id the rest of ccqa cites this case by. */
  case: string;
  ok: boolean;
  /** Only when the audit itself failed — a model error, an unreadable case. */
  error?: string;
  /** Null when the case still matches the code: an absence, not a verdict. */
  drift: DriftDiagnosis | null;
  /** The generated test the finding is about, project-relative. Null for a live case. */
  test?: string | null;
  /**
   * The document stating this case — the file `repair.rewrite` applies to.
   * Project-relative, or absolute when it lives outside the project. Null when
   * the case could not be read. A fix job cannot derive this: where a project
   * files its cases is answered by the reader module it owns.
   */
  document?: string | null;
  repair?: Repair;
}

/**
 * Which repair this case needs. Each value names the command that makes it,
 * and naming one is eligibility rather than a promise: what repairs a case is
 * that command plus the verification that follows, and the verification only
 * runs where the target has a `runCommand` and the fix pass was not skipped.
 * The conditions each value answers are in `docs/running.md` (ADR-0035).
 *
 * Only this routing reads the generation stamp — the verdict above it never
 * does, because who owns the test is not evidence about whether it still
 * matches the product.
 */
export interface Repair {
  route: "regenerate" | "rerecord" | "rewrite" | "external";
  reason: string;
  /**
   * Renamed strings to apply to `document`: every `from` occurs in that file.
   * They are a fact about the document rather than about the route, so a
   * `TEST_DRIFT` carries them even on `external`, where the person the case
   * was handed to is the one who can use them.
   *
   * Apply them as one simultaneous replacement, never a re-scan of text a
   * replacement wrote, and where one `from` contains another replace the
   * longer first. How to apply one is the consumer's (ADR-0035).
   */
  rewrite: Rename[];
}

/**
 * The payload, for both the file and `--report-format json`. Each row's reads
 * are independent, so they resolve together rather than one case at a time.
 */
export async function buildAuditReport(
  results: readonly SpecResult[],
  cwd: string,
  ctx: SpecArtifactsContext,
): Promise<AuditReport> {
  return { specs: await Promise.all(results.map((r) => buildRow(r, cwd, ctx))) };
}

/** Write the report as `<dirAbs>/audit.json`, creating the directory. Returns its path. */
export async function writeAuditReport(report: AuditReport, dirAbs: string): Promise<string> {
  await mkdir(dirAbs, { recursive: true });
  const path = join(dirAbs, AUDIT_REPORT_FILE);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

async function buildRow(
  result: SpecResult,
  cwd: string,
  ctx: SpecArtifactsContext,
): Promise<AuditReportRow> {
  const drift = result.drift;
  const row: AuditReportRow = {
    feature: result.target.featureName,
    spec: result.target.specName,
    case: caseIdOf(result.target),
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    drift,
  };
  // Only a finding has a repair, and working one out costs a test-path
  // resolution and a recording read per case.
  if (drift === null) return row;

  const test = result.live ? null : await caseTestPath(result.target, ctx);
  // Independent of the route: editing the document rebuilds nothing and
  // discards nobody's test, so a finding handed to a person carries the pairs
  // too. Only a rename is repaired by a string swap, so no other label does.
  const rewrite: Rename[] =
    drift.label === "TEST_DRIFT"
      ? (result.renames ?? []).filter((r) => r.inDocument).map(({ from, to }) => ({ from, to }))
      : [];
  return {
    ...row,
    test,
    document: documentOf(result, cwd),
    repair: await buildRepair(result, test, rewrite, cwd, ctx),
  };
}

/**
 * The case's document as something that can be opened from anywhere. A case
 * filed outside the project relativizes to `../…`, which resolves against
 * whatever directory the fix job happens to be in rather than this one.
 */
function documentOf(result: SpecResult, cwd: string): string | null {
  const rel = result.documentPath;
  if (rel === undefined) return null;
  return rel.startsWith("..") ? resolve(cwd, rel) : rel;
}

async function buildRepair(
  result: SpecResult,
  test: string | null,
  rewrite: Rename[],
  cwd: string,
  ctx: SpecArtifactsContext,
): Promise<Repair> {
  const drift = result.drift!;
  const renames = result.renames ?? [];
  const external = (reason: string): Repair => ({ route: "external", reason, rewrite });

  if (drift.label !== "TEST_DRIFT") {
    return external(
      `${drift.label} names no repair a machine can make: recompiling or re-recording ` +
        `reproduces the case as it stands`,
    );
  }
  // A live case has no compiled code, so no stamp gates it: there is no
  // generated test whose hand edits a repair could lose.
  if (result.live) {
    return rewrite.length === 0
      ? external(
          "a live case is repaired by rewriting its document, and nothing the audit named is in it",
        )
      : {
          route: "rewrite",
          reason:
            "a live case runs its document, so rewriting it is the whole repair — apply " +
            "'rewrite' to 'document', then run the case to verify.",
          rewrite,
        };
  }
  // Not the same as live, and saying so would misreport an unreadable case as
  // one somebody chose to drive by hand.
  if (test === null) {
    return external("this case resolves to no generated test: there is nothing to regenerate");
  }
  const testAbs = resolve(cwd, test);
  const ref = caseRefFor(
    result.target.caseId ??
      { featureName: result.target.featureName, specName: result.target.specName },
    cwd,
    (await caseRecordingPath(result.target, ctx)) ?? undefined,
  );
  const recording = await getRecording(ref).catch(() => null);
  if (!recording?.generated) {
    return external("no generation stamp: ccqa did not write this test, or it predates the stamp");
  }
  if (!(await matchesGenerationStamp(recording.generated, testAbs))) {
    return external("the test has been edited since it was generated");
  }

  const apply = (why: string) =>
    rewrite.length > 0 ? ` Apply 'rewrite' to 'document' first: ${why}.` : "";
  if (recordingNamesRenamed(recording, renames)) {
    const why = "a re-recording drives the case as its document states it";
    return {
      route: "rerecord",
      reason:
        "the saved recording names a renamed string, so a regeneration would compile " +
        `it back in — re-record and verify.${apply(why)}`,
      rewrite,
    };
  }
  // A `from` the document holds is the evidence available that the document
  // states the renamed string, which is what the surface axis was being asked
  // — so it outranks the model's answer there.
  if (drift.surface !== "generated" && rewrite.length === 0) {
    return external(
      "the finding is not on the generated test, and nothing it named is in the " +
        "document — it is on a file the test imports, which a regeneration only " +
        "reads, or no replacement was named",
    );
  }
  return {
    route: "regenerate",
    reason:
      "test drift, and the saved recording names no renamed string — regenerate and " +
      `verify.${apply("regenerating alone recompiles the same document")}`,
    rewrite,
  };
}
