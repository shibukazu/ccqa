import { numberLines, outputLanguageBlock } from "../prompts/format.ts";
import {
  type AnalysisCustomPrompt,
  buildCustomPromptBlock,
  buildTriageUserPromptBlock,
} from "../prompts/custom-prompt.ts";
import type { BaseSource } from "./schema.ts";
import type { DraftIssue } from "../types.ts";
import { DRAFT_CATEGORY_LABEL } from "../types.ts";

/**
 * Bump on EVERY prompt change. Embedded in the report data and in exported
 * label JSON so accuracy numbers from different prompt iterations are never
 * silently mixed.
 *
 * v4: `script`/`failureLog` became optional and an alternate
 * `liveTranscriptExcerpt` source was added so the same classifier could
 * analyze live-spec (`mode: live`) failures alongside deterministic ones.
 *
 * v5: the classifier gained the `mcp__diff__changed_file_diff` tool — the
 * inline patch is only the relatedPaths-scoped seed, and hunks of any other
 * changed file are pulled on demand — and the tools section documents it.
 *
 * v6: baseline-aware decision guidance. Under a last-green baseline the
 * range strictly covers the passing→failing window, so "no in-range cause"
 * flips from a PRODUCT_BUG lean to an UNKNOWN (external cause) lean, and
 * PRODUCT_BUG becomes a positive claim (cite the in-range change). The
 * prompt also states the range's width (commits/days) and no longer inlines
 * the full unrelated diff when nothing matches relatedPaths — the
 * name-status list plus the on-demand tool replace that fallback.
 *
 * v7: external-target support. The classifier now analyzes runCommand-target
 * failures too, so it may be pointed at the spec's run-artifacts directory to
 * read the runner's own failure context (e.g. a Playwright
 * `error-context.md`) when the target produced one.
 *
 * v8: no-baseline mode. A spec with no usable baseline (last-green: never
 * green yet) used to be skipped outright, leaving a first failure with zero
 * root-cause information. It is now classified from the failure evidence
 * plus current-repository inspection (Read/Grep/Glob), with diff-dependent
 * guidance replaced by current-state guidance and a lower confidence
 * ceiling.
 */
export const ANALYSIS_PROMPT_VERSION = "8";

/**
 * Fully-qualified name of the on-demand file-diff tool, as the model calls
 * it. Lives here (not analyze.ts) because the prompt text below references
 * it — one source of truth. The name is the SDK's `mcp__<server>__<tool>`
 * composition of the server ("diff") and tool ("changed_file_diff") that
 * analyze.ts registers; changing either side must keep the two in sync.
 */
export const CHANGED_FILE_DIFF_TOOL = "mcp__diff__changed_file_diff";

export interface FailureAnalysisPromptInput {
  /**
   * Generated test source for the script-driven execution paths: the vitest
   * replay (agent-browser target) or an external target's generated test
   * (Playwright's `.spec.ts`, ...). Optional: live-mode runs produce no
   * script and pass `liveTranscriptExcerpt` instead.
   */
  script?: string;
  /**
   * Failure output for the script-driven paths: vitest stdout/stderr for the
   * agent-browser replay, the runCommand's exit code + output tail for an
   * external target. Optional for the same reason as `script`.
   */
  failureLog?: string;
  /**
   * Summary of the Claude transcript from a `mode: live` spec execution:
   * the final failed step's reasoning + truncated assistant log, plus a
   * one-line summary of every preceding step. See
   * `src/report/live-transcript-excerpt.ts:buildLiveTranscriptExcerpt`.
   * Optional: only the live path sets this.
   */
  liveTranscriptExcerpt?: string;
  specYaml: string;
  /**
   * Unified diff base...HEAD, already scoped to the spec's relatedPaths and
   * truncated. Null = no diff was captured; empty string = captured, but no
   * changed file matched the spec's relatedPaths (the name-status list still
   * shows everything, and hunks are fetchable via the on-demand tool).
   */
  diffPatch: string | null;
  /** `git diff --name-status` output for the same range. */
  changedFiles: string | null;
  /** The resolved base ref the diff was taken against (for the model's framing only). */
  baseRef: string | null;
  /**
   * Which rule produced the baseline. "last-green" means the base is the
   * commit where THIS spec last passed — the range strictly covers the
   * passing→failing window, which flips the "diff doesn't explain it"
   * guidance from PRODUCT_BUG toward UNKNOWN. Fixed refs (explicit /
   * github-base-ref) keep the PR-diff framing. Omitted/null renders the
   * fixed-ref guidance.
   */
  baseSource?: BaseSource | null;
  /**
   * How wide the base...HEAD range is. Wide ranges mix many unrelated
   * changes, so the guidance raises the evidence bar. Null when unknown.
   */
  range?: { commitCount: number; days: number } | null;
  /**
   * Why no baseline exists for this spec (e.g. never green in the last-green
   * ledger), when that is the case. Switches the prompt into no-baseline
   * mode: there is no diff at all, so the range/diff guidance is replaced by
   * current-repository-state guidance. `diffPatch`, `changedFiles`,
   * `baseRef`, `baseSource` and `range` must all be null when this is set.
   */
  baselineMissing?: string | null;
  /** Findings from the spec↔code drift audit (analyzeDrift), when it ran. */
  driftIssues: DraftIssue[] | null;
  /**
   * cwd-relative directory holding this spec's run artifacts, when it has one
   * the classifier's read-only tools can reach (external targets only). Named
   * in the prompt so the model can read the runner's own failure context — a
   * Playwright `error-context.md` accessibility snapshot, a trace — that the
   * log tail alone doesn't carry. Omitted for paths with no such directory.
   */
  artifactsDir?: string | null;
  /** BCP-47 tag or "auto" (no directive). Identifiers/labels stay verbatim regardless. */
  outputLanguage?: string;
  /**
   * Human-maintained project triage guidance (the `triage.user` hub prompt,
   * plain Markdown). Injected ahead of `customPrompt` — standing human
   * guidance first, learned calibration second. Omitted/null means none —
   * same backward-compatibility contract as `customPrompt`.
   */
  triageUserPrompt?: string | null;
  /**
   * Claude-written calibration guidance learned from human-graded past
   * failures (a hub triage-learning job). Omitted/null means base-only — the
   * prompt is then byte-identical to before this field existed (backward
   * compatibility).
   */
  customPrompt?: AnalysisCustomPrompt | null;
}

export function buildFailureAnalysisPrompt(input: FailureAnalysisPromptInput): string {
  const {
    script,
    specYaml,
    failureLog,
    liveTranscriptExcerpt,
    diffPatch,
    changedFiles,
    baseRef,
    baseSource = null,
    range = null,
    driftIssues,
    artifactsDir = null,
    outputLanguage = "auto",
    triageUserPrompt,
    customPrompt,
    baselineMissing = null,
  } = input;
  const lastGreen = baseSource === "last-green";

  // Both render "" when absent, so the prompt is unchanged from before.
  const triageUserPromptBlock = buildTriageUserPromptBlock(triageUserPrompt);
  const customPromptBlock = buildCustomPromptBlock(customPrompt);

  const languageBlock = outputLanguageBlock(
    outputLanguage,
    "`reasoning`, `detail`",
    "label names (TEST_DRIFT, etc.)",
  );

  // Either deterministic artefacts (script + failureLog) or live artefacts
  // (liveTranscriptExcerpt) populate this block. When neither is available
  // we still emit a header so the model isn't surprised by the missing
  // section; downgrades the call to UNKNOWN with low confidence.
  const executionBlock = buildExecutionEvidenceBlock(script, failureLog, liveTranscriptExcerpt);

  // Human framing of the baseline: "since this spec last passed" is what a
  // last-green base means, and the model should reason in those terms.
  const baseLabel = lastGreen
    ? `this spec's last passing commit${baseRef && baseRef !== "last-green" ? ` (${baseRef})` : ""}`
    : (baseRef ?? "base");
  const rangeNote = range
    ? ` — spans ${range.commitCount} commit${range.commitCount === 1 ? "" : "s"} over ${range.days} day${range.days === 1 ? "" : "s"}`
    : "";

  let diffBlock: string;
  if (baselineMissing) {
    diffBlock = `## Source changes

No baseline exists for this spec (${baselineMissing}), so there is no source diff. Work from the current repository state instead:
- Grep for the exact selector / text / aria-label the failing step targets. Absent or renamed while the user-visible flow the spec describes still exists → the test is stale. The flow itself no longer implemented → the spec is stale.
- Without a change window you cannot attribute the failure to a specific change — do not claim a change "introduced" it. State what the current source shows.
`;
  } else if (diffPatch === null) {
    diffBlock = `## Source changes

No diff context is available (the base ref could not be resolved, or there are no changes). Classify from the failure log, the spec, and what you can read in the repository — and be correspondingly more conservative: prefer UNKNOWN over a confident SPEC_CHANGE/PRODUCT_BUG call without diff evidence.
`;
  } else if (diffPatch.length === 0) {
    diffBlock = `## Source changes since ${baseLabel}${rangeNote}

### Changed files (name-status)
${changedFiles && changedFiles.length > 0 ? changedFiles : "(no changes in range)"}

No changed file matches this spec's relatedPaths, so no hunks are inlined. "No related change" is a real signal — but before concluding, scan the name-status list for anything that could plausibly reach this spec and fetch its hunk with \`${CHANGED_FILE_DIFF_TOOL}\`.
`;
  } else {
    diffBlock = `## Source changes since ${baseLabel}${rangeNote} (git diff, scoped to this spec's relatedPaths, may be truncated)

### Changed files (name-status)
${changedFiles ?? "(unavailable)"}

### Patch
\`\`\`diff
${diffPatch}
\`\`\`
`;
  }

  const driftBlock =
    driftIssues && driftIssues.length > 0
      ? `## Spec↔code drift audit findings

A separate read-only audit compared the spec against the current source. Treat these as hints, not verdicts:

${driftIssues
  .map(
    (i) =>
      `- [${i.severity}] (${DRAFT_CATEGORY_LABEL[i.category]}${i.stepId ? `, step ${i.stepId}` : ""}) ${i.message}${i.detail ? ` — ${i.detail}` : ""}`,
  )
  .join("\n")}
`
      : "";

  return `${
    baselineMissing
      ? `You are analyzing a failing E2E regression test. No known-good baseline exists for this spec yet, so there is no source diff: your primary context is the failure evidence plus the CURRENT state of the repository, which you can inspect with the read-only tools. Your job is a root-cause CALL, not a fix: decide which of three categories explains the failure.`
      : `You are analyzing a failing E2E regression test against the source changes since a known-good baseline. Your job is a root-cause CALL, not a fix: decide which of three categories explains the failure, using the source diff as your primary context.`
  }

${languageBlock}## The three categories

The question that separates them: **is the behavior the spec describes still what the product intends?**

1. TEST_DRIFT — what the spec verifies is unchanged; only the test code drifted from the source. Typical: a selector/aria-label/placeholder rename, a timing change, an over-tight assertion. The diff shows a change that is invisible to the user's intent but visible to the test.
2. SPEC_CHANGE — the thing being verified itself changed: the UI flow, the layout, the feature's intended behavior. ${baselineMissing ? "The current source deliberately implements something other than what the spec asserts. You MUST cite the source file you read as evidence for this label." : "The diff deliberately changes what the spec asserts. You MUST cite the diff hunk (file + what changed) as evidence for this label."}
3. PRODUCT_BUG — neither of the above: the failure is not explained by the diff nor by test staleness. The product regressed.

If the evidence is too weak to choose, answer UNKNOWN — a wrong confident call is worse than an honest UNKNOWN, because humans grade these predictions to measure accuracy.

## You have read-only filesystem tools

You can call \`Grep\`, \`Glob\`, and \`Read\` against the current repository (post-change state) before producing the JSON. Use them to:
- confirm a suspected selector rename (grep for \`aria-label=\`, \`placeholder=\`, \`data-testid\`, i18n strings),
- read the changed files in full when the truncated patch is not enough,
- check whether the element/flow the spec describes still exists in the source.

${
  baselineMissing
    ? `There is no diff range for this run, so the \`${CHANGED_FILE_DIFF_TOOL}\` tool has nothing to return — every conclusion must come from the current source state plus the failure evidence.`
    : `You can also call \`${CHANGED_FILE_DIFF_TOOL}\` with a file path to fetch that file's diff hunk for this run's base...HEAD range. The inline patch below is scoped to this spec's relatedPaths — files OUTSIDE that scope still appear in "Changed files (name-status)" but their hunks are not inlined. Before blaming (or ruling out) such a file, fetch its diff with this tool; Read only shows you its post-change state, not what changed.`
}
${
  artifactsDir
    ? `\nThe test runner wrote this run's artifacts under \`${artifactsDir}\` (relative to the working directory). Read them for failure context the log tail above may not carry — e.g. a Playwright \`error-context.md\` holds the page's accessibility snapshot at the moment of failure, which often shows directly whether the awaited element was present. Do NOT open image/trace binaries.\n`
    : ""
}
You have **up to 12 tool turns**. Do NOT write, edit, run shell commands, or hit the network.

## Decision guidance

${
  baselineMissing
    ? `There is no baseline, so there is no "what changed" evidence at all. Classify from the failure signature checked against the current source:

- The selector / text / attribute the failing step targets is absent or renamed in the current source, while the user-visible flow the spec describes still exists → TEST_DRIFT (cite the file:line where the renamed/replacement element lives).
- The flow or feature the spec describes is no longer implemented — page gone, component removed, copy redefined, feature reworked → SPEC_CHANGE (cite the file you read that shows the new shape).
- The flow exists and the test's selectors still match the source, but the observed behavior is wrong (error response, missing side effect, wrong data) → lean PRODUCT_BUG; FIRST rule out environment/data/timing causes (daemon not running, network down, missing credentials, stale test data) — those read as UNKNOWN with low confidence, not PRODUCT_BUG.
- Without diff evidence, treat 0.7 as a practical confidence ceiling unless the current source alone is conclusive (e.g. the targeted selector is verifiably gone).`
    : `${
        lastGreen
          ? `The baseline is the commit where THIS spec last passed, so the range strictly covers the window in which it broke: the cause is either inside these changes or outside the code entirely (flaky timing, environment, an external service, test data). The range may mix several unrelated merges — most of the diff is noise; what matters is the specific change you can tie to the failing step.`
          : `The baseline is a fixed ref (typically the PR base): the spec is NOT guaranteed to have passed there, so the range is not guaranteed to contain the cause.`
      }

- Diff touches only attributes/identifiers the test selects on (labels, testids, class names, timing) while the user-visible flow is intact → TEST_DRIFT.
- Diff intentionally removes/reworks the UI or flow that a spec step verifies (component deleted, page restructured, copy redefined, feature flag flipped) → SPEC_CHANGE.
- Diff UNINTENTIONALLY breaks behavior the spec still intends — e.g. a refactor that drops a side effect, an inverted condition, a regression hiding inside a cleanup commit — → PRODUCT_BUG, citing the diff hunk as evidence. A product bug is often introduced BY the diff; what separates it from SPEC_CHANGE is intent: does the change read as a deliberate redesign of what the spec verifies, or as collateral damage?
${
  lastGreen
    ? `- No change in the range explains the failing step (after checking the inline patch, the name-status list, and any hunks you fetched) → the cause is outside the code: answer UNKNOWN with low confidence and name the suspected external cause (flaky timing, environment, external service, test data). Do NOT default to PRODUCT_BUG here — under this baseline a product regression must be tied to an in-range change.`
    : `- Diff is unrelated to the failing step (or there is no relevant diff) and the test was passing before → lean PRODUCT_BUG; first rule out timing/data flakiness and infrastructure errors (daemon not running, network down, missing credentials) — those read as UNKNOWN with low confidence, not PRODUCT_BUG.`
}${
        range
          ? `
- This range spans ${range.commitCount} commit${range.commitCount === 1 ? "" : "s"} over ${range.days} day${range.days === 1 ? "" : "s"}. The wider the range, the more unrelated changes are mixed in: SPEC_CHANGE and TEST_DRIFT still require citing the specific hunk — do not infer intent from the bulk of a large diff, and lower confidence when the evidence is spread thin.`
          : ""
      }`
}
- The drift audit findings (when present) flag spec↔code mismatches; an ERROR there usually supports TEST_DRIFT or SPEC_CHANGE over PRODUCT_BUG.

## Sub-diagnosis vocabulary

Alongside the label, report the closest fine-grained mechanic:
- SELECTOR_DRIFT, TIMING_ISSUE, OVER_ASSERTION — usually under TEST_DRIFT
- DATA_MISSING — missing test data/state; usually UNKNOWN or PRODUCT_BUG depending on cause
- NONE — when nothing fits (typical for SPEC_CHANGE and PRODUCT_BUG)

${triageUserPromptBlock}${customPromptBlock}## Output

Your **final** assistant message must start with \`{\` and end with \`}\` — a single JSON object, nothing before or after. No prose preamble, no markdown fences, no tool calls in the same turn.

{
  "label": "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG" | "UNKNOWN",
  "confidence": <0.0-1.0>,
  "subDiagnosis": "SELECTOR_DRIFT" | "TIMING_ISSUE" | "OVER_ASSERTION" | "DATA_MISSING" | "NONE",
  "headline": "<ONE short sentence stating what broke and where, max ~80 chars>",
  "evidence": [
    { "file": "<file:line or diff hunk reference, omit if log-only>", "detail": "<what THIS specific file/hunk directly proves about the failure, max ~120 chars>" }
  ],
  "recommendation": "<ONE imperative sentence: the concrete next action a reviewer should take>",
  "reasoning": "<optional longer paragraph — only used when a reviewer drills down>"
}

## Writing rules — make the report scannable

- **headline**: one declarative sentence in the report's language. Name the failing thing (assertion / step / selector) and the proximate cause. No hedging clauses like "may be" / "could be" — if you have to hedge, lower the confidence instead.
- **evidence**: at most THREE items. Each must DIRECTLY explain the failure. Drop "everything is fine over here" reassurance items (e.g. "the role guard fires correctly", "this unrelated file did not change"). If a finding does not change the call, it does not belong in evidence.
- **recommendation**: one imperative sentence. Use a verb (Replace, Add, Wait for, Tighten, Drop, ...). Avoid "consider investigating further" — that is a non-action.
- **reasoning**: optional. Use it only when there is something a single headline cannot carry (e.g. why two competing labels are close). Do NOT restate the headline or list the evidence again. If you have nothing extra to add, leave it as an empty string.

## Confidence guidance

- 0.9-1.0: the diff (or a file you read) directly shows the cause
- 0.7-0.9: strong indirect evidence
- 0.4-0.7: plausible but another category could explain it
- < 0.4: answer UNKNOWN instead of guessing

Evidence rules: TEST_DRIFT and SPEC_CHANGE require at least one concrete \`file\` reference (diff hunk or file:line you actually read). ${
    baselineMissing
      ? "With no baseline there is no in-range change to cite: PRODUCT_BUG must instead explain why current-state inspection rules out test staleness and spec change."
      : `PRODUCT_BUG should cite the in-range change that unintentionally broke the behavior when one exists; ${lastGreen ? "under this last-green baseline, if no in-range change explains the failure, that is UNKNOWN (external cause), not PRODUCT_BUG" : "when no such change exists, explain why the diff does NOT account for the failure"}.`
  }

## Test Spec (spec.yaml)
${specYaml}

${executionBlock}

${diffBlock}
${driftBlock}`;
}

/**
 * Render the execution-evidence section the model needs to classify the
 * failure.
 *
 * Two execution modes plug in here:
 *   - **Deterministic** (spec.yaml `mode: deterministic`): a generated
 *     vitest script plus its stdout/stderr.
 *   - **Live** (spec.yaml `mode: live`): a transcript excerpt from Claude
 *     driving agent-browser step-by-step.
 *
 * The block headers are the same in both modes so the classifier prompt
 * never has to branch on mode — it just sees "here's what was executed
 * and here's how it failed".
 */
function buildExecutionEvidenceBlock(
  script: string | undefined,
  failureLog: string | undefined,
  liveTranscriptExcerpt: string | undefined,
): string {
  const sections: string[] = [];

  if (script && script.length > 0) {
    sections.push(`## Test Script (with line numbers)
${numberLines(script)}`);
  }

  if (failureLog && failureLog.length > 0) {
    sections.push(`## Failure Log
${failureLog.slice(0, 8000)}`);
  }

  if (liveTranscriptExcerpt && liveTranscriptExcerpt.length > 0) {
    sections.push(`## Live Run Transcript (summary of Claude's per-step execution)
${liveTranscriptExcerpt}`);
  }

  if (sections.length === 0) {
    return `## Execution evidence

(No script, failure log, or live transcript was captured for this run. Classify from spec.yaml + diff only, and be correspondingly more conservative — prefer UNKNOWN over a confident call.)`;
  }

  return sections.join("\n\n");
}
