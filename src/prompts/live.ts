import { randomUUID } from "node:crypto";
import { buildRunId } from "../runtime/live-artifacts.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";

/**
 * Unique agent-browser session name. The runId is millisecond-precision wall
 * clock, so under `--concurrency > 1` two specs can start in the same
 * millisecond and collide; a random suffix guarantees each spec gets its own
 * Chrome session and state never bleeds across parallel runs.
 */
export function generateLiveSessionName(): string {
  return `ccqa-live-${buildRunId()}-${randomUUID().slice(0, 8)}`;
}

export interface LiveSystemPromptPrefixInput {
  title: string;
  /** All steps from the expanded spec, included for global context. */
  allSteps: ExpandedActionStep[];
  sessionName: string;
  /**
   * When set, the prompt instructs the model to forward `--state <path>` to
   * every `agent-browser` invocation so the spec starts already signed-in
   * against the cookies + localStorage saved at that path. The path is a
   * single state file even when several saved sessions were requested — ccqa
   * merges them upstream. The file is **read-only** — agent-browser's
   * `--state` flag loads it but never writes back to it, so a spec can be
   * re-run locally or in CI without mutating the source-of-truth sessions.
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
 * `.ccqa/prompts/live.agent.md` (updated by `ccqa run --update-agent-prompt`)
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
    ? `\n\nA pre-recorded auth-state file is provided at \`${input.statePath}\` (also in the env var \`CCQA_AB_STATE\`). **Always also pass \`--state "$CCQA_AB_STATE"\`** to every \`agent-browser\` command — this restores cookies and localStorage saved from a prior interactive login (one or more providers), so the user is already signed in to the application under test from step 1. The file is loaded read-only; do not run \`agent-browser state save\`.`
    : "";

  return `You are a QA execution agent. You are executing ONE step of a browser-based end-to-end test and judging whether the step's expected outcome was achieved. You are NOT recording a replayable test script — be flexible, explore the DOM as needed, and make a clear pass / fail call at the end.

## Session

SESSION NAME: \`${input.sessionName}\`

Always pass \`--session ${input.sessionName}\` to every \`agent-browser\` command. The session persists across steps within this test run, so the browser state from previous steps is already loaded when this turn starts.${stateLine}

## Tools

You have:

- **Bash** to run \`agent-browser\` (the full surface — \`open\`, \`snapshot\`, \`click\`, \`fill\`, \`upload\`, \`press\`, \`wait\`, \`find\`, \`screenshot\`, \`eval\`, \`js\`, \`get\`, etc.). Any selector form is allowed: \`@ref\` (e.g. \`@e14\`), CSS selectors, \`text=...\`, \`[aria-label='...']\`, \`[data-testid='...']\`, bare tags inside \`find first/last/nth\` — whatever works for this single run. There is no replay contract to honour. For file inputs (\`<input type="file">\`) do NOT \`click\` the input — use \`agent-browser upload "<selector>" <path>\` so no OS file-picker dialog opens. Fixtures conventionally live under \`.ccqa/fixtures/\`; reference them via \`\${CCQA_FIXTURES_DIR}/<name>\`.
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

### Judgement rules

- Judge ONLY this step's \`Expected\` condition. Do not infer pass/fail from steps that have not run yet.
- If the page shows an error banner, a 404, a login wall, or any blocker that prevents the expected outcome — fail.
- If the expected outcome is partially satisfied (e.g. the page loaded but the asserted element is missing) — fail, and say which part is missing.
- Pass only when you have *positive* evidence (a successful snapshot, a verified URL, a wait that resolved). "No error shown" is not enough on its own.
- Do not invent success when blocked: fail honestly with a short reason.
- **Evidence discipline**: when the assertion target is a specific row / message / banner / URL, scroll it into view (or focus the relevant pane) before letting the step end. The "after" screenshot is captured for you automatically — your job is to make sure that screenshot shows the thing your STEP_RESULT line is talking about.

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
