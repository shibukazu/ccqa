import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { caseRefFor, getRecording, matchesGenerationStamp } from "../store/index.ts";
import {
  caseRecordingPath,
  caseTestPath,
  loadSpecArtifactsContext,
  type SpecArtifactsContext,
} from "./artifacts.ts";
import { recordingNamesRenamed, type Rename } from "./renames.ts";
import { caseIdOf, type SpecResult } from "./types.ts";

/**
 * One finding, in the shape something other than a human reads it.
 *
 * `ccqa audit` already prints its findings for a person and pushes them to the
 * hub for a ledger. This is the third audience: whatever fixes the test. It
 * gets the verdict, the citations the audit earned, and — the part it cannot
 * work out for itself — which repair path this case is on.
 */
export interface AuditBrief {
  /** The id the rest of ccqa cites this case by. */
  case: string;
  /** The finding's type, in the same vocabulary a failed run is triaged with. */
  kind: string;
  surface: string;
  confidence: number;
  headline: string;
  recommendation: string;
  reasoning: string;
  /** `file:line` citations backing the finding, product source included. */
  /**
   * The finding's citations, each carrying what opening the cited line found
   * (`citation`). A fix job reads a `corrected` line number as ccqa's and an
   * `unverified` one as a place the quoted string was not.
   */
  evidence: Array<{ file?: string; detail: string; citation?: string }>;
  /** The generated test this finding is about, project-relative. Null for a live case. */
  test: string | null;
  /**
   * The document stating this case — the file `repair.rewrite` applies to.
   * Project-relative, or absolute when it lives outside the project. Null when
   * the case could not be read. A fix job cannot derive this: where a project
   * files its cases is answered by the reader module it owns.
   */
  document: string | null;
  repair: Repair;
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

export interface WriteBriefsInput {
  results: readonly SpecResult[];
  cwd: string;
  /** Directory the briefs are written under; created if missing. */
  dir: string;
  /** The sweep's own config and aliases, so this does not re-read them. */
  context?: SpecArtifactsContext;
}

/**
 * Write one JSON file per finding, named by the case id below `dir`. Returns
 * the paths written, in the order the results came in.
 */
export async function writeAuditBriefs(input: WriteBriefsInput): Promise<string[]> {
  const findings = input.results.filter((r) => r.drift !== null);
  if (findings.length === 0) return [];

  const ctx = input.context ?? (await loadSpecArtifactsContext(input.cwd));
  const dirAbs = resolve(input.cwd, input.dir);
  // Each brief's reads are independent, and `map` keeps the results in the
  // order the findings came in without the writes having to be serial.
  return Promise.all(
    findings.map(async (result) => {
      const brief = await buildBrief(result, input.cwd, ctx);
      const path = join(dirAbs, `${brief.case}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(brief, null, 2)}\n`, "utf8");
      return path;
    }),
  );
}

async function buildBrief(
  result: SpecResult,
  cwd: string,
  ctx: SpecArtifactsContext,
): Promise<AuditBrief> {
  const drift = result.drift!;
  const id = caseIdOf(result.target);
  const test = result.live ? null : await caseTestPath(result.target, ctx);
  // Independent of the route: editing the document rebuilds nothing and
  // discards nobody's test, so a finding handed to a person carries the pairs
  // too. Only a rename is repaired by a string swap, so no other label does.
  const rewrite: Rename[] =
    drift.label === "TEST_DRIFT"
      ? (result.renames ?? []).filter((r) => r.inDocument).map(({ from, to }) => ({ from, to }))
      : [];
  return {
    case: id,
    kind: drift.label,
    surface: drift.surface,
    confidence: drift.confidence,
    headline: drift.headline,
    recommendation: drift.recommendation,
    reasoning: drift.reasoning,
    evidence: drift.evidence,
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
