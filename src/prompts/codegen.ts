import type { TraceAction } from "../types.ts";

export function buildCleanupPrompt(actions: TraceAction[]): string {
  const lines = actions
    .map((a, i) => {
      const parts = [`${i + 1}. ${a.command}`];
      if (a.assertType) parts.push(`assertType="${a.assertType}"`);
      if (a.selector) parts.push(`selector="${a.selector}"`);
      if (a.value) parts.push(`value="${a.value}"`);
      if (a.findLocator) parts.push(`findLocator="${a.findLocator}"`);
      if (a.findValue) parts.push(`findValue="${a.findValue}"`);
      if (a.findName) parts.push(`findName="${a.findName}"`);
      if (a.findIndex !== undefined) parts.push(`findIndex=${a.findIndex}`);
      if (a.findExact) parts.push(`findExact=true`);
      if (a.observation) parts.push(`→ ${a.observation}`);
      return parts.join(" ");
    })
    .join("\n");

  return `You are given a list of browser actions recorded during an E2E test trace.
The trace contains noise: failed attempts, redundant retries, and duplicate operations recorded because the agent explored multiple strategies.

Your task: return a **cleaned-up JSON array** of TraceAction objects that represents the minimal, correct sequence of actions needed to reproduce the test.

Each TraceAction object has the following shape (use EXACTLY these field names):
{ "command": "...", "assertType": "...", "selector": "...", "value": "...", "label": "...", "observation": "...",
  "findLocator": "...", "findValue": "...", "findName": "...", "findIndex": 0, "findExact": true }

Only include fields that are present in the original action. The "command" field is required. For assert actions, "assertType" is also required.

**\`find_*\` actions (find_click / find_dblclick / find_fill / find_type / find_hover / find_focus / find_check / find_uncheck) are special:**
They do NOT use \`selector\`. They use \`findLocator\` + \`findValue\` (and optionally \`findName\` / \`findIndex\` / \`findExact\`). When you keep a \`find_*\` action, you MUST copy **every** \`find*\` field from the original verbatim — dropping any of them silently corrupts the recorded selector and the generated test will be broken. Treat the \`find*\` cluster as one atomic unit: keep all or drop all.

Rules:
- Remove actions that were failed attempts superseded by a later successful action (e.g., if \`fill selector="text=Foo"\` was followed by \`fill selector="[placeholder='Foo']"\`, keep only the latter)
- Remove duplicate fill operations on the same field (keep only the last successful fill for each field)
- For \`click\` and \`fill\` actions: if the selector starts with \`text=\`, it is a failed attempt — remove it (text= selectors only work with the wait command, not click/fill)
- For \`find_*\` actions: if multiple \`find_*\` of the same command were emitted within the same logical step (Claude tried several locators), keep ONLY the last one — that is the one that finally succeeded
- Keep all snapshot actions — they serve as comments/observations in the generated test
- Keep all assert actions — they are the test's verification points and must not be removed
- Do NOT invent new actions or change values
- Output ONLY a valid JSON array, no explanation, no markdown code fences

## Recorded Actions
${lines}`;
}
