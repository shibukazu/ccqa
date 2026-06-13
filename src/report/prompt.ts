import { numberLines, outputLanguageBlock } from "../prompts/format.ts";
import type { DraftIssue } from "../types.ts";
import { DRAFT_CATEGORY_LABEL } from "../types.ts";

/**
 * Bump on EVERY prompt change. Embedded in the report data and in exported
 * label JSON so accuracy numbers from different prompt iterations are never
 * silently mixed.
 */
export const ANALYSIS_PROMPT_VERSION = "2";

export interface FailureAnalysisPromptInput {
  script: string;
  specYaml: string;
  failureLog: string;
  /** Unified diff base...HEAD, already scoped to the spec's relatedPaths and truncated. */
  diffPatch: string | null;
  /** `git diff --name-status` output for the same range. */
  changedFiles: string | null;
  /** The resolved base ref the diff was taken against (for the model's framing only). */
  baseRef: string | null;
  /** Findings from the spec↔code drift audit (analyzeDrift), when it ran. */
  driftIssues: DraftIssue[] | null;
  /** BCP-47 tag or "auto" (no directive). Identifiers/labels stay verbatim regardless. */
  outputLanguage?: string;
}

export function buildFailureAnalysisPrompt(input: FailureAnalysisPromptInput): string {
  const {
    script,
    specYaml,
    failureLog,
    diffPatch,
    changedFiles,
    baseRef,
    driftIssues,
    outputLanguage = "auto",
  } = input;

  const numbered = numberLines(script);
  const languageBlock = outputLanguageBlock(
    outputLanguage,
    "`reasoning`, `detail`",
    "label names (TEST_DRIFT, etc.)",
  );

  const diffBlock = diffPatch
    ? `## Source changes since ${baseRef ?? "base"} (git diff, may be truncated)

### Changed files (name-status)
${changedFiles ?? "(unavailable)"}

### Patch
\`\`\`diff
${diffPatch}
\`\`\`
`
    : `## Source changes

No diff context is available (the base ref could not be resolved, or there are no changes). Classify from the failure log, the spec, and what you can read in the repository — and be correspondingly more conservative: prefer UNKNOWN over a confident SPEC_CHANGE/PRODUCT_BUG call without diff evidence.
`;

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

  return `You are analyzing a failing E2E regression test right after a source change landed. Your job is a root-cause CALL, not a fix: decide which of three categories explains the failure, using the source diff as your primary context.

${languageBlock}## The three categories

The question that separates them: **is the behavior the spec describes still what the product intends?**

1. TEST_DRIFT — what the spec verifies is unchanged; only the test code drifted from the source. Typical: a selector/aria-label/placeholder rename, a timing change, an over-tight assertion. The diff shows a change that is invisible to the user's intent but visible to the test.
2. SPEC_CHANGE — the thing being verified itself changed: the UI flow, the layout, the feature's intended behavior. The diff deliberately changes what the spec asserts. You MUST cite the diff hunk (file + what changed) as evidence for this label.
3. PRODUCT_BUG — neither of the above: the failure is not explained by the diff nor by test staleness. The product regressed.

If the evidence is too weak to choose, answer UNKNOWN — a wrong confident call is worse than an honest UNKNOWN, because humans grade these predictions to measure accuracy.

## You have read-only filesystem tools

You can call \`Grep\`, \`Glob\`, and \`Read\` against the current repository (post-change state) before producing the JSON. Use them to:
- confirm a suspected selector rename (grep for \`aria-label=\`, \`placeholder=\`, \`data-testid\`, i18n strings),
- read the changed files in full when the truncated patch is not enough,
- check whether the element/flow the spec describes still exists in the source.

You have **up to 12 tool turns**. Do NOT write, edit, run shell commands, or hit the network.

## Decision guidance

- Diff touches only attributes/identifiers the test selects on (labels, testids, class names, timing) while the user-visible flow is intact → TEST_DRIFT.
- Diff intentionally removes/reworks the UI or flow that a spec step verifies (component deleted, page restructured, copy redefined, feature flag flipped) → SPEC_CHANGE.
- Diff UNINTENTIONALLY breaks behavior the spec still intends — e.g. a refactor that drops a side effect, an inverted condition, a regression hiding inside a cleanup commit — → PRODUCT_BUG, citing the diff hunk as evidence. A product bug is often introduced BY the diff; what separates it from SPEC_CHANGE is intent: does the change read as a deliberate redesign of what the spec verifies, or as collateral damage?
- Diff is unrelated to the failing step (or there is no relevant diff) and the test was passing before → lean PRODUCT_BUG; first rule out timing/data flakiness and infrastructure errors (daemon not running, network down, missing credentials) — those read as UNKNOWN with low confidence, not PRODUCT_BUG.
- The drift audit findings (when present) flag spec↔code mismatches; an ERROR there usually supports TEST_DRIFT or SPEC_CHANGE over PRODUCT_BUG.

## Sub-diagnosis vocabulary

Alongside the label, report the closest fine-grained mechanic:
- SELECTOR_DRIFT, TIMING_ISSUE, OVER_ASSERTION — usually under TEST_DRIFT
- DATA_MISSING — missing test data/state; usually UNKNOWN or PRODUCT_BUG depending on cause
- NONE — when nothing fits (typical for SPEC_CHANGE and PRODUCT_BUG)

## Output

Your **final** assistant message must start with \`{\` and end with \`}\` — a single JSON object, nothing before or after. No prose preamble, no markdown fences, no tool calls in the same turn.

{
  "label": "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG" | "UNKNOWN",
  "confidence": <0.0-1.0>,
  "subDiagnosis": "SELECTOR_DRIFT" | "TIMING_ISSUE" | "OVER_ASSERTION" | "DATA_MISSING" | "NONE",
  "evidence": [
    { "file": "<file:line or diff hunk reference, omit if log-only>", "detail": "<what this shows>" }
  ],
  "reasoning": "<why this label, citing the evidence>"
}

## Confidence guidance

- 0.9-1.0: the diff (or a file you read) directly shows the cause
- 0.7-0.9: strong indirect evidence
- 0.4-0.7: plausible but another category could explain it
- < 0.4: answer UNKNOWN instead of guessing

Evidence rules: TEST_DRIFT and SPEC_CHANGE require at least one concrete \`file\` reference (diff hunk or file:line you actually read). PRODUCT_BUG should explain why the diff does NOT account for the failure.

## Test Spec (spec.yaml)
${specYaml}

## Test Script (with line numbers)
${numbered}

${diffBlock}
${driftBlock}## Failure Log
${failureLog.slice(0, 8000)}`;
}
