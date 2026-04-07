import type { TraceAction } from "../types.ts";

export function buildAutoFixPrompt(script: string, failureLog: string): string {
  return `You are analyzing a failing E2E test script. The test fails because some browser actions execute before the page has finished loading or navigating.

Your task: identify which line numbers need a sleep/wait inserted BEFORE them to fix timing issues.

## Rules
- ONLY identify lines where a sleep is needed — do NOT suggest any other changes
- Common patterns that need a sleep:
  - After \`ab("open", ...)\` when the next line interacts with elements (fill, click, etc.)
  - After \`ab("press", "Enter")\` or \`ab("click", ...)\` when a page navigation occurs before the next action
  - After any action that triggers a redirect or page reload
- Look at the error log to identify WHICH lines failed, then determine if a sleep before that line would fix it
- If a \`spawnSync("sleep", ...)\` already exists before a failing line, suggest increasing its duration instead
- Output ONLY a JSON array of objects, no explanation, no markdown code fences

## Output format
Each object has:
- "line": the 1-based line number to insert a sleep BEFORE
- "seconds": recommended sleep duration (typically 3-5)
- "reason": very short explanation (e.g., "page navigation after form submit")

If a sleep already exists and needs to be increased:
- "line": the line number of the existing sleep
- "increase_to": the new duration in seconds
- "reason": explanation

Example output:
[{"line": 15, "seconds": 3, "reason": "page navigation after press Enter"}, {"line": 22, "increase_to": 5, "reason": "slow page load"}]

If no fixes are needed, return: []

## Test Script (with line numbers)
${script.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")}

## Failure Log
${failureLog.slice(0, 3000)}`;
}

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
