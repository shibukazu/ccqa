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

The CLI exits non-zero when any issue has \`severity: "ERROR"\` (default) or — with \`--severity warn\` — when any \`WARN\` is present. Pick severity by **whether a deterministic replay of this spec would fail today**, not by how confident you are in your own analysis.

Use **ERROR** when the spec would break on replay:
- A selector the spec relies on (\`aria-label\`, \`placeholder\`, \`data-testid\`, button text) **does not exist anywhere in the source**.
- A URL / route the spec navigates to is no longer defined.
- An \`expected\` asserts a string or visible text that is no longer rendered by the relevant component.
- An \`include\` step references a block that does not exist under \`.ccqa/blocks/<name>/spec.yaml\`, or a \`params\` key is not declared on that block.
- The spec references a feature/page that has been removed from the codebase.

Use **WARN** when the spec is still likely to work, but quality could improve:
- The \`expected\` is vague ("a message appears") when a precise string exists in code.
- A step bundles multiple actions, or a needed intermediate verification step is missing.
- Stable signals exist that the spec could leverage but currently doesn't.
- You are unsure whether a referenced string exists (give the user the benefit of the doubt; do not hard-fail CI on uncertainty).

Use **OK** for axes you actively verified and found no issue.

If you cannot decide between ERROR and WARN, choose WARN. Reserve ERROR for findings you can back up with a specific file path or grep result that proves the drift.
`;
}

export function buildDriftUserPrompt(existing: string): string {
  return buildDraftPrompt({ mode: "refine", existing, userInput: "" });
}
