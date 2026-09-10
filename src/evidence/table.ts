import type { RecordedAction } from "../ir/types.ts";
import type { Recording } from "../store/index.ts";
import type { TestCase } from "../intent/case.ts";
import { describeAction } from "../ir/route-diff.ts";
import type { SourceAnchors } from "./source-anchors.ts";

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
  /** Locator/assertion literals worth checking against the product's own source. */
  needles: string[];
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
  /**
   * What the product's own source was searched for, and where each was found.
   * Absent — not empty — is the signal that no `sourceRoots` were configured:
   * the column is omitted rather than shown full of "not found", which would
   * misreport an unsearched project as a searched-and-empty one.
   */
  anchors?: SourceAnchors;
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

/**
 * Recorded actions grouped by the step that produced them. `"(no step)"` is
 * the bucket for an action the recorder could not attribute — kept rather than
 * dropped, since it still happened.
 */
function groupByStep(actions: readonly RecordedAction[]): Map<string, RecordedAction[]> {
  const byStep = new Map<string, RecordedAction[]>();
  for (const action of actions) {
    const id = action.stepId ?? "(no step)";
    const list = byStep.get(id);
    if (list) list.push(action);
    else byStep.set(id, [action]);
  }
  return byStep;
}

/** The same grouping, each action rendered for a reader. */
export function actionsByStep(actions: readonly RecordedAction[]): Map<string, string[]> {
  return new Map(
    [...groupByStep(actions)].map(([id, grouped]) => [id, grouped.map(describeAction)]),
  );
}

/**
 * The locator/assertion literals worth anchoring to the product's own source:
 * a testid, an accessible name, a placeholder, a label, an asserted text. Not
 * every locator strategy — `css`, `text` and `alt`/`title` locators are as
 * often a CSS/testing artifact as product copy, and would anchor to noise.
 *
 * A value containing `${...}` is a run-id-substituted value at replay time
 * and has no literal counterpart in the source, so it is dropped rather than
 * searched for and reported "not found".
 */
export function sourceNeedles(actions: readonly RecordedAction[]): string[] {
  const needles: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined || value.includes("${") || seen.has(value)) return;
    seen.add(value);
    needles.push(value);
  };
  for (const action of actions) {
    for (const locator of [action.locator, action.target]) {
      if (!locator) continue;
      if (locator.by === "testid" || locator.by === "placeholder" || locator.by === "label") {
        add(locator.value);
      } else if (locator.by === "role") {
        add(locator.name);
      }
    }
    if (action.assert === "text_visible" || action.assert === "text_not_visible") add(action.value);
  }
  return needles;
}

export function buildEvidenceSteps(input: EvidenceInput): EvidenceStep[] {
  const byStep = groupByStep([...input.recording.actions, ...(input.recording.cleanup ?? [])]);
  const assertions = assertionsByStep(input.test.source);
  return [...input.testCase.steps, ...input.testCase.cleanup].map((step) => {
    const actions = byStep.get(step.id) ?? [];
    return {
      id: step.id,
      instruction: "instruction" in step ? step.instruction : step.judgeByLlm,
      actions: actions.map(describeAction),
      assertions: assertions.get(step.id) ?? [],
      screenshots: input.screenshots.get(step.id) ?? [],
      needles: sourceNeedles(actions),
    };
  });
}

/** The evidence as markdown — a fragment, for whoever assembles the PR body. */
export function renderEvidence(input: EvidenceInput): string {
  const steps = buildEvidenceSteps(input);
  const anchors = input.anchors;
  const lines = [
    `# ${input.testCase.title}`,
    "",
    `Case: \`${input.testCase.ref.id}\``,
    `Test: \`${input.test.path}\``,
    `Recorded: ${input.recording.recordedAt ?? "(unknown)"}`,
    ...(input.recording.origin ? [`From: \`${input.recording.origin}\``] : []),
    "",
    "| Step | What the case says | What was recorded | What the test decides" +
      (anchors ? " | Where the source says so" : "") +
      " | Screens |",
    "|---|---|---|---|" + (anchors ? "---|" : "") + "---|",
  ];
  for (const step of steps) {
    const cells = [
      step.id,
      cell(step.instruction),
      cell(step.actions.join("<br>")),
      // The column that matters: empty means this step is performed and
      // nothing about its outcome is checked.
      step.assertions.length > 0 ? cell(step.assertions.join("<br>")) : "**nothing**",
      ...(anchors ? [sourceAnchorCells(step.needles, anchors)] : []),
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

/**
 * One line per needle. "not found" is a claim about the product, so a needle
 * the scan never looked for says so instead — the reviewer's whole use of this
 * column is telling those two apart.
 */
function sourceAnchorCells(needles: readonly string[], anchors: SourceAnchors): string {
  return cell(
    needles
      .map((needle) => {
        const at = anchors.found.get(needle)?.at;
        if (at) return `\`${needle}\` — ${at}`;
        return `\`${needle}\` — ${anchors.unsearched.has(needle) ? "not searched" : "not found"}`;
      })
      .join("<br>"),
  );
}
