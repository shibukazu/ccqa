import type { RecordedAction } from "../ir/types.ts";
import type { Recording } from "../store/index.ts";
import type { TestCase } from "../intent/case.ts";
import { describeAction } from "../ir/route-diff.ts";

/**
 * The table a reviewer reads instead of the generated test.
 *
 * The question a reviewer has is not "is this code correct" but "does this
 * code do what the case says". Answering it from the test file means reading
 * page objects, helpers and locators to reconstruct a flow the case already
 * states in a sentence — which is why review of generated tests either takes
 * an hour or does not happen.
 *
 * So the row is the case's own step, and everything else is what that step
 * became: what was recorded, what the generated code asserts, and the
 * screenshot of the screen it happened on. A step with no assertion is
 * visible as a hole in the column, not as an absence nobody notices.
 */

export interface EvidenceStep {
  /** As the case numbers it — `step-01` for markdown's `1.`. */
  id: string;
  /** The step as the case's author wrote it. */
  instruction: string;
  /** What the recording did for this step. */
  actions: string[];
  /** Lines of the generated test that decide something, for this step. */
  assertions: string[];
  /** Screenshot paths, relative to the evidence file. */
  screenshots: string[];
}

export interface EvidenceInput {
  testCase: TestCase;
  recording: Recording;
  /** The generated test, and where it lives (project-root-relative). */
  test: { path: string; source: string };
  /** Screenshot files by step id, already relative to the evidence file. */
  screenshots: Map<string, string[]>;
  /** What the verifies-spec review said, if it ran. */
  unchecked?: string[];
}

/** Assertion lines a reviewer can check without reading the whole file. */
const ASSERTION = /^\s*(?:await\s+)?(?:expect|judgeByLlm)\b.*$/;
/** `// step: step-01 [case]` — the boundary the emitter writes. */
const STEP_COMMENT = /^\s*\/\/\s*step:\s*(\S+)\s*\[/;

/**
 * Assertions grouped by the step they sit under, read from the step comments
 * the emitter leaves. A rewrite that moved an assertion into a page object
 * leaves nothing here, which is the honest answer: the reviewer cannot see it
 * either, and the row says so rather than implying coverage.
 */
export function assertionsByStep(source: string): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of source.split("\n")) {
    const boundary = STEP_COMMENT.exec(line);
    if (boundary) {
      current = boundary[1]!;
      if (!byStep.has(current)) byStep.set(current, []);
      continue;
    }
    if (current && ASSERTION.test(line)) byStep.get(current)!.push(line.trim());
  }
  return byStep;
}

/** Recorded actions grouped by the step that produced them. */
export function actionsByStep(actions: readonly RecordedAction[]): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  for (const action of actions) {
    const id = action.stepId ?? "(no step)";
    const described = describeAction(action);
    const list = byStep.get(id);
    if (list) list.push(described);
    else byStep.set(id, [described]);
  }
  return byStep;
}

export function buildEvidenceSteps(input: EvidenceInput): EvidenceStep[] {
  const actions = actionsByStep([...input.recording.actions, ...(input.recording.cleanup ?? [])]);
  const assertions = assertionsByStep(input.test.source);
  return [...input.testCase.steps, ...input.testCase.cleanup].map((step) => ({
    id: step.id,
    instruction: "instruction" in step ? step.instruction : step.judgeByLlm,
    actions: actions.get(step.id) ?? [],
    assertions: assertions.get(step.id) ?? [],
    screenshots: input.screenshots.get(step.id) ?? [],
  }));
}

/** The evidence as markdown — a fragment, for whoever assembles the PR body. */
export function renderEvidence(input: EvidenceInput): string {
  const steps = buildEvidenceSteps(input);
  const lines = [
    `# ${input.testCase.title}`,
    "",
    `Case: \`${input.testCase.ref.id}\``,
    `Test: \`${input.test.path}\``,
    `Recorded: ${input.recording.recordedAt ?? "(unknown)"}`,
    ...(input.recording.origin ? [`From: \`${input.recording.origin}\``] : []),
    "",
    "| Step | What the case says | What was recorded | What the test decides | Screens |",
    "|---|---|---|---|---|",
  ];
  for (const step of steps) {
    const cells = [
      step.id,
      cell(step.instruction),
      cell(step.actions.join("<br>")),
      // The column that matters: empty means this step is performed and
      // nothing about its outcome is checked.
      step.assertions.length > 0 ? cell(step.assertions.join("<br>")) : "**nothing**",
      step.screenshots.map((path) => `![${step.id}](${path})`).join(" ") || "—",
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  if (input.testCase.expectations.length > 0) {
    lines.push("## What the case expects", "");
    for (const expectation of input.testCase.expectations) lines.push(`- ${expectation}`);
    lines.push("");
  }
  lines.push("## Review", "");
  lines.push(
    input.unchecked === undefined
      ? "The generated test was not reviewed against the case."
      : input.unchecked.length === 0
        ? "Every step's outcome is decided by the generated test."
        : input.unchecked.map((finding) => `- ${finding}`).join("\n"),
  );
  lines.push("");
  return lines.join("\n");
}

/** A table cell: pipes escaped, newlines folded, code voice for the machine parts. */
function cell(text: string): string {
  const clean = text.replaceAll("|", "\\|").replaceAll("\n", "<br>");
  return clean.length === 0 ? "—" : clean;
}
