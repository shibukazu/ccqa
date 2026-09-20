import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import * as log from "../cli/logger.ts";
import { verifiesSpecPrompt } from "../prompts/verifies-spec.ts";
import { isExpandedActionStep, type ExpandedStep } from "../spec/expand.ts";
import { assertionsByStep } from "../evidence/table.ts";
import { evidenceLabels, type EvidenceLabels } from "../evidence/labels.ts";
import type { InvokeFn, LlmGeneratedFile } from "./llm-engine.ts";

// `findings` は必須。既定値を与えると、キー名を間違えた返答や指摘を落とした
// 返答が parse に成功し、「点検して問題なし」として通ってしまう。プロンプトは
// 指摘が無いときも空配列を書かせる契約なので、必須にして困る正常系は無い。
const FindingsSchema = z.object({
  findings: z.array(z.object({ stepId: z.string(), problem: z.string() })),
});

// `rule` and `code` are what make a violation answerable: without the evidence
// it is judged by — the guide's own line, or what the reviewer counted in the
// repository — the next reader cannot tell a rule from a preference, and
// without the offending code the fix pass has to go looking for it.
//
// A severity the reviewer did not state reads as blocking: it is what every
// violation used to be, and a malformed answer must not be the way a finding
// stops costing anything.
const ViolationSchema = z.object({
  file: z.string(),
  guide: z.string(),
  rule: z.string(),
  code: z.string(),
  severity: z.enum(["blocking", "advisory"]).catch("blocking"),
});

// Read one entry at a time. A strict array is all-or-nothing, so one violation
// the model shaped wrong would discard every well-formed one beside it — and
// the review would then report a clean file it never cleared.
const ViolationsSchema = z.object({ ruleViolations: z.array(z.unknown()) });

/** One step whose assertions don't decide what the step claims. */
export type SpecCoverageFinding = z.infer<typeof FindingsSchema>["findings"][number];

/** One file that breaks a rule the project states or the rest of the suite shows. */
export type GuideViolation = z.infer<typeof ViolationSchema>;

/**
 * How much reading one review may do.
 *
 * A runaway guard, not a working limit: the reviewer opens the files under
 * review, then searches the suite for each convention it wants to check, and a
 * review that reaches this is looping rather than working. Reaching it costs
 * the review, not the generate — the answer comes back unusable and the loop
 * treats it as one it could not obtain.
 */
const MAX_REVIEW_TURNS = 80;

/** A wedged call, not a slow one: a review still silent after this is stuck. */
const REVIEW_TIMEOUT_MS = 10 * 60_000;

/** Read-only: a reviewer reads the repository and changes nothing in it. */
const REVIEW_TOOLS = ["Read", "Grep", "Glob"];

function parseAnswer<T>(answer: string, schema: z.ZodType<T>): T | null {
  const json = extractJsonBlock(answer);
  if (!json) return null;
  try {
    return schema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Findings in the model's answer, or null when it did not answer in the
 * agreed shape. Null is not "no findings": the caller says so rather than
 * reporting a clean review it never got.
 */
export function parseVerifiesSpecFindings(answer: string): SpecCoverageFinding[] | null {
  return parseAnswer(answer, FindingsSchema)?.findings ?? null;
}

/**
 * Rule violations in the same answer, or null when that half did not come
 * back. Read apart from the findings on purpose: one answer carries two
 * reviews, and a malformed half must not discard the other.
 */
function parseGuideViolations(answer: string): GuideViolation[] | null {
  const entries = parseAnswer(answer, ViolationsSchema)?.ruleViolations;
  if (entries === undefined) return null;
  const violations = entries.flatMap((entry) => {
    const parsed = ViolationSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (violations.length < entries.length) {
    log.warn(`${entries.length - violations.length} rule violation(s) came back unreadable and were dropped`);
  }
  return violations;
}

/**
 * Whether a step claims an outcome of its own. "Open the list", "click Add",
 * "type a title" do not: nothing follows from them that a test could check,
 * and a hand-written test asserts nothing after them either. A markdown case
 * states its expectations for the flow, so none of its steps claim one.
 *
 * One predicate, two readers — the review below and the evidence table, which
 * reach the same verdict from the same file and must not be able to disagree
 * about which steps were supposed to decide something.
 */
export function claimsAnOutcome(step: { expected?: string }): boolean {
  return (step.expected ?? "").trim().length > 0;
}

/**
 * What a step that states an outcome, and carries no assertion under it, is
 * told. Shared with the evidence table, which reaches the same verdict from
 * the same file — a reader must not meet two wordings for one fact.
 *
 * It reports what was seen, not what was concluded. An assertion a rewrite
 * moved into a page object is invisible here, and calling that "decides
 * nothing" would be ccqa claiming more than it looked at.
 */
export const NOTHING_DECIDED =
  "no assertion is visible under this step in the generated test — one moved into a helper does " +
  "not show here, and does not show to a reviewer reading the file either";

/**
 * The warning a finding becomes, phrased so the reader knows the test is green
 * for nothing. A step deciding nothing is its own explanation, so only the
 * model's own words are worth appending.
 */
export function formatFinding(finding: SpecCoverageFinding, labels: EvidenceLabels = evidenceLabels()): string {
  const nothing = finding.problem === NOTHING_DECIDED;
  const claim = nothing ? labels.findingNothing : labels.findingUndecided;
  return `${finding.stepId}: ${claim}${nothing ? "" : ` — ${finding.problem}`}`;
}

/**
 * The warning a rule violation becomes: the file, the rule in the words it was
 * judged by, and where that came from. An advisory one says so — a reader must
 * be able to tell a line that was worth a fix round from one that was not. The
 * offending code is left out: it is what the fix pass needs, not what a reader
 * scanning a log does.
 */
export function formatViolation(violation: GuideViolation): string {
  const advisory = violation.severity === "advisory" ? ", advisory" : "";
  return `${violation.file}: ${violation.rule} (${violation.guide}${advisory})`;
}

/**
 * What the review found, for a caller that keeps it rather than only printing
 * it. `findings: null` is "no review happened" — which is not the same as a
 * clean one, and a reader of the record must be able to tell them apart.
 */
export interface SpecCoverageReview {
  findings: SpecCoverageFinding[] | null;
  /**
   * False when the model's half could not be obtained. The mechanical half
   * still ran, so `findings` may be an empty array — which must not read as a
   * clean review, because only part of the review happened.
   */
  complete: boolean;
  /**
   * True when the call to the reviewer failed outright — an error, or the
   * timeout — rather than coming back with something unusable. The generation
   * stops asking after one: a reviewer that is gone costs every later round
   * its whole timeout and answers none of them.
   */
  reviewerFailed?: boolean;
  /** The findings as the lines the generate log shows. */
  warnings: string[];
  /**
   * What the same reading found against the project's own guides and against
   * the rest of the suite. Absent when there was nothing to ask — the project
   * declared no guides — or when that half of the answer did not come back;
   * the log says which. An empty array is an answer: every file follows every
   * rule the reviewer could quote or count.
   */
  ruleViolations?: GuideViolation[];
}

/**
 * Hand the written files to a reviewer who knows nothing about where they came
 * from, and ask what it would say on the pull request: whether each step is
 * decided (see `verifiesSpecPrompt`), and — where the project wrote rule
 * documents of its own — whether the code follows them and the suite it joins.
 *
 * It reads the files off disk with read-only tools rather than being shown
 * them, which is also what lets it read the rest of the repository: "follow
 * the existing implementation" cannot be checked against an inline copy of two
 * files, because the evidence for it is how many other files do it that way.
 *
 * Every invocation is a fresh session. The reviewer must not remember arguing
 * for a finding the previous round declined to act on, and what has already
 * been asked for is the loop's business, not the reviewer's.
 *
 * A review that could not be obtained answers `findings: null` and is logged —
 * it must not read as a pass, and it must also not fail the generate that
 * produced working files.
 */
export async function reviewGeneratedTest(input: {
  /** The files this change wrote: the test, and any support beside it. */
  files: readonly LlmGeneratedFile[];
  /** Paths the test imports that this change did not write. */
  leansOn?: readonly string[];
  steps: readonly ExpandedStep[];
  /**
   * What the case states for the flow as a whole, when its steps carry no
   * `expected` of their own. Without it a markdown case gives the model steps
   * that claim nothing, and the honest answer to "does the test decide this"
   * is then always yes.
   */
  expectations?: readonly string[];
  /** Cleanup steps, when the case says what its undo must make true. */
  cleanup?: readonly ExpandedStep[];
  /**
   * The project's rule documents, already loaded for the generation prompt.
   * Empty or absent: the second review is not asked for, and this is the
   * review it has always been.
   */
  guides?: readonly { path: string; body: string }[];
  language: string;
  model?: string;
  cwd: string;
  /**
   * False when the reviewer must not be called: the mechanical half below
   * costs nothing and still runs, and the model call — minutes of reading, and
   * a bill — is not made. The caller says when nothing could act on it.
   */
  askModel?: boolean;
  /** Test seam — defaults to `invokeClaudeStreaming`. */
  invoke?: InvokeFn;
}): Promise<SpecCoverageReview> {
  const tests = input.files.filter((f) => f.kind === "test");
  const source = tests.map((f) => f.contents).join("\n\n");
  if (source.trim().length === 0) {
    log.warn("could not check whether the generated test decides its spec (no test file to read)");
    return { findings: null, complete: false, warnings: [] };
  }

  // Asked of the file, not of the model: a step with no assertion under it is
  // a fact anyone can read off the source, and the evidence table reads it the
  // same way — so the two must not be able to disagree about it.
  const checked = assertionsByStep(source);
  const undecided = [...input.steps, ...(input.cleanup ?? [])]
    .filter(isExpandedActionStep)
    // A case that states its expectations for the flow rather than per step
    // leaves this half silent by design; the reading below is what covers it.
    .filter(claimsAnOutcome)
    .filter((step) => (checked.get(step.id) ?? []).length === 0)
    .map((step) => ({ stepId: step.id, problem: NOTHING_DECIDED }));

  // The half that needed no model, on its own. `complete: false` says so: a
  // reading nobody could act on was not asked for, and an empty findings list
  // from it must not read as a clean review.
  if (input.askModel === false) {
    return { findings: undecided, complete: false, warnings: undecided.map((f) => formatFinding(f)) };
  }

  const invoke = input.invoke ?? invokeClaudeStreaming;
  const guides = input.guides ?? [];
  const { result: answer, isError } = await invoke({
    prompt: verifiesSpecPrompt({
      steps: input.steps,
      testPath: tests[0]!.path,
      submitted: input.files.filter((f) => f.kind !== "test").map((f) => f.path),
      language: input.language,
      ...(input.expectations && input.expectations.length > 0
        ? { expectations: [...input.expectations] }
        : {}),
      ...(input.cleanup && input.cleanup.length > 0 ? { cleanup: [...input.cleanup] } : {}),
      ...(input.leansOn && input.leansOn.length > 0 ? { leansOn: input.leansOn } : {}),
      guides,
    }),
    allowedTools: REVIEW_TOOLS,
    maxTurns: MAX_REVIEW_TURNS,
    timeoutMs: REVIEW_TIMEOUT_MS,
    silenceBashLog: true,
    ...(input.model ? { model: input.model } : {}),
    cwd: input.cwd,
  }, () => {});
  // A review that could not be obtained still leaves the mechanical half,
  // which needed no model: reporting nothing here would read as a clean pass.
  const fromModel = isError ? null : parseVerifiesSpecFindings(answer);
  if (fromModel === null) {
    log.warn(
      `could not check whether the generated test decides its spec (${isError ? "Claude returned an error" : "no usable answer"})`,
    );
  }
  // Asked in the same breath, read on its own: a model that answered the steps
  // and skipped the rules has not cleared the code, and an absent key must not
  // be the way that gets recorded. `isError` is already reported above.
  const violations = guides.length === 0 || isError ? null : parseGuideViolations(answer);
  if (guides.length > 0 && !isError && violations === null) {
    log.warn("could not check the generated code against the project's conventions (no usable answer)");
  }
  const findings = mergeFindings(undecided, fromModel ?? []);
  return {
    findings,
    complete: fromModel !== null,
    ...(isError ? { reviewerFailed: true } : {}),
    warnings: [
      ...findings.map((finding) => formatFinding(finding)),
      ...(violations ?? []).map(formatViolation),
    ],
    ...(violations ? { ruleViolations: violations } : {}),
  };
}

/**
 * The mechanical finding wins its step: it is a fact, not a reading. Shared
 * with the evidence table, which merges the same two sources — one of them
 * recomputed from the file as it is now — and must show each step once.
 */
export function mergeFindings(
  undecided: SpecCoverageFinding[],
  fromModel: readonly SpecCoverageFinding[],
): SpecCoverageFinding[] {
  const claimed = new Set(undecided.map((f) => f.stepId));
  return [...undecided, ...fromModel.filter((f) => !claimed.has(f.stepId))];
}
