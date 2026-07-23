import { buildDraftPrompt, buildDraftSystemPrompt, type AvailableBlock } from "./draft.ts";

export function buildDriftSystemPrompt(blocks: AvailableBlock[]): string {
  return `${buildDraftSystemPrompt(blocks)}

## Drift mode

You are running non-interactively in CI. The user will not see or apply the patch — only the \`issues\` array.

- Always set \`patch\` to "" in your response.
- Focus issue messages on what is **out of sync** between the spec and the current codebase: missing aria-labels, renamed routes, removed buttons, placeholders that no longer exist, include references that point to non-existent blocks.
- Do NOT raise issues about stylistic preferences in the spec wording.
- Treat \`category: unimplemented\` as the primary signal for drift: anything the spec asserts that you cannot find in code is a drift finding.

## Drift severity policy (STRICT)

The CLI exits non-zero when any issue has \`severity: "ERROR"\` (default) or — with \`--severity warn\` — when any \`WARN\` is present. Pick severity by **whether executing this spec's checks against today's product would fail** (whichever tool runs it — a vitest replay, a Playwright run, a runn runbook), not by how confident you are in your own analysis.

### CRITICAL: spec ↔ source mismatch is ERROR, not "vague phrasing" WARN

The most common false negative is treating a concrete spec/source mismatch as a WARN about "expected phrasing." It is not. Apply this decision rule **before** picking severity:

1. **Pick the concrete strings the spec asserts** in each step's \`expected\` (visible text, aria-labels, button labels, route paths). For \`expected\` like "the Dashboard page is visible", the spec is asserting that the literal string "Dashboard" — or the page conceptually identified by that label — is rendered.
2. **Search the source** for those exact strings (\`Grep\` / \`Read\`) at the location the step references (the relevant page/component/route).
3. Classify:
   - **ERROR** — the source instead renders a *different* string in that location (e.g. spec says "Dashboard", the breadcrumb in \`DashboardPage.tsx\` now renders "Overview"). Executing the spec against the current source would fail; executing it against a stale staging environment would pass and *hide* the drift — exactly the case drift CI exists to catch. Cite both sides in \`detail\`: the spec line and the file:line of the source mismatch.
   - **WARN (vague phrasing)** — the source's actual string IS present somewhere relevant; the \`expected\` just paraphrases it more loosely (e.g. spec says "the Save button is visible" and the source has both visible "Save" text and \`aria-label="Save"\`). Replay still passes; the spec could just be tightened.
   - **OK** — the spec's exact string appears in source at the relevant location.

Use **ERROR** when the spec would break when executed against today's product:
- A selector the spec relies on (\`aria-label\`, \`placeholder\`, \`data-testid\`, button text) **does not exist anywhere in the source**.
- A URL / route the spec navigates to is no longer defined.
- An \`expected\` asserts a string or visible text that is no longer rendered by the relevant component.
- The source renders a *different* string in the place the spec describes (per the decision rule above).
- An \`include\` step references a block that does not exist under \`.ccqa/blocks/<name>/spec.yaml\`, or a \`params\` key is not declared on that block.
- The spec references a feature/page that has been removed from the codebase.

Use **WARN** when the spec is still likely to work, but quality could improve:
- The \`expected\` paraphrases a string that **still exists** in source (the literal target is findable, just imprecisely worded).
- A step bundles multiple actions, or a needed intermediate verification step is missing.
- Stable signals exist that the spec could leverage but currently doesn't.
- You are unsure whether a referenced string exists (give the user the benefit of the doubt; do not hard-fail CI on uncertainty).

Use **OK** for axes you actively verified and found no issue.

If you cannot decide between ERROR and WARN, choose WARN. Reserve ERROR for findings you can back up with a specific file path or grep result that proves the drift.

Conversely: when you DO have a citation showing a concrete spec/source mismatch (per the decision rule above), you MUST use ERROR — "vague phrasing" WARN is not a safe fallback for an actual drift.
`;
}

export function buildDriftUserPrompt(existing: string): string {
  return buildDraftPrompt({ mode: "refine", existing, userInput: "" });
}
