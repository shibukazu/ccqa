import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getRecording,
  intentCase,
  matchesGenerationStamp,
  specCase,
  type CaseRef,
} from "../store/index.ts";
import {
  caseTestPath,
  loadSpecArtifactsContext,
  type SpecArtifactsContext,
} from "./artifacts.ts";
import { caseIdOf, type SpecResult, type SpecTarget } from "./types.ts";

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
  repair: Repair;
}

/**
 * Where the repair belongs — the one question a fix job asks: may I regenerate
 * this test?
 *
 * `regenerate` is the narrow answer, and it takes two things. The finding has
 * to be one a regeneration could actually fix: only `TEST_DRIFT` on the
 * `generated` surface is, since that is the surface a regeneration rewrites.
 * A stale document, a changed behaviour, a suspected product bug — a
 * regeneration reproduces each of those faithfully from the same stale input.
 * And ccqa has to have written the test, with nobody having touched it since;
 * otherwise regenerating throws someone's work away.
 *
 * Everything else is `external`: hand it to whoever owns the file, with the
 * reason saying which of the two conditions failed. Only this routing reads
 * the generation stamp — the verdict above it never does, because who owns
 * the test is not evidence about whether it still matches the product.
 */
export interface Repair {
  route: "regenerate" | "external";
  reason: string;
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
  const test = result.live ? null : await caseTestPath(result.target, cwd, ctx);
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
    repair: await repairRoute(result, test, cwd),
  };
}

function refOf(target: SpecTarget, cwd: string): CaseRef {
  return target.caseId !== undefined
    ? intentCase(target.caseId, cwd)
    : specCase(target.featureName, target.specName, cwd);
}

async function repairRoute(
  result: SpecResult,
  test: string | null,
  cwd: string,
): Promise<Repair> {
  const drift = result.drift!;
  if (result.live || test === null) {
    return { route: "external", reason: "this case runs live: the document is the test" };
  }
  if (drift.label !== "TEST_DRIFT") {
    return {
      route: "external",
      reason: `${drift.label} is not repaired by regenerating: the same document would compile to the same test`,
    };
  }
  if (drift.surface !== "generated") {
    return {
      route: "external",
      reason: "the finding is on the document, which a regeneration reads rather than rewrites",
    };
  }
  const recording = await getRecording(refOf(result.target, cwd)).catch(() => null);
  const stamp = recording?.generated;
  if (!stamp) {
    return {
      route: "external",
      reason: "no generation stamp: ccqa did not write this test, or it predates the stamp",
    };
  }
  if (!(await matchesGenerationStamp(stamp, resolve(cwd, test)))) {
    return { route: "external", reason: "the test has been edited since it was generated" };
  }
  return {
    route: "regenerate",
    reason: `test drift in generated code, unchanged since ccqa generated it on ${stamp.at}`,
  };
}
