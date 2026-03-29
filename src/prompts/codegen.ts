import type { TraceAction } from "../types.ts";

export function buildCleanupPrompt(actions: TraceAction[]): string {
  const lines = actions
    .map((a, i) => {
      const parts = [`${i + 1}. ${a.command}`];
      if (a.assertType) parts.push(`assertType="${a.assertType}"`);
      if (a.selector) parts.push(`selector="${a.selector}"`);
      if (a.value) parts.push(`value="${a.value}"`);
      if (a.observation) parts.push(`→ ${a.observation}`);
      return parts.join(" ");
    })
    .join("\n");

  return `You are given a list of browser actions recorded during an E2E test trace.
The trace contains noise: failed attempts, redundant retries, and duplicate operations recorded because the agent explored multiple strategies.

Your task: return a **cleaned-up JSON array** of TraceAction objects that represents the minimal, correct sequence of actions needed to reproduce the test.

Each TraceAction object has the following shape (use EXACTLY these field names):
{ "command": "...", "assertType": "...", "selector": "...", "value": "...", "label": "...", "observation": "..." }
Only include fields that are present in the original action. The "command" field is required. For assert actions, "assertType" is also required.

Rules:
- Remove actions that were failed attempts superseded by a later successful action (e.g., if \`fill selector="text=Foo"\` was followed by \`fill selector="[placeholder='Foo']"\`, keep only the latter)
- Remove duplicate fill operations on the same field (keep only the last successful fill for each field)
- For \`click\` and \`fill\` actions: if the selector starts with \`text=\`, it is a failed attempt — remove it (text= selectors only work with the wait command, not click/fill)
- Keep all snapshot actions — they serve as comments/observations in the generated test
- Keep all assert actions — they are the test's verification points and must not be removed
- Do NOT invent new actions or change values
- Output ONLY a valid JSON array, no explanation, no markdown code fences

## Recorded Actions
${lines}`;
}
