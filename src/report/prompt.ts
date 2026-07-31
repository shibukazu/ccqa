import {
  numberLines,
  outputLanguageBlock,
  surfaceAxisAside,
  surfaceDefinitionBlock,
} from "../prompts/format.ts";
import {
  type AnalysisCustomPrompt,
  buildCustomPromptBlock,
  buildTriageUserPromptBlock,
} from "../prompts/custom-prompt.ts";
import { formatBlockList, type AvailableBlock } from "../prompts/draft.ts";
import type { BaseSource } from "./schema.ts";

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
 * inline patch is only a truncated seed, and hunks of any other changed file
 * are pulled on demand — and the tools section documents it.
 *
 * v6: baseline-aware decision guidance. Under a last-green baseline the
 * range strictly covers the passing→failing window, so "no in-range cause"
 * flips from a PRODUCT_BUG lean to an UNKNOWN (external cause) lean, and
 * PRODUCT_BUG becomes a positive claim (cite the in-range change). The
 * prompt also states the range's width (commits/days) and no longer inlines
 * the full diff when it exceeds the truncation caps — the name-status list
 * plus the on-demand tool replace that fallback.
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
 *
 * v9: `relatedPaths` removed from the spec schema (superseded by
 * `ccqa select-specs`, ADR-0011). The inline patch is no longer scoped to a
 * spec's declared paths, only truncated by size — every changed file's hunk
 * is either inlined or one `changed_file_diff` call away, never filtered out
 * by relevance.
 *
 * v10: the drift audit's evidence became a single `driftAudit` diagnosis (was
 * `driftIssues`, a category/severity list) in this classifier's own vocabulary,
 * weighed but never deferred to. Shipped on main; stamped reports exist.
 *
 * v11 (withdrawn): Rejected design A — a separate run-only vocabulary
 * (PRODUCT_BUG/ENVIRONMENT/AUDIT_MISS) alongside the audit's TEST_DRIFT/
 * SPEC_CHANGE. See ADR-0016.
 *
 * v12 (withdrawn): Rejected design B — two stages, with the audit run first
 * gating and pre-classifying for the run. See ADR-0016.
 *
 * v13: one call instead of two. `--on-fail-explain` used to run the drift
 * audit first and ask this prompt only what the audit could not answer, which
 * forced every product bug into a drift label: the audit sees "spec and code
 * disagree" and cannot open a browser, so it must call that a stale test case.
 * The audit's source reading — both surfaces of the test case, the concrete
 * strings on each — now happens inside this call, which also holds the
 * execution evidence, and it answers all four causes plus `surface`. The
 * `driftAudit` input is gone with the stage that produced it.
 */
export const ANALYSIS_PROMPT_VERSION = "13";

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
   * script and pass `liveTranscriptExcerpt` instead. Also the `generated`
   * surface's content — see `hasGeneratedSurface` for whether that surface
   * exists at all, which an empty/absent `script` cannot answer on its own.
   */
  script?: string;
  /**
   * Whether this spec's execution mode has a `generated` surface at all,
   * independent of whether `script` could be read this run: deterministic and
   * external-target specs always have one (they run code `ccqa generate`
   * produced), `mode: live` specs never do. Omitted infers from `script`
   * presence (the old, conflated behavior) — every real caller should set
   * this explicitly so a read failure isn't reported as "no generated code".
   */
  hasGeneratedSurface?: boolean;
  /**
   * Blocks available under `.ccqa/blocks/`, so the classifier can check that
   * an `include:` step's target still exists — the run-side counterpart of
   * the audit's "Available blocks" section and its `include` check
   * (`src/prompts/drift.ts`). Empty/omitted renders "no blocks defined yet".
   */
  blocks?: AvailableBlock[];
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
   * Unified diff base...HEAD, truncated. Null = no diff was captured (base
   * ref resolution or git failed); empty string = captured, but the range
   * has no changes.
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
    hasGeneratedSurface: hasGeneratedSurfaceInput,
    blocks = [],
    failureLog,
    liveTranscriptExcerpt,
    diffPatch,
    changedFiles,
    baseRef,
    baseSource = null,
    range = null,
    artifactsDir = null,
    outputLanguage = "auto",
    triageUserPrompt,
    customPrompt,
    baselineMissing = null,
  } = input;
  const lastGreen = baseSource === "last-green";
  const hasGeneratedSurface = hasGeneratedSurfaceInput ?? (script !== undefined && script.length > 0);
  // True when a surface should exist (det/external-target row) but this run
  // could not read it — a file-read failure, not evidence it's absent. Distinct
  // from `!hasGeneratedSurface` (mode: live, which never has one to read).
  const generatedUnreadable = hasGeneratedSurface && !(script && script.length > 0);

  // Both render "" when absent, so the prompt is unchanged from before.
  const triageUserPromptBlock = buildTriageUserPromptBlock(triageUserPrompt);
  const customPromptBlock = buildCustomPromptBlock(customPrompt);

  const languageBlock = outputLanguageBlock(
    outputLanguage,
    "`reasoning`, `detail`",
    "label names (PRODUCT_BUG, etc.)",
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

No diff context is available (the base ref could not be resolved, or there are no changes). Classify from the failure log, the spec, and what you can read in the repository — and be correspondingly more conservative: prefer UNKNOWN over a confident PRODUCT_BUG call without diff evidence.
`;
  } else if (diffPatch.length === 0) {
    diffBlock = `## Source changes since ${baseLabel}${rangeNote}

### Changed files (name-status)
${changedFiles && changedFiles.length > 0 ? changedFiles : "(no changes in range)"}

No changes in this range. "No change" is a real signal — but before concluding, check whether the failure could still be environmental (timing, data, an external service).
`;
  } else {
    diffBlock = `## Source changes since ${baseLabel}${rangeNote} (git diff, may be truncated)

### Changed files (name-status)
${changedFiles ?? "(unavailable)"}

### Patch
\`\`\`diff
${diffPatch}
\`\`\`
`;
  }

  return `${
    baselineMissing
      ? `You are analyzing a failing E2E regression test. No known-good baseline exists for this spec yet, so there is no source diff: your primary context is the failure evidence plus the CURRENT state of the repository, which you can inspect with the read-only tools. Your job is a root-cause CALL, not a fix: decide which of four causes explains the failure.`
      : `You are analyzing a failing E2E regression test against the source changes since a known-good baseline. Your job is a root-cause CALL, not a fix: decide which of four causes explains the failure, using the source diff as your primary context.`
  }

${languageBlock}## What you are being asked

Two of the four causes are the test case, and the test case is two artifacts:

- **spec.yaml** — what is being verified, in prose. Each step's \`expected\` names something observable: visible text, an aria-label, a URL, an element state.
- **the generated test code** — what actually runs, compiled from a recording. It names the concrete selectors and strings the spec only describes in prose.${
    !hasGeneratedSurface
      ? " Not shown below: this spec has none, so the spec itself is what runs."
      : generatedUnreadable
        ? " Not shown below: it exists, but this run could not read it."
        : ""
  }

Either can fall out of step with the source, and each cause names the artifact that has to change:

1. **TEST_DRIFT** — the generated test code. What the spec verifies is unchanged; only the way the test reaches it went stale: a renamed selector, aria-label, placeholder or test id, an assertion tightened onto a string the source no longer renders there, a timing assumption. The fix is a re-recording.
2. **SPEC_CHANGE** — the spec. The thing being verified itself changed: the page is gone, the flow was reworked, the feature was removed or redefined, or an \`include:\` step points at a block that no longer exists. The fix is a human re-drafting the spec.
3. **PRODUCT_BUG** — the product. An error response, a missing side effect, wrong data, a flow that no longer completes. Say **what** broke and **where**, with evidence.
4. **ENVIRONMENT** — nothing in the repository. The target environment or the run itself: a service that is down, a missing or expired credential, absent seeded data, a timing race. You MUST name the specific external thing. A cause you can only describe in the abstract ("probably flaky") is UNKNOWN.

**UNKNOWN** — the evidence is too weak to choose. A wrong confident call is worse than an honest UNKNOWN, because humans grade these predictions to measure accuracy.

## What separates a stale test case from a broken product

The spec and the code disagreeing does NOT by itself mean the test case is stale. A broken product disagrees with its spec too — that is what "broken" means — so reading the disagreement as drift sends a human to rewrite a test that was right.

Ask instead: **is the code's current behavior what the product intends?**

- Deliberately different — a redesigned flow, a removed feature, a renamed concept, a rule someone changed on purpose → **SPEC_CHANGE**. Cite the source that shows the new shape.
- The same intent, reached differently — a selector, label, placeholder, test id, route or timing moved, and the user-visible flow the spec describes still exists → **TEST_DRIFT**. Cite where the replacement lives.
- Nobody intended it — a refactor dropped a side effect, a condition inverted, an argument stopped being passed, a factor stopped being multiplied in → **PRODUCT_BUG**, even though the spec and the code now disagree. The disagreement *is* the bug.

If the action you would recommend is "change the product", the label is PRODUCT_BUG. A label whose own recommendation repairs a different artifact is the wrong label.

## Which surface, for TEST_DRIFT and SPEC_CHANGE only

${
    !hasGeneratedSurface
      ? `There is no generated code for this spec, so the only surface is \`spec\`. Answer \`"surface": "spec"\` whenever you answer TEST_DRIFT or SPEC_CHANGE.`
      : generatedUnreadable
        ? `The generated code exists for this spec but could not be read for this run — a file-read failure, not evidence it's clean. Do not answer \`"surface": "spec"\` just because the generated-code section below is empty; if you cannot otherwise tell which surface drifted, prefer UNKNOWN over guessing.`
        : `Say which half of the test case is stale, because it decides the repair:

${surfaceDefinitionBlock()}

${surfaceAxisAside("TEST_DRIFT")}`
  }

Omit \`surface\` for PRODUCT_BUG, ENVIRONMENT and UNKNOWN — they are not about the test case at all.

## Available blocks

A spec step may be \`include: <block-name>\` instead of an inline action, running that block's own steps. Confirm the block exists under \`.ccqa/blocks/<name>/spec.yaml\` and that every \`params\` key the step passes is declared on it — either mismatch is SPEC_CHANGE, not TEST_DRIFT.

${formatBlockList(blocks)}

## You have read-only filesystem tools

You can call \`Grep\`, \`Glob\`, and \`Read\` against the current repository (post-change state) before producing the JSON. Use them to:
- pick the concrete strings each side of the test case names — the spec's \`expected\` texts, aria-labels, placeholders, button labels, route paths, and the generated code's selectors, roles, texts and URLs — and grep the source for each. Check **both** sides: clearing the test case because the easier one checked out is the common way to miss a stale surface,
- when a string is gone, look for what replaced it before concluding — where it went is what decides the label,
- read the changed files in full when the truncated patch is not enough.

${
    baselineMissing
      ? `There is no diff range for this run, so the \`${CHANGED_FILE_DIFF_TOOL}\` tool has nothing to return — every conclusion must come from the current source state plus the failure evidence.`
      : `You can also call \`${CHANGED_FILE_DIFF_TOOL}\` with a file path to fetch that file's diff hunk for this run's base...HEAD range. The inline patch below may be truncated — a file cut or dropped by the truncation still appears in "Changed files (name-status)" but its hunk is not inlined. Before blaming (or ruling out) such a file, fetch its diff with this tool; Read only shows you its post-change state, not what changed.`
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

- The selector, string or route the failing step names is absent from the source, and the flow it belongs to still exists → TEST_DRIFT, naming where it moved to.
- The flow the spec describes is no longer implemented at all → SPEC_CHANGE.
- The observed behavior is wrong (error response, missing side effect, wrong data) while the source still means to produce the right one → PRODUCT_BUG.
- The failure log names an external cause directly — connection refused, 401/403 on a dependency, a missing env var, an empty fixture — → ENVIRONMENT, naming it.
- Without diff evidence, treat 0.7 as a practical confidence ceiling unless the current source alone is conclusive.`
      : `${
          lastGreen
            ? `The baseline is the commit where THIS spec last passed, so the range strictly covers the window in which it broke: the cause is either inside these changes or outside the code entirely (flaky timing, environment, an external service, test data). The range may mix several unrelated merges — most of the diff is noise; what matters is the specific change you can tie to the failing step.`
            : `The baseline is a fixed ref (typically the PR base): the spec is NOT guaranteed to have passed there, so the range is not guaranteed to contain the cause.`
        }

- Diff renames or moves an identifier the test reaches for, and the flow around it is intact → TEST_DRIFT, on the surface that names it.
- Diff reworks or removes the flow the spec describes → SPEC_CHANGE, citing the hunk that shows the new shape.
- Diff breaks behavior the spec still intends — a refactor that drops a side effect, an inverted condition, a regression hiding inside a cleanup commit — → PRODUCT_BUG, citing the hunk.
- Nothing in the diff reaches the failing step and the log points outside the code → ENVIRONMENT, naming the external thing; UNKNOWN if you cannot name it.
${
          lastGreen
            ? `- No change in the range explains the failing step (after checking the inline patch, the name-status list, and any hunks you fetched) → the cause is outside the code: ENVIRONMENT when you can name the external thing, UNKNOWN with low confidence when you cannot. Do NOT default to PRODUCT_BUG here — under this baseline a product regression must be tied to an in-range change.`
            : `- Diff is unrelated to the failing step (or there is no relevant diff) and the test was passing before → lean PRODUCT_BUG; first rule out timing/data flakiness and infrastructure errors (daemon not running, network down, missing credentials) — those are ENVIRONMENT when nameable and UNKNOWN when not, never PRODUCT_BUG.`
        }${
          range
            ? `
- This range spans ${range.commitCount} commit${range.commitCount === 1 ? "" : "s"} over ${range.days} day${range.days === 1 ? "" : "s"}. The wider the range, the more unrelated changes are mixed in: every label still requires citing the specific hunk — do not infer intent from the bulk of a large diff, and lower confidence when the evidence is spread thin.`
            : ""
        }`
  }

## Sub-diagnosis vocabulary

Alongside the label, report the closest fine-grained mechanic:
- SELECTOR_DRIFT — a selector or string was renamed; usually under TEST_DRIFT
- OVER_ASSERTION — the test asserts something narrower than the product ever promised; usually under TEST_DRIFT
- TIMING_ISSUE — usually under ENVIRONMENT
- DATA_MISSING — missing test data/state; usually ENVIRONMENT
- NONE — when nothing fits (typical for PRODUCT_BUG and SPEC_CHANGE)

${triageUserPromptBlock}${customPromptBlock}## Output

Your **final** assistant message must start with \`{\` and end with \`}\` — a single JSON object, nothing before or after. No prose preamble, no markdown fences, no tool calls in the same turn.

{
  "label": "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG" | "ENVIRONMENT" | "UNKNOWN",
  "confidence": <0.0-1.0>,
  "surface": "spec" | "generated",
  "subDiagnosis": "SELECTOR_DRIFT" | "TIMING_ISSUE" | "OVER_ASSERTION" | "DATA_MISSING" | "NONE",
  "headline": "<ONE short sentence stating what broke and where, max ~80 chars>",
  "evidence": [
    { "file": "<file:line or diff hunk reference, omit if log-only>", "detail": "<what THIS specific file/hunk directly proves about the failure, max ~120 chars>" }
  ],
  "recommendation": "<ONE imperative sentence: the concrete next action a reviewer should take>",
  "reasoning": "<optional longer paragraph — only used when a reviewer drills down>"
}

Omit \`surface\` entirely unless the label is TEST_DRIFT or SPEC_CHANGE.

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

Evidence rules: TEST_DRIFT and SPEC_CHANGE each need at least one \`evidence\` entry with a real \`file\` — a stale-test-case verdict with no citation is a guess wearing a verdict's clothes, so answer UNKNOWN instead. ENVIRONMENT requires naming the external thing. ${
    baselineMissing
      ? "With no baseline there is no in-range change to cite: PRODUCT_BUG must instead explain why current-state inspection rules out a stale test case."
      : `PRODUCT_BUG should cite the in-range change that unintentionally broke the behavior when one exists; ${lastGreen ? "under this last-green baseline, if no in-range change explains the failure, the cause is outside the code — ENVIRONMENT when nameable, UNKNOWN when not" : "when no such change exists, explain why the diff does NOT account for the failure"}.`
  }

## Test Spec (spec.yaml)
${specYaml}

${executionBlock}

${diffBlock}`;
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
    sections.push(`## Generated test code — the \`generated\` surface (with line numbers)
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
