import { resolve } from "node:path";

import type { TestCase } from "../intent/case.ts";
import {
  collectIncludedBlockNames,
  requireActionSteps,
  type ExpandedActionStep,
} from "../spec/expand.ts";
import { AGENT_BROWSER_TARGET } from "../spec/yaml-schema.ts";
import { buildProseEnvScrubMap } from "../runtime/env-scrub.ts";
import { splitCaseId, type CaseRef } from "../store/index.ts";
import { AGENT_BROWSER_JUDGE_STEPS } from "../targets/agent-browser/judge-steps.ts";

/** What a case starts signed in as. Both halves may be present; they merge. */
export interface LiveSession {
  /** Hub session names the case declared (`spec.session`), restored in order. */
  names: readonly string[];
  /** Absolute path of the project's saved browser state (config `sessionState`). */
  savedStatePath?: string;
}

/**
 * One test case as the live runner needs it, whichever document stated it.
 *
 * `runLiveSpecs` used to take a `SpecRef` and re-read `spec.yaml` itself,
 * which is why nothing but a `spec.yaml` case could run live. What it needs is
 * this much: where to put the run, what to drive, what the document said, and
 * what to sign in as. `liveCaseFrom` reads both kinds into it once, so nothing
 * below this asks which kind it came from.
 */
export interface LiveCase {
  /** The case's own directory; the run lands in `<dir>/runs/<runId>`. */
  ref: CaseRef;
  /** How a report row and the hub still spell a case — `splitCaseId` of its id. */
  featureName: string;
  specName: string;
  title: string;
  /** Everything to drive, in order: the case's steps, then its cleanup. */
  steps: ExpandedActionStep[];
  /**
   * Where cleanup begins in `steps`. The runner needs the boundary because
   * those steps run even after a failure — which is the run that most needs
   * them — while the case's own steps stop at the first one that fails.
   */
  cleanupFrom: number;
  /**
   * The document verbatim. It lands in the report row and in the failure
   * classifier's prompt, both of which want what a person wrote rather than a
   * re-serialization of what ccqa parsed.
   */
  document: string;
  /** Blocks an `include:` pulled in, for the run log. Empty for a document with none. */
  blocks: string[];
  session: LiveSession;
  /**
   * `[value, "${VAR}"]` pairs for every ref the document makes. A function
   * because `CCQA_RUN_ID` is only known once the run id is drawn, and a map
   * built against the parent's value would leave the child's baked into the
   * transcript.
   */
  envScrubMap(overrides: Record<string, string>): Array<[string, string]>;
}

export interface LiveCaseOptions {
  /** Project root a relative `sessionState` is resolved against. */
  cwd?: string;
  /**
   * The project's saved browser state (config `sessionState`). A case that
   * names hub sessions of its own gets both, that case's winning on collision.
   */
  sessionState?: string;
}

/**
 * Whether ccqa drives this case itself. A case that does not say `live` is
 * not a case ccqa runs some other way: for a markdown case, its test is the
 * project's own file, executed by the project's own command. Which is why the
 * default matters — a document with no mode section states nothing, and
 * nothing must not be read as "have a model drive my product".
 */
export function runsLive(testCase: TestCase): boolean {
  return testCase.mode === "live";
}

export function liveCaseFrom(testCase: TestCase, opts: LiveCaseOptions = {}): LiveCase {
  const spec = testCase.source.kind === "spec" ? testCase.source.spec : null;
  // Cleanup runs in the same session, right after the steps, and stays a step
  // of its own: a cleanup that fails has to show up as a failed step rather
  // than as work nobody recorded.
  const own = attachCaseExpectations(
    requireActionSteps(testCase.steps, testCase.ref.id, {
      id: AGENT_BROWSER_TARGET,
      reason: AGENT_BROWSER_JUDGE_STEPS.reason,
    }),
    testCase.expectations,
  );
  const steps = [...own, ...testCase.cleanup];
  return {
    ref: testCase.ref,
    ...splitCaseId(testCase.ref.id),
    title: testCase.title,
    steps,
    cleanupFrom: own.length,
    document: testCase.source.kind === "spec" ? testCase.source.yaml : testCase.source.text,
    blocks: spec ? collectIncludedBlockNames(spec) : [],
    session: {
      names: spec?.session ?? [],
      ...(opts.sessionState
        ? { savedStatePath: resolve(opts.cwd ?? process.cwd(), opts.sessionState) }
        : {}),
    },
    // An include's `params:` may name refs no expanded step repeats, so the
    // document's own steps are walked alongside the expanded ones.
    envScrubMap: (overrides) => buildProseEnvScrubMap(spec?.steps ?? [], steps, overrides),
  };
}

/**
 * Case-level expectations, attached to the last step that is not cleanup.
 *
 * A `spec.yaml` step carries its own `expected`; a markdown case states what
 * must be true once the flow is done and leaves every step's `expected` empty.
 * The live judge decides each step from its `expected` text alone, so left
 * unattached these would never be judged at all — the run would drive the
 * browser and verify nothing.
 *
 * The last non-cleanup step is where they go because that is where the flow is
 * finished, and live has no recording pass in which a model could place them
 * per step. A step that states its own `expected` keeps it: the document was
 * specific there, and appending would judge that step against the whole case.
 */
function attachCaseExpectations(
  steps: readonly ExpandedActionStep[],
  expectations: readonly string[],
): ExpandedActionStep[] {
  if (expectations.length === 0) return [...steps];
  const last = steps.length - 1;
  return steps.map((step, i) =>
    i === last && step.expected.trim() === ""
      ? { ...step, expected: expectations.join("\n") }
      : step,
  );
}
