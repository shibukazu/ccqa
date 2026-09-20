import { expandSpec } from "../spec/expand.ts";
import type { Case } from "./contract.ts";
import type { ExpandedActionStep, ExpandedStep } from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { DEFAULT_SPEC_MODE, isIncludeStep, type SpecMode, type TestSpec } from "../spec/yaml-schema.ts";
import { sourcedCase, specCase, specFilePath, type CaseRef } from "../store/index.ts";
import type { BlockSpec } from "../types.ts";

/**
 * One test case, whichever kind of document states it.
 *
 * ccqa's own `spec.yaml` and a case a project writes in its own format
 * describe the same thing in different vocabularies, and everything
 * downstream — the recorder, the emitters, the evidence table — wants that
 * thing, not the document. So every kind is read into this shape once, at the
 * edge, and nothing past `src/cases/` asks which kind it came from.
 *
 * The one place the kinds genuinely differ is expectations. A `spec.yaml` step
 * carries its own; a case written some other way lists them for the case and
 * leaves the reading of which step delivers which to whoever runs it. That
 * difference is kept rather than smoothed over: `expectations` is what the
 * recorder is asked to place.
 */
export interface TestCase {
  /** Where this case's own files live, and the id everything cites it by. */
  ref: CaseRef;
  title: string;
  /**
   * Whether the case is recorded and compiled into a test, or driven through
   * the browser agent on every run.
   */
  mode: SpecMode;
  /** What to do, in order, already expanded (blocks inlined for a spec). */
  steps: ExpandedStep[];
  /** What to undo afterwards; recorded after the steps, emitted into afterEach. */
  cleanup: ExpandedActionStep[];
  /** Expectations stated for the case as a whole, unattached to any step. */
  expectations: string[];
  /**
   * What the cleanup must make true once it has run. Decided inside the
   * cleanup, where the undo happens — a `spec.yaml` case states none.
   */
  cleanupExpectations: string[];
  /** Sections ccqa does not interpret, handed to the recorder as context. */
  context: Array<{ heading: string; body: string }>;
  /** Values a header or title tag may refer to, by the config's own names. */
  fields: Record<string, string | undefined>;
  /** Stated by the source, but opted out of runs and audits. */
  disabled: boolean;
  /**
   * Why this case cannot be recorded, generated or run, although it can still
   * be listed and described. Today the one cause is an `include:` naming a
   * block that is not there.
   *
   * Two readings, both right: a command asked to act on this case must refuse
   * (`CaseReader.load` throws), and a command taking stock of the suite must
   * keep it — dropping a case from an inventory or a selection clears it on no
   * evidence, which is the one outcome those must never produce.
   */
  blocked: string | null;
  /** The file that states this case. */
  document: CaseDocument;
  /**
   * ccqa's own spec, parsed — null for a case stated any other way.
   *
   * The one native-only escape hatch on this shape. Includes, sessions and
   * per-step expectations are `spec.yaml` features with no equivalent
   * elsewhere, so the handful of readers that need them ask for the spec
   * rather than every reader learning a document kind.
   */
  spec: TestSpec | null;
}

export interface CaseDocument {
  /** Absolute path of the file. */
  path: string;
  /** The file verbatim — prompts want what was written, not a re-serialization. */
  text: string;
}

/**
 * Step ids are the case's numbering, so evidence and diffs can cite them. The
 * one spelling: `step-comment.ts` rebuilds an id from a comment's number, and
 * a padding width that disagreed would empty the evidence table's every row.
 */
export function stepId(n: number): string {
  return `step-${String(n).padStart(2, "0")}`;
}

export function cleanupId(n: number): string {
  return `cleanup-${String(n).padStart(2, "0")}`;
}

/** ccqa's own spec, expanded — the shape every target has always consumed. */
export function caseFromSpec(
  featureName: string,
  specName: string,
  yaml: string,
  blocks: Map<string, BlockSpec>,
  cwd?: string,
): TestCase {
  const spec = parseTestSpec(yaml);
  const expanded = expandOrName(spec, blocks);
  return {
    ref: specCase(featureName, specName, cwd),
    title: spec.title,
    mode: spec.mode ?? DEFAULT_SPEC_MODE,
    steps: expanded.steps,
    cleanup: [],
    expectations: [],
    cleanupExpectations: [],
    context: [],
    fields: { case: `${featureName}/${specName}`, title: spec.title },
    disabled: spec.disabled === true,
    blocked: expanded.blocked,
    document: { path: specFilePath(featureName, specName, cwd), text: yaml },
    spec,
  };
}

/**
 * The spec's steps with its blocks inlined — or, when a block cannot be
 * resolved, each step named as the document writes it and the reason carried
 * on `blocked`. Naming the block is what a reader of the document sees; it is
 * not a step anything may act on, which is what `blocked` says.
 */
function expandOrName(
  spec: TestSpec,
  blocks: Map<string, BlockSpec>,
): { steps: ExpandedStep[]; blocked: string | null } {
  try {
    return { steps: expandSpec(spec, { blocks }), blocked: null };
  } catch (err) {
    const steps = spec.steps.map((step, i): ExpandedStep => {
      const body = isIncludeStep(step)
        ? { instruction: `include block: ${step.include}`, expected: "" }
        : step;
      return { id: stepId(i + 1), source: "case", ...body };
    });
    return { steps, blocked: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Lift what a source answered (see `./contract.ts`) into the shape every
 * feature consumes.
 */
export function caseFromDocument(read: Case, cwd?: string): TestCase {
  return {
    ref: sourcedCase(read.id, cwd),
    title: read.title,
    mode: read.mode,
    steps: read.steps.map((step, i) => ({
      id: stepId(i + 1),
      source: "case",
      instruction: step.instruction,
      expected: step.expected ?? "",
    })),
    cleanup: (read.cleanup ?? []).map((step, i) => ({
      id: cleanupId(i + 1),
      source: "cleanup",
      instruction: step.instruction,
      expected: step.expected ?? "",
    })),
    expectations: [...(read.expectations ?? [])],
    cleanupExpectations: [...(read.cleanupExpectations ?? [])],
    context: [...(read.context ?? [])],
    fields: { case: read.id, title: read.title, ...read.fields },
    disabled: read.disabled === true,
    blocked: null,
    document: { path: read.path, text: read.text },
    spec: null,
  };
}
