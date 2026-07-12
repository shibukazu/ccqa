import type { RecordedAction } from "../types.ts";

export function buildCleanupPrompt(actions: RecordedAction[]): string {
  const lines = actions
    .map((a, i) => {
      const parts = [`${i + 1}. ${a.action}`];
      if (a.assert) parts.push(`assert="${a.assert}"`);
      if (a.locator) parts.push(`locator=${JSON.stringify(a.locator)}`);
      if (a.index !== undefined) parts.push(`index=${JSON.stringify(a.index)}`);
      if (a.value) parts.push(`value="${a.value}"`);
      if (a.observation) parts.push(`→ ${a.observation}`);
      return parts.join(" ");
    })
    .join("\n");

  return `You are given a list of browser actions recorded during an E2E test trace.
The trace contains noise: failed attempts, redundant retries, and duplicate operations recorded because the agent explored multiple strategies.

Your task: return a **cleaned-up JSON array** of RecordedAction objects that represents the minimal, correct sequence of actions needed to reproduce the test.

Each RecordedAction object has the following shape (use EXACTLY these field names):
{ "action": "...", "assert": "...", "locator": { "by": "...", "value": "...", "name": "...", "exact": true },
  "index": "first" | "last" | 0, "value": "...", "label": "...", "observation": "..." }

Only include fields that are present in the original action. The "action" field is required. For assert actions, "assert" is also required.

**The \`locator\` object (together with \`index\` when present) is one atomic unit:**
When you keep an action, you MUST copy its \`locator\` (every sub-field: \`by\`, \`value\`, \`name\`, \`exact\`) and \`index\` from the original **verbatim** — dropping or editing any part silently corrupts the recorded selector and the generated test will be broken. Treat them as keep-all-or-drop-all.

Rules:
- Remove actions that were failed attempts superseded by a later successful action (e.g., if a fill whose locator value is "text=Foo" was followed by a fill whose locator value is "[placeholder='Foo']", keep only the latter)
- Remove duplicate fill operations on the same field (keep only the last successful fill for each field)
- For "click" and "fill" actions with a "css" locator: if the locator value starts with \`text=\`, it is a failed attempt — remove it (text= selectors only work with the wait command, not click/fill)
- If multiple actions of the same kind use a semantic locator (\`by\` other than "css") or an \`index\` within the same logical step (the agent tried several locators), keep ONLY the last one — that is the one that finally succeeded
- Keep all snapshot actions — they serve as comments/observations in the generated test
- Keep all assert actions — they are the test's verification points and must not be removed
- Do NOT invent new actions or change values
- Output ONLY a valid JSON array, no explanation, no markdown code fences

## Recorded Actions
${lines}`;
}
