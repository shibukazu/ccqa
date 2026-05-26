import type { TraceAction } from "../types.ts";

export interface DiagnosePromptInput {
  script: string;
  specYaml: string;
  actions: TraceAction[];
  failureLog: string;
  /** Optional: accessibility-tree dump from agent-browser captured right after the failure. */
  pageSnapshot?: string;
  /**
   * BCP-47-ish hint for the language to use in human-readable fields
   * (`reasoning`, `reason`). Common values: "en", "ja". Defaults to "auto",
   * which injects no language directive and lets Claude follow the language
   * of the spec/source under analysis.
   * Note: keys, types, selectors, and code identifiers stay in their
   * original form regardless.
   */
  outputLanguage?: string;
}

export function buildDiagnosePrompt(input: DiagnosePromptInput): string {
  const { script, specYaml, actions, failureLog, pageSnapshot, outputLanguage = "auto" } = input;

  const numbered = script
    .split("\n")
    .map((l, i) => `${i + 1}: ${l}`)
    .join("\n");

  const actionsSummary = actions
    .map((a, i) => {
      const parts = [`${i + 1}. ${a.command}`];
      if (a.assertType) parts.push(`assertType="${a.assertType}"`);
      if (a.selector) parts.push(`selector="${a.selector}"`);
      if (a.value) parts.push(`value="${a.value}"`);
      if (a.observation) parts.push(`→ ${a.observation}`);
      return parts.join(" ");
    })
    .join("\n");

  const languageBlock =
    outputLanguage === "auto"
      ? ""
      : `## Output language

Write all human-readable fields (\`reasoning\`, \`reason\`) in **${outputLanguage}** (BCP-47 tag).
Selectors, file paths, identifiers, code, type names (TIMING_ISSUE, etc.), JSON keys, and quoted strings stay verbatim regardless of language.

`;

  return `You are diagnosing a failing E2E test. The test was generated from a recorded trace of the original interaction. Compare the failing run against the original spec and recorded actions to determine WHY the test failed and what the right fix is.

${languageBlock}## You have read-only filesystem tools

You can call \`Grep\`, \`Glob\`, and \`Read\` against the current repository before producing the JSON.

For SELECTOR_DRIFT specifically the failure log is usually NOT enough on its own — the runner only reports "selector X not visible". To confirm a rename, search the application source for the *type* of selector that's failing:

- For \`[aria-label='OLD']\` failures: \`Grep\` for \`aria-label=\` (or i18n key \`OLD\`) in the app source. If you find a near-miss like \`aria-label="NEW"\` whose text is a superset/rephrase of the failing label, that is your evidence.
- For \`[placeholder='OLD']\` failures: \`Grep\` for \`placeholder=\`.
- For \`[role='OLD']\` or \`[data-testid='OLD']\`: same pattern.
- For \`text=OLD\` failures: \`Grep\` the source / i18n bundles for \`OLD\`. Locale files (\`*.json\`, \`*.yml\`, \`messages.ts\`, etc.) often hold the canonical strings.

You have **up to 10 tool turns**. Spend them on grep/read; do not loop. Only when you have concrete file:line evidence should you emit SELECTOR_DRIFT — otherwise prefer UNKNOWN with confidence < 0.4 and let the human decide.

Do NOT attempt to write, edit, run shell commands, or hit the network. Only Grep/Glob/Read.

## Diagnosis categories

Pick exactly ONE category. The output JSON must follow the shape for that category.

1. TIMING_ISSUE — element not yet present because the page hasn't loaded / navigated. Fix by inserting or extending sleeps.
   {
     "diagnosis": {
       "type": "TIMING_ISSUE",
       "fixes": [
         { "kind": "insert", "line": <1-based>, "seconds": <int>, "reason": "<short>" },
         { "kind": "increase", "line": <1-based of existing sleep>, "increase_to": <int>, "reason": "<short>" }
       ]
     },
     "confidence": <0.0-1.0>,
     "reasoning": "<why timing is the cause>"
   }

2. OVER_ASSERTION — the test is asserting something the spec never required, OR a recorded assertion that is environment-dependent (e.g. a placeholder text that varies). The right fix is to remove those lines from the test.
   {
     "diagnosis": {
       "type": "OVER_ASSERTION",
       "lines": [<1-based line numbers to remove>],
       "reason": "<short>"
     },
     "confidence": <0.0-1.0>,
     "reasoning": "<why this assertion isn't required by the spec>"
   }

3. SELECTOR_DRIFT — the page is healthy but a selector has been renamed/refined since the trace was recorded. The failure log will typically contain a snapshot showing the new selector. ONLY use this when you can name the exact replacement selector.
   {
     "diagnosis": {
       "type": "SELECTOR_DRIFT",
       "line": <1-based>,
       "oldSelector": "<exact string in current line>",
       "newSelector": "<exact replacement>",
       "reason": "<short>"
     },
     "confidence": <0.0-1.0>,
     "reasoning": "<evidence from failure log>"
   }

4. DATA_MISSING — the test depends on data (a record, a setup, a logged-in state) that no longer exists. Not auto-fixable; the human must reseed or update the spec.
   {
     "diagnosis": { "type": "DATA_MISSING", "reason": "<what is missing>" },
     "confidence": <0.0-1.0>,
     "reasoning": "<evidence>"
   }

5. UNKNOWN — none of the above fit, or evidence is too weak to choose.
   {
     "diagnosis": { "type": "UNKNOWN", "reason": "<short>" },
     "confidence": <0.0-1.0>,
     "reasoning": "<what you saw and why you can't classify>"
   }

## Confidence guidance

- 0.9-1.0: failure log directly shows the cause (e.g. "selector X not found, snapshot lists Y" → SELECTOR_DRIFT)
- 0.7-0.9: strong indirect evidence (e.g. timing pattern after navigation, or assertion text that doesn't appear in spec)
- 0.4-0.7: plausible classification but multiple categories could explain it
- < 0.4: prefer UNKNOWN over guessing

## Rules

- Your **final** assistant message must start with \`{\` and end with \`}\` — a single JSON object, nothing before or after. No prose preamble like "Confirmed: ...", no markdown fences, no commentary, no tool calls in the same turn. If you have an analysis sentence, put it in the \`reasoning\` field.
- Line numbers refer to the numbered test script below (1-based).
- For SELECTOR_DRIFT, \`oldSelector\` must match a substring of the script at that line; \`newSelector\` must be backed by a concrete file:line you read with Grep/Read (do not invent). Cite the evidence in \`reasoning\`.
- For OVER_ASSERTION, only include lines that contain assert calls (\`abAssert*\`) or existence-checking waits (\`abWait\`); a recorded \`abWait("[selector]")\` is an implicit existence assertion and a valid removal candidate when the spec never required that element to be present.
- Cross-check assertions against the spec YAML. If the spec doesn't require the assertion, OVER_ASSERTION is the better diagnosis than SELECTOR_DRIFT.

## Test Spec (spec.yaml)
${specYaml}

## Recorded Actions (actions.json summary)
${actionsSummary}

## Test Script (with line numbers)
${numbered}

## Failure Log
${failureLog.slice(0, 4000)}${pageSnapshot ? formatPageSnapshot(pageSnapshot) : ""}`;
}

/**
 * Page snapshot captured by ccqa right after the failure (agent-browser
 * accessibility tree). When present, it usually decides SELECTOR_DRIFT vs
 * TIMING_ISSUE: a near-miss aria-label / role / placeholder in the
 * snapshot is direct evidence of a rename, while a tree that doesn't
 * contain the failing locator at all (without a near-miss) points to a
 * still-loading page or genuinely missing element.
 */
function formatPageSnapshot(snapshot: string): string {
  return `

## Page Snapshot (accessibility tree captured right after the failure)

This is the live state of the page when the test failed. Prefer this over your own assumptions:

- If a near-miss of the failing selector appears here (e.g. failing \`[aria-label='A']\` and snapshot contains \`aria-label="A-prime"\`), that is direct evidence of SELECTOR_DRIFT — propose the snapshot's value as \`newSelector\`.
- If the failing locator is genuinely absent and no near-miss exists, the page may be still loading (TIMING_ISSUE) or the spec is asserting something not on this page (OVER_ASSERTION / DATA_MISSING).
- If the snapshot looks unrelated to the spec (e.g. error page, login wall), DATA_MISSING is likely.

\`\`\`
${snapshot}
\`\`\``;
}
