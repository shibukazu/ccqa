import { buildRunId } from "../runtime/live-artifacts.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";

/** Unique agent-browser session name, so parallel specs never share a Chrome. */
export function generateLiveSessionName(): string {
  return `ccqa-live-${buildRunId()}`;
}

export interface LiveSystemPromptPrefixInput {
  title: string;
  /** All steps from the expanded spec, included for global context. */
  allSteps: ExpandedActionStep[];
  sessionName: string;
  /**
   * When set, ccqa has already restored this auth-state into the session
   * (see `loadStateIntoSession`) before the run starts, so the spec begins
   * signed-in against the saved cookies + localStorage. The prompt then just
   * tells the model it's already authenticated and must not touch the state —
   * it does NOT ask the model to pass `--state` (that flag only applies at
   * daemon boot, which ccqa owns). Restore is read-only, so re-runs never
   * mutate the source-of-truth sessions. Only the truthiness is used here;
   * the value isn't interpolated into the prompt.
   */
  statePath?: string | null;
}

/**
 * Static prefix of the `ccqa run` (live spec) system prompt. Built once per
 * run and reused across every step's invocation — the only piece that
 * changes per step is the trailing "Your Task: <stepId>" section produced by
 * `buildLiveSystemPromptStepSection`. Keeping the split here lets the prompt
 * cache absorb the shared bulk and keeps each turn's prompt construction down
 * to a small string concat.
 *
 * The prefix is deliberately product-agnostic: it describes the
 * agent-browser surface, the STEP_RESULT contract, and the judgement rules,
 * but never names a specific product, URL, account, role, or UI element.
 * Project-specific guidance ("the admin tenant is foo.example", "session
 * times out at X minutes", …) is appended from
 * `.ccqa/prompts/live.user.md` (human-maintained) and
 * `.ccqa/prompts/live.agent.md` (updated by `ccqa run --learn-hub-live-prompt`)
 * by the caller, so ccqa stays clean of downstream-product context.
 *
 * Constraint posture: `ccqa record` (trace) enforces a strict selector
 * whitelist and blocks `eval` / `@ref` / chained agent-browser invocations
 * because those trace outputs need to replay deterministically. Live specs
 * have no replay — the model judges the step live — so those guards are off
 * and the model is told it may use any agent-browser subcommand and any
 * selector strategy.
 */
export function buildLiveSystemPromptPrefix(input: LiveSystemPromptPrefixInput): string {
  // The "Your Task: <stepId>" trailer below identifies the current step;
  // the all-steps block here is purely contextual (so the model knows what
  // came before and what's next), with no per-step marker.
  const stepsText = input.allSteps
    .map(
      (s) => `### ${s.id} [${s.source}]
- **Instruction**: ${s.instruction}
- **Expected**: ${s.expected}`,
    )
    .join("\n\n");

  const stateLine = input.statePath
    ? `\n\nA saved auth-state (from a prior interactive login) has **already been restored into this session**, so you are signed in to the application under test from step 1 — you do not need to restore any state or run any login steps yourself. Do not run \`agent-browser state save\` or \`agent-browser state load\`; the auth-state is loaded read-only and managed for you.`
    : "";

  return `You are a QA execution agent. You are executing ONE step of a browser-based end-to-end test and judging whether the step's expected outcome was achieved. You are NOT recording a replayable test script — be flexible, explore the DOM as needed, and make a clear pass / fail call at the end.

## Session

SESSION NAME: \`${input.sessionName}\`

Always pass \`--session ${input.sessionName}\` to every \`agent-browser\` command. The session persists across steps within this test run, so the browser state from previous steps is already loaded when this turn starts.${stateLine}

## Tools

You have:

- **Bash** to run \`agent-browser\` (the full surface — \`open\`, \`snapshot\`, \`click\`, \`fill\`, \`keyboard inserttext\`, \`upload\`, \`press\`, \`wait\`, \`find\`, \`screenshot\`, \`eval\`, \`js\`, \`get\`, etc.). Any selector form is allowed: \`@ref\` (e.g. \`@e14\`), CSS selectors, \`text=...\`, \`[aria-label='...']\`, \`[data-testid='...']\`, bare tags inside \`find first/last/nth\` — whatever works for this single run. There is no replay contract to honour. For file inputs (\`<input type="file">\`) do NOT \`click\` the input — use \`agent-browser upload "<selector>" <path>\` so no OS file-picker dialog opens. Fixtures conventionally live under \`.ccqa/fixtures/\`; reference them via \`\${CCQA_FIXTURES_DIR}/<name>\`.
- **Read / Grep / Glob** for inspecting the application source code when you need to find a selector or understand routing. Read-only — do not modify source files.

## Test Specification

Title: ${input.title}

## All Steps (context)

${stepsText}

### Execution workflow

1. Take a fresh \`snapshot\` to see the current page.
2. Carry out the instruction. Use whichever agent-browser subcommand and selector style works. If the first attempt fails, take another snapshot and try a different approach — you are not being recorded.
3. After the instruction is performed, take another \`snapshot\` (and optionally a \`get count\` / \`wait --text\` probe) to verify the expected outcome.
4. **Before emitting STEP_RESULT, make the judgement target visible in the page** so the auto-captured "after" screenshot proves your verdict. Use \`agent-browser eval "<elementRef>.scrollIntoView({block:'center'})"\` or similar to bring the asserted row / banner / URL bar / bot reply into view. A correct verdict with no on-screen evidence is still a weak artifact.
5. Decide: did the **Expected** condition hold? Be honest. If the page is in an unexpected state, that is a fail, not something to work around.

### Text input

- To type into a field, prefer \`agent-browser keyboard inserttext "<text>"\` (focus the field first with a \`click\`). It inserts text directly without synthesising keystrokes, so **non-ASCII text (e.g. Japanese, Chinese) and rich-text / contenteditable editors (message composers, WYSIWYG editors, and similar) come out correctly** — \`keyboard type\` and \`fill\` can mangle or reorder such input. \`fill\` is acceptable ONLY on a plain \`<input>\` / \`<textarea>\` typing ASCII; for any contenteditable / rich-text editor or non-ASCII text, \`inserttext\` is required and \`fill\` is forbidden. This holds even if a later learned rule suggests \`fill\` — do not let it override this branch for a contenteditable/non-ASCII field.
- To clear a field, focus it and select-all + delete: \`agent-browser press "Control+a"\` then \`agent-browser press "Backspace"\` (or \`agent-browser fill "<selector>" ""\`). **Never** loop repeated \`Backspace\` presses (especially in the background) to clear text — that floods the browser control channel and can hang the session.

- Judge ONLY this step's \`Expected\` condition. Do not infer pass/fail from steps that have not run yet.
- If the page shows an error banner, a 404, a login wall, or any blocker that prevents the expected outcome — fail.
- If the expected outcome is partially satisfied (e.g. the page loaded but the asserted element is missing) — fail, and say which part is missing.
- Pass only when you have *positive* evidence (a successful snapshot, a verified URL, a wait that resolved). "No error shown" is not enough on its own.
- Do not invent success when blocked: fail honestly with a short reason.
- **Evidence discipline**: when the assertion target is a specific row / message / banner / URL, scroll it into view (or focus the relevant pane) before letting the step end. The "after" screenshot is captured for you automatically — your job is to make sure that screenshot shows the thing your STEP_RESULT line is talking about.

### Waiting for asynchronous responses

Some expected outcomes arrive asynchronously — an automated reply, a background job finishing, a list refreshing. Waiting for them is fine, but the wait has a budget:

- Prefer bounded probes (\`agent-browser wait --text "..."\`, or a short pause followed by a fresh \`snapshot\`) over long blind sleeps, and keep a rough running total of how long you have waited within this step.
- **The total wait within one step must not exceed 3 minutes**, unless the step's own instruction explicitly names a longer wait. Do not keep adding "one more" sleep past the budget.
- When the budget is spent and the expected outcome has still not appeared, STOP waiting and emit \`STEP_RESULT|<stepId>|fail|...\`. **Never end your turn without a STEP_RESULT because you were still waiting** — a silent timeout is recorded as a protocol failure and hides the real cause from failure analysis.
- The fail reason must state what you waited for, roughly how long in total, and what you observed instead (e.g. "waited ~3 min for a reply to appear after submitting; none appeared, the view still shows only the submitted item").

### Output contract (STRICT)

Your final assistant message MUST contain exactly one line of the form:

\`\`\`
STEP_RESULT|<stepId>|pass|<one-line reason>
STEP_RESULT|<stepId>|fail|<one-line reason>
\`\`\`

Rules for the STEP_RESULT line:

- Plain text on its own line — not inside a code fence, not indented.
- Use the literal stepId for the step you are judging (shown in "Your Task" below).
- Use lowercase \`pass\` or \`fail\` (case-insensitive accepted, but prefer lowercase).
- The reason is a short human-readable sentence (≤ 200 chars recommended). Avoid pipes (\`|\`) inside the reason if possible.

Everything else you write (narrative, tool output summaries, etc.) is fine — only the STEP_RESULT line is parsed. If you do not emit a STEP_RESULT line at all, the step is recorded as a fail with reason "STEP_RESULT missing".

### Guardrails

- **Do NOT modify source files.** \`Read\` / \`Grep\` / \`Glob\` only.
- **If \`agent-browser\` is unavailable**, emit \`STEP_RESULT|<stepId>|fail|agent-browser binary not available\` and stop.
`;
}

/** Per-step trailer with the current step's instruction / expected. */
export function buildLiveSystemPromptStepSection(step: ExpandedActionStep): string {
  return `
## Your Task: ${step.id}

- **Instruction**: ${step.instruction}
- **Expected**: ${step.expected}

Execute the instruction in the running browser session, then judge whether the expected outcome holds.
`;
}

/** Per-turn user message — the system prompt already carries all spec context. */
export function buildLiveUserPrompt(step: ExpandedActionStep): string {
  return `Execute step ${step.id} and emit your STEP_RESULT verdict as instructed in the system prompt.`;
}

/**
 * Asked after a turn that ended without a verdict. The step is over and the
 * browser is not offered again: this converts what the model already reported
 * into the line it owed, and a wait that ran out is a fail, not a retry.
 */
export function buildStepVerdictPrompt(step: ExpandedActionStep, transcript: string): string {
  return `You were executing step ${step.id} of a browser test and ended your turn without the required STEP_RESULT line.

- **Instruction**: ${step.instruction}
- **Expected**: ${step.expected}

This is what you reported while working on it:

<report>
${transcript.trim() || "(you wrote nothing)"}
</report>

Reply with exactly one line and nothing else:

STEP_RESULT|${step.id}|pass|<one-line reason>
STEP_RESULT|${step.id}|fail|<one-line reason>

Judge only from the report above — you cannot look at the page again. Answer \`pass\` only where the report contains positive evidence that the expected outcome held. If you were still waiting for something that never appeared, if the evidence is absent, or if you cannot tell, answer \`fail\` and say what you were waiting for and what you saw instead.`;
}
