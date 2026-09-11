import { SETUP_STEP_ID, type RecordedAction } from "../ir/types.ts";
import type { Recording } from "../store/index.ts";
import type { TestCase } from "../intent/case.ts";
import { describeAction } from "../ir/route-diff.ts";
import { parseStepComment } from "../codegen/step-comment.ts";
import {
  formatFinding,
  mergeFindings,
  NOTHING_DECIDED,
  type SpecCoverageFinding,
} from "../targets/verifies-spec.ts";
import { evidenceLabels, type EvidenceLabelKey, type EvidenceLabels } from "./labels.ts";
import type { SourceAnchors, SourceNeedle } from "./source-anchors.ts";

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
  needles: SourceNeedle[];
}

export interface EvidenceInput {
  testCase: TestCase;
  recording: Recording;
  /** The generated test, and where it lives (project-root-relative). */
  test: { path: string; source: string };
  /** Screenshot files by step id, already relative to the evidence file. */
  screenshots: Map<string, string[]>;
  /**
   * What the review of the generated test found, if one was obtained. Its
   * findings, not its rendered warnings: the table reaches the same verdict
   * about a step that decides nothing, and pairing the two by step id is the
   * only way to show each finding once.
   */
  review?: SpecCoverageFinding[];
  /**
   * What the product's own source was searched for, and where each was found.
   * Absent — not empty — is the signal that no `sourceRoots` were configured:
   * the column is omitted rather than shown full of "not found", which would
   * misreport an unsearched project as a searched-and-empty one.
   */
  anchors?: SourceAnchors;
  /** `evidence.labels`: the table's headings, in the project's own vocabulary. */
  labels?: Partial<Record<EvidenceLabelKey, string>>;
  /** The run's `--language`, which picks ccqa's own words for the table. */
  language?: string;
}

/** Assertion lines a reviewer can check without reading the whole file. */
const ASSERTION = /^\s*(?:await\s+)?(?:expect|judgeByLlm)\b.*$/;

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
    const boundary = parseStepComment(line);
    if (boundary) {
      current = boundary;
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
export function sourceNeedles(actions: readonly RecordedAction[]): SourceNeedle[] {
  const needles: SourceNeedle[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined, kind: SourceNeedle["kind"] = "text"): void => {
    if (value === undefined || value.includes("${") || seen.has(value)) return;
    seen.add(value);
    needles.push({ value, kind });
  };
  for (const action of actions) {
    for (const locator of [action.locator, action.target]) {
      if (!locator) continue;
      // A test id is looked for as an attribute and nothing else: the same
      // string in a selector or a comment is not where it is declared.
      if (locator.by === "testid") add(locator.value, "testid");
      else if (locator.by === "placeholder" || locator.by === "label") add(locator.value);
      else if (locator.by === "role") add(locator.name);
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

/** Entries past this many fold away: a cell taller than the eye stops being read. */
const FOLD_OVER = 2;

/** The evidence as markdown — a fragment, for whoever assembles the PR body. */
export function renderEvidence(input: EvidenceInput): string {
  const labels = evidenceLabels(input.labels, input.language);
  const steps = buildEvidenceSteps(input);
  const anchors = input.anchors;
  const lines = [
    `# ${input.testCase.title}`,
    "",
    `${labels.case}: \`${input.testCase.ref.id}\``,
    `${labels.test}: \`${input.test.path}\``,
    `${labels.recordedAt}: ${input.recording.recordedAt ?? "(unknown)"}`,
    ...(input.recording.origin ? [`${labels.from}: \`${input.recording.origin}\``] : []),
    "",
  ];
  // Signing in and reaching the first screen belong to no step of the case,
  // and inside one they double its row. An action the recorder could not
  // attribute is shown too, but apart: missing attribution says nothing about
  // when it happened, and calling it pre-step work would claim an order
  // nobody recorded.
  for (const [label, actions] of outsideTheCase(input, steps, labels)) {
    lines.push(`${label}: ${fold(actions, labels)}`, "");
  }
  lines.push(
    `| ${labels.step} | ${labels.instruction} | ${labels.recorded} | ${labels.decides}` +
      (anchors ? ` | ${labels.source}` : "") +
      ` | ${labels.screens} |`,
    "|---|---|---|---|" + (anchors ? "---|" : "") + "---|",
  );
  for (const step of steps) {
    const cells = [
      step.id,
      cell(step.instruction),
      fold(step.actions, labels),
      // The column that matters: empty means this step is performed and
      // nothing about its outcome is checked.
      step.assertions.length > 0 ? cell(step.assertions.join("<br>")) : `**${labels.nothing}**`,
      ...(anchors ? [sourceAnchorCells(step.needles, anchors, labels)] : []),
      step.screenshots.map((path) => `![${step.id}](${path})`).join(" ") || "—",
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  if (input.testCase.expectations.length > 0) {
    lines.push(`## ${labels.expects}`, "");
    for (const expectation of input.testCase.expectations) lines.push(`- ${expectation}`);
    lines.push("");
  }
  // The rows above are read again rather than the review file trusted: the
  // review saw the file at generation time and this table sees it now, and a
  // summary that could contradict its own table is worse than no summary.
  const undecided = steps
    .filter((step) => step.assertions.length === 0)
    .map((step) => ({ stepId: step.id, problem: NOTHING_DECIDED }));
  const findings = mergeFindings(undecided, input.review ?? []);
  lines.push(`## ${labels.review}`, "");
  if (findings.length === 0) {
    lines.push(input.review === undefined ? labels.reviewAbsent : labels.reviewClean);
  } else {
    for (const finding of findings) lines.push(`- ${formatFinding(finding, labels)}`);
    if (input.review === undefined) lines.push("", labels.reviewPartial);
  }
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
function sourceAnchorCells(
  needles: readonly SourceNeedle[],
  anchors: SourceAnchors,
  labels: EvidenceLabels,
): string {
  const confirmed: string[] = [];
  const rest: string[] = [];
  for (const { value } of needles) {
    const anchor = anchors.found.get(value);
    if (!anchor) {
      rest.push(`\`${value}\` — ${anchors.unsearched.has(value) ? labels.notSearched : labels.notFound}`);
    } else if (anchor.places.length > 1) {
      // Several places say it equally well, so none of them is the answer.
      // Naming one would read as "this is where it comes from".
      rest.push(`\`${value}\` — ${labels.ambiguous}: ${anchor.places.join(", ")}`);
    } else {
      // The string is only ever inside a longer one, so the product renders
      // something this locator matches — not this string.
      const partial = anchor.partial ? ` (${labels.partialMatch})` : "";
      confirmed.push(`\`${value}\` — ${anchor.places[0]}${partial}`);
    }
  }
  // Only what the scan pinned to one place is worth a line: the column is read
  // as "the product really says this", and the rest answers a different
  // question. Kept, folded, because "not found" and "not searched" are facts a
  // reviewer sometimes needs.
  const folded =
    rest.length === 0
      ? []
      : [`<details><summary>${rest.length} ${labels.unconfirmed}</summary>${rest.join("<br>")}</details>`];
  return cell([...confirmed, ...folded].join("<br>"));
}

/** A cell that stays one line: past a couple of entries, the rest folds away. */
function fold(entries: readonly string[], labels: EvidenceLabels): string {
  if (entries.length <= FOLD_OVER) return cell(entries.join("<br>"));
  return `<details><summary>${entries.length} ${labels.operations}</summary>${cell(entries.join("<br>"))}</details>`;
}

/** Recorded actions belonging to no step of the case, kept apart by why. */
function outsideTheCase(
  input: EvidenceInput,
  steps: readonly EvidenceStep[],
  labels: EvidenceLabels,
): Array<[string, string[]]> {
  const ofTheCase = new Set(steps.map((step) => step.id));
  const grouped = actionsByStep([...input.recording.actions, ...(input.recording.cleanup ?? [])]);
  const setup: string[] = [];
  const rest: string[] = [];
  for (const [id, actions] of grouped) {
    if (!ofTheCase.has(id)) (id === SETUP_STEP_ID ? setup : rest).push(...actions);
  }
  const rows: Array<[string, string[]]> = [];
  if (setup.length > 0) rows.push([labels.setup, setup]);
  if (rest.length > 0) rows.push([labels.unattributed, rest]);
  return rows;
}
