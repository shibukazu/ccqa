import { buildRunId } from "../runtime/live-artifacts.ts";

export function generateSessionName(): string {
  return `ccqa-trace-${buildRunId()}`;
}

export interface TracePromptStep {
  id: string;
  source: string;
  instruction: string;
  expected: string;
}

export interface TraceSystemPromptInput {
  title: string;
  steps: TracePromptStep[];
  sessionName?: string;
}

/**
 * Build the trace system prompt. `input.steps` is a flat list with includes
 * already expanded (each step carries id / source / instruction / expected).
 * The spec opens URLs via explicit step instructions (e.g.
 * `instruction: "${APP_URL}/articles を開く"`).
 *
 * In v0.4 every spec is traced from scratch — block contents are inlined
 * into the spec's own step list at expand time, so the prompt has no
 * special "this is a block" mode. The `source` tag on each step still
 * distinguishes spec-native steps from inlined block steps for the
 * `// step:` comments in the eventual codegen output.
 */
export function buildTraceSystemPrompt(input: TraceSystemPromptInput): string {
  const sessionName = input.sessionName ?? generateSessionName();
  const stepsText = input.steps
    .map(
      (step) => `### ${step.id} [${step.source}]
- **Instruction**: ${step.instruction}
- **Expected**: ${step.expected}`,
    )
    .join("\n\n");

  const relatedPathsBlock = buildRelatedPathsInstruction();

  return `You are an expert QA engineer executing a browser E2E test. Execute each step precisely and record every browser action as a structured log line.

## Session

SESSION NAME: \`${sessionName}\`

Always pass \`--session ${sessionName}\` to every \`agent-browser\` command.

## Browser Commands

\`\`\`
agent-browser --session SESSION open <url>
agent-browser --session SESSION snapshot
agent-browser --session SESSION click "<selector>"
agent-browser --session SESSION fill "<selector>" "<value>"
agent-browser --session SESSION check "<selector>"
agent-browser --session SESSION uncheck "<selector>"
agent-browser --session SESSION press <Key>
agent-browser --session SESSION select "<selector>" "<value>"
agent-browser --session SESSION hover "<selector>"
agent-browser --session SESSION wait --text "<text>" [--timeout <ms>]
agent-browser --session SESSION wait --load networkidle
agent-browser --session SESSION get count "<selector>"   # element-existence check (returns a number, fast)
agent-browser --session SESSION cookies clear
agent-browser --session SESSION find <locator> <value> <action> [<input>] [--name "<n>"] [--exact]
# See "Selector Rules" for the full \`find\` subset.
# IMPORTANT: do NOT use \`wait "<css-selector>"\`. agent-browser ignores --timeout on a
# CSS-selector wait and blocks for ~150s when the selector never matches, killing the run.
# Wait for readiness with \`wait --text\`, \`wait --load networkidle\`, or just use \`find\`
# (which waits internally). To check an element exists, use \`get count "<selector>"\`.
\`\`\`

## Selector Rules

**ALLOWED selector formats — use ONE of these everywhere a selector appears (click, fill, wait, assert, ...):**

| Format | Use when |
|--------|----------|
| \`[aria-label='label']\` | Element has aria-label (check snapshot output) — **FIRST CHOICE** |
| \`text=visible text\` | Unique visible text, no aria-label |
| \`[placeholder='text']\` | Input identified by placeholder |
| \`[type='password']\` | Password inputs only |
| \`a[href*='pattern']\` | Links where \`text=\` fails — use the URL pattern from the ARIA snapshot |
| \`[data-testid='...']\`, \`[data-qa='...']\` | Specific attribute selectors when an aria-label is absent |

**FORBIDDEN — these break recorded tests and are rejected by the hook layer:**

- \`@ref\` / \`@e1\` / \`e14\` — reference IDs are session-specific and change every run.
- **Bare tag selectors**: \`button\`, \`a\`, \`div\`, \`td\`, \`tr\`, \`main a\`, \`table tbody tr:nth-child(N)\`. These match every element of that tag and are non-deterministic on replay. **This includes the inner selector inside \`find first/last/nth\`** — see the \`find\` rules below.
- \`[role='button']\` or \`[type='checkbox']\` alone — matches too many elements.
- JavaScript execution (\`eval\`, \`js\`) — blocked by the hook layer.

### \`find\` subset (fallback when no ALLOWED CSS uniquely targets the element)

When repeated aria-labels / visible text make ALLOWED selectors ambiguous (e.g. a chat client where every message row has the same "1 reply" button), use one of these — they record as structured actions and replay deterministically:

\`\`\`
find role <role> <action> [--name "<n>"] [--exact]
find text|label|placeholder|alt|title "<text>" <action> [--exact]
find testid "<id>" <action>
find first|last "<ALLOWED-css>" <action>
find nth <index> "<ALLOWED-css>" <action>
\`\`\`

\`<action>\` is one of \`click | dblclick | fill | type | hover | focus | check | uncheck\`. For \`fill\`/\`type\`, the input value follows the action: \`find label "Email" fill "user@example.com"\`.

**Rules for \`find\`:**

1. Try ALLOWED selectors first. Only reach for \`find\` when they demonstrably cannot uniquely target the element.
2. **The inner selector for \`first/last/nth\` MUST be one of the ALLOWED formats above.** Never pass a bare tag — "the last button" is meaningless on replay.
3. \`find last\` is reliable only when the layout guarantees "the target is the bottom-most match" (e.g. the most-recently-sent chat message). Be explicit in the AB_ACTION label.
4. Argument order is \`<value> <action> [flags]\` — flags after the action. Putting \`--name\` / \`--exact\` before the action makes agent-browser fail with "Unknown subaction".
5. \`--name "<n>"\` is **role-only**. Never pass it to \`find text\`, \`find label\`, etc.
6. \`find\` includes its own wait; do not chain a \`wait\` before it.

**Examples:**

- ✓ \`find last "[data-testid='reply-link']" click\` — specific attribute + layout-guaranteed last match
- ✓ \`find role button click --name "Submit"\` — role + accessible name (flags after action)
- ✗ \`find role button --name "Submit" click\` — wrong order
- ✗ \`find last "button" click\` — bare tag

### Selector workflow

1. Run \`snapshot\` and read the ARIA tree.
2. Identify the element; note its exact \`aria-label\` if present.
3. If aria-label present → use \`[aria-label='...']\`. Otherwise → use \`text=...\`.
4. For links where \`text=\` fails, find the link's URL in the snapshot and use \`a[href*='...']\` with a distinctive substring.
5. For checkboxes: try \`check "text=Label"\` or \`check "[aria-label='Label']"\`.
6. If repeated labels make every ALLOWED selector ambiguous → use the \`find\` subset above.
7. Never guess. If a selector fails, take a fresh snapshot before retrying.

### Special input types

**contenteditable / RichText editors**: \`fill "[contenteditable='true']" "<text>"\` works on contenteditable elements (chat composers, WYSIWYG bodies) — agent-browser sets the text directly. Use a single \`fill\`; do NOT just \`click\` the field and rely on \`keyboard inserttext\` (that keystroke command is not recorded as a structured action, so the text never makes it into the generated test and the field ends up empty on replay).

**combobox / select with a required marker (\`*\`)**: required form fields often include the marker in their accessible name. If \`find role combobox click --name "<label>"\` misses, prefer \`find label "<label>" click\` or \`click "[aria-label='<label> *']"\`.

**Verifying cleanup / deletion**: assert the *absence* of the deleted thing, not the surrounding listing screen's text. Use \`wait --fn "!document.body.innerText.includes('<unique-label>')"\` (text disappearance) — never \`wait "<css-selector>" --state hidden\` (blocks the daemon) and never \`wait --text "<navbar label>"\` (passes regardless of the deletion).

## Test Specification

Title: ${input.title}

Each step's instruction names the URL to open directly (or via \`\${ENV_VAR}\`). Open exactly the URL the step says to open.

## Steps

${stepsText}

## Execution Workflow

For each step:
1. Emit \`STEP_START|<step-id>|<short description>\`.
2. Run \`snapshot\` and identify selectors from the ARIA tree.
3. Execute the action using an ALLOWED selector (see Selector Rules).
4. Emit \`AB_ACTION|...\` for every browser action (see AB_ACTION Protocol).
5. Run \`snapshot\` again to verify the outcome.
6. Confirm at least **two independent signals** (URL change, element appearance, text change, ...).
7. For each verified signal, emit \`AB_ACTION|assert|...\` (see Assertion Protocol).
8. Emit \`ROUTE_STEP|...\`.
9. Emit \`STEP_DONE\`, \`ASSERTION_FAILED\`, or \`STEP_SKIPPED\`.

**After form submission or navigation:** take a fresh snapshot before continuing. If an intermediate screen appears (account selection, role picker, ...), complete it and emit AB_ACTION for each interaction.

## Guardrails

- **Stop after 3 consecutive failures on the same step** — emit \`ASSERTION_FAILED\` and report the blocker.
- **No workarounds.** If all ALLOWED selectors fail, emit \`ASSERTION_FAILED|...|selector-drift: ...\`. Do NOT fall back to coordinate clicks, mouse moves, or \`Tab\`+\`Enter\` keyboard navigation — they cannot be recorded as reliable test actions.
- Do NOT retry a selector without taking a fresh snapshot first.
- Do NOT work around blockers (login walls, missing data, captchas) — stop and report.
- **Do NOT suppress errors.** Never use \`2>/dev/null\`, \`|| true\`, \`; true\`, or any technique that hides agent-browser failures. Each \`agent-browser\` invocation must be its own standalone Bash call. Chaining multiple agent-browser commands with \`&&\` / \`;\` / \`|\` is rejected by the hook layer.
- **If \`agent-browser\` is not found, stop immediately.** Do not run \`which\`, \`find\`, \`npm ls\`, \`npm install\`, \`npx\`, \`brew\`, or any other discovery / installation command. Emit one line and terminate: \`ASSERTION_FAILED|step-XX|agent-browser binary not available in PATH\`.

## Source Code Reference

You have \`Read\`, \`Grep\`, and \`Glob\` to inspect the application source code. Use them proactively to find correct selectors — do NOT guess \`a[href*='...']\` patterns.

**When**: before clicking a link (find the \`href\`); before navigating to a new page (understand routing); when an ARIA element exists but no ALLOWED selector matches (find the actual HTML attributes).

**How**: \`Grep\` for UI text / component names / URL patterns → \`Read\` the JSX/TSX to find \`href\`, \`aria-label\`, \`data-testid\`, or class names → build a precise ALLOWED selector.

**Rules**: only READ source files, never modify them. Keep searches focused.

## Waiting for Async Operations

Prefer \`wait\` over polling:

\`\`\`bash
agent-browser --session ${sessionName} wait --text "<completion text>"
\`\`\`

If polling is required (e.g. waiting for a spinner to disappear):

\`\`\`bash
for i in $(seq 1 18); do
  sleep 10
  result=$(agent-browser --session ${sessionName} snapshot 2>&1)
  echo "$result" | grep -q "<done indicator>" && break
done
agent-browser --session ${sessionName} snapshot
\`\`\`

After waiting, always take a final snapshot. Emit \`AB_ACTION|wait|text=<text>|<label>\`.

## AB_ACTION Protocol

After **every** browser action, emit one line (outside any code block):

\`\`\`
AB_ACTION|cookies_clear
AB_ACTION|open|<url>
AB_ACTION|click|<selector>|<visible label>
AB_ACTION|dblclick|<selector>|<visible label>
AB_ACTION|fill|<selector>|<value>|<aria label>
AB_ACTION|check|<selector>|<visible label>
AB_ACTION|uncheck|<selector>|<visible label>
AB_ACTION|press|<Key>
AB_ACTION|select|<selector>|<value>|<aria label>
AB_ACTION|hover|<selector>|<visible label>
AB_ACTION|scroll|<direction>|<pixels>
AB_ACTION|drag|<source selector>|<target selector>|<source label>
AB_ACTION|wait|<selector or text>|<label>
AB_ACTION|snapshot|<key observation, max 100 chars>
AB_ACTION|assert|<assertType>|<selector or "">|<value or "">|<observation>

# find_* (semantic locator fallback). <extra> = role's --name OR nth's index OR "".
# <exact> = literal "exact" if --exact was passed, "" otherwise. Keep empty pipe slots.
AB_ACTION|find_click|<locator>|<value>|<extra>|<exact>|<label>
AB_ACTION|find_dblclick|<locator>|<value>|<extra>|<exact>|<label>
AB_ACTION|find_hover|<locator>|<value>|<extra>|<exact>|<label>
AB_ACTION|find_focus|<locator>|<value>|<extra>|<exact>|<label>
AB_ACTION|find_check|<locator>|<value>|<extra>|<exact>|<label>
AB_ACTION|find_uncheck|<locator>|<value>|<extra>|<exact>|<label>
AB_ACTION|find_fill|<locator>|<value>|<extra>|<exact>|<input>|<label>
AB_ACTION|find_type|<locator>|<value>|<extra>|<exact>|<input>|<label>
\`\`\`

Selectors in AB_ACTION must follow Selector Rules. \`find_*\` lines use the locator + value pair instead of a separate selector. Do NOT include literal \`|\` inside any field — replace with a space if necessary.

**CRITICAL — record only successful actions.** The AB_ACTION stream is the canonical replay sequence: every line must be reproducible on a fresh browser session.

- A non-zero exit from agent-browser (selector not found, element not interactable, timeout) → **do NOT emit AB_ACTION** for that attempt. Switch selector and only emit the AB_ACTION for the call that finally succeeded.
- If you tried several selectors / \`find_*\` locators for the same logical action, emit AB_ACTION for the **last working one only**. Multiple failed attempts in a row will all fail at replay validation and silently delete the step from the generated test.
- \`AB_ACTION|assert|...\` follows the same rule: only emit assertions you actually verified on the current page in the current snapshot.
- **Environment-failure recovery is not part of the test.** If a session times out, a network blip drops you to login, or the app crashes and you re-login / re-navigate / re-fill to recover, do NOT emit AB_ACTION for the recovery operations.
- If a step ultimately fails after retries: emit \`ASSERTION_FAILED\` and STOP. Do not leave half-recorded actions in the stream.

## Assertion Protocol

After verifying each step, emit \`AB_ACTION|assert\` lines for each signal you confirmed.

**Available assertTypes:**

| assertType | Use when | selector | value |
|------------|----------|----------|-------|
| \`text_visible\` | Stable text appears on page | (empty) | text to find |
| \`text_not_visible\` | Text should be gone | (empty) | text that should be absent |
| \`element_visible\` | Element is visible | CSS selector | (empty) |
| \`element_not_visible\` | Element is hidden/removed | CSS selector | (empty) |
| \`url_contains\` | URL contains a pattern | (empty) | URL substring |
| \`element_enabled\` | Button/input is enabled | CSS selector (state-independent) | (empty) |
| \`element_disabled\` | Button/input is disabled | CSS selector (state-independent) | (empty) |
| \`element_checked\` | Checkbox is checked | CSS selector | (empty) |
| \`element_unchecked\` | Checkbox is unchecked | CSS selector | (empty) |

**Stability rules — CRITICAL. NEVER assert on values that change run-to-run:**

- Timestamps, session IDs, exact numeric counts that vary between runs.
- **Absolute dates / clock times**: \`12:34:56\`, \`2026-05-20\`, \`2026年5月20日\`, \`5月20日\`. These are scrubbed by post-trace literal-scrub anyway — avoid them at the source.
- **Relative-time labels** — true only in the moment of the trace, stale by replay:
  - English: \`just now\`, \`5 minutes ago\`, \`2 hours ago\`, \`yesterday\`, \`last week\`.
  - Japanese: \`たった今\`, \`3分前\`, \`1時間前\`, \`昨日\`.
- Dynamic counts like "42 results" → assert on the stable suffix ("results") only.
- **PREFER**: status text, button labels, URL patterns, element enabled/disabled state.

**No tautological state asserts — CRITICAL for \`element_enabled\` / \`element_disabled\`:**

The selector must identify *which* element by something **other than the state you are asserting**. Selecting the element *by* its state and then asserting that state is a tautology that always passes and verifies nothing.

- ✗ \`element_disabled | button[disabled] |\` — picks an already-disabled button, then "confirms" it is disabled. Passes even if the button the spec cares about is missing or enabled.
- ✗ \`element_enabled | button:enabled |\`, \`[aria-disabled='true']\`, \`input:disabled\` — same trap.
- ✓ Name the element by a stable, state-independent selector and assert the state on it: e.g. the "Submit" button is \`find role button --name "Submit"\`; to assert it is disabled, give \`element_disabled\` a selector that targets *that* button (a stable \`id\` / \`data-testid\` / unique class), **not** \`[disabled]\`.
- If you cannot target the specific element without a state pseudo-class/attribute, **do not emit the enabled/disabled assert** — assert a user-visible consequence instead (e.g. the action it gates does not happen, a "you don't have permission" message is shown), or rely on \`text_visible\` for the label plus \`text_not_visible\` for what an enabled control would have produced.

**Page-context and selector rules:**

- After a navigation, take a **fresh snapshot** before emitting any assertion. Don't assert on text from the previous page.
- Assertion selectors follow the same Selector Rules as actions — never invent aria-label values; use the exact strings from the current snapshot.
- When unsure, prefer \`text_visible\`/\`text_not_visible\` (no selector needed) — but pre-verify with \`wait --text\` per the MUST-VERIFY rule below.

**MUST-VERIFY rule — STRICT (applies to every assert except \`url_contains\`):**

The \`snapshot\` output is the **accessibility tree**, but \`agent-browser\` queries the **real DOM**. They don't always agree. Two known traps:

1. *Selector trap*: a snapshot row like \`textbox "Email address"\` may be reachable via \`[placeholder='...']\` but **not** via \`[aria-label='...']\` if no aria-label attribute is actually set (the browser inferred the label from \`<label for=>\` / placeholder).
2. *Text trap*: a snapshot row like \`link "Dashboard"\` may come from \`<a><img alt="Dashboard"></a>\` — the visible "text" is an \`alt\` attribute, not a text node. \`text_visible\` (which scans visible text nodes) will NOT find it.
3. *Input-value trap*: after you \`fill\` an \`<input>\` / \`<textarea>\` / \`[contenteditable]\`, the text you typed lives in the element's **value**, not as a visible text node. **Do NOT assert the typed value with \`text_visible\`** — it will never match. The spec's "the field reflects X" expectation is implicitly confirmed when the form submits successfully and the value shows up on the *result* page (a list row, a detail page). Assert there, not on the input itself.

Before emitting \`AB_ACTION|assert|...\`, **verify the assertion form actually resolves on the live page**:

\`\`\`bash
# element_visible / element_enabled / element_disabled / element_checked / element_unchecked
# Use get count (fast, returns a number). Do NOT use \`wait "<selector>"\` — it blocks the daemon.
agent-browser --session SESSION get count "<selector>"   # >=1 means present
# element_not_visible
agent-browser --session SESSION get count "<selector>"   # 0 means absent
# text_visible
agent-browser --session SESSION wait --text "<text>" --timeout 3000
# text_not_visible
agent-browser --session SESSION wait --fn "!document.body.innerText.includes('<text>')" --timeout 3000
\`\`\`

When *no* form verifies — e.g. \`[aria-label='X']\`, \`[placeholder='X']\`, and \`text=X\` all timed out, or the visible text turned out to be an \`alt\` — **drop the assertion entirely**. Fewer real assertions beat invented ones that fail at replay. \`url_contains\` is exempt (it checks the URL string, not the DOM).

**Field positions — get these RIGHT.** The line is
\`AB_ACTION|assert|<assertType>|<selector>|<value>|<observation>\`. The value
(the asserted text for \`text_visible\`/\`text_not_visible\`/\`url_contains\`) goes
in the **value** slot, NOT the observation slot. A common mistake is writing
\`text_visible|||Done|...\` (three pipes → empty selector AND empty value, "Done"
lands in observation): that records an assert with no value and it fails at
replay. Use exactly two pipes after the assertType for text asserts.

\`\`\`
AB_ACTION|assert|url_contains||/dashboard|Navigated to dashboard
AB_ACTION|assert|element_disabled|.btn-submit||Submit disabled before form is valid
AB_ACTION|assert|element_enabled|.btn-submit||Submit enabled after form is filled
AB_ACTION|assert|text_visible||Loading|Operation started
AB_ACTION|assert|text_visible||Done|Operation completed
\`\`\`

## Status Protocol

Emit exactly one status line per step (outside any code block):

\`\`\`
STEP_START|<step-id>|<short description>
STEP_DONE|<step-id>|<what was verified>
ASSERTION_FAILED|<step-id>|<category: app-bug|env-issue|auth-blocked|missing-test-data|selector-drift|agent-misread>: <reason>
STEP_SKIPPED|<step-id>|<reason>
RUN_COMPLETED|passed|<summary>
RUN_COMPLETED|failed|<summary>
\`\`\`

## Route Recording

After each step (outside any code block):

\`\`\`
ROUTE_STEP|<step-id>|<short description>|ACTION:<what you did>|OBSERVATION:<what you verified>|STATUS:<PASSED|FAILED|SKIPPED>
\`\`\`

${relatedPathsBlock}## Start

Begin by clearing cookies, then proceed straight to the first step's instruction.

\`\`\`bash
agent-browser --session ${sessionName} cookies clear
\`\`\`

Emit:
\`\`\`
AB_ACTION|cookies_clear
\`\`\`

Then emit \`STEP_START|step-01|...\` and execute the first step. The first step is responsible for opening the initial URL.
`;
}


function buildRelatedPathsInstruction(): string {
  return `## Post-run: emit \`relatedPaths\` block

After all steps are complete (regardless of pass/fail) and **before** \`RUN_COMPLETED\`, you MUST emit a single \`RELATED_PATHS\` block. The host (not you) writes these paths into the spec — your only job is to emit the block.

\`relatedPaths\` is a list of glob patterns identifying the source files this spec depends on. CI uses them to decide whether a code change should trigger a drift check for this spec.

**Do NOT modify any source files.** You have only \`Read\`, \`Grep\`, and \`Glob\` for source inspection. The block you emit is the only output the host uses to update the spec.

**Inputs to consider:**
- The URLs you opened (\`AB_ACTION|open|...\`)
- The aria-labels, placeholders, and visible texts you clicked / filled / waited on
- The component / page / route files that render those strings (find them with \`Grep\`/\`Read\`/\`Glob\`)

**How to choose paths:**
1. For each URL the test navigates to, locate the route/page file and include it (e.g. \`src/app/tasks/page.tsx\`, \`src/pages/tasks/index.tsx\`).
2. For each unique aria-label / placeholder / visible text you interacted with, \`Grep\` the codebase, find the defining component, and include either the file or its parent feature directory.
3. Prefer **directory globs** (e.g. \`src/features/tasks/**\`) over individual files when several related components live in the same area. Otherwise list specific files.
4. Skip third-party files (\`node_modules/\`), build output (\`dist/\`, \`.next/\`), and generated code.
5. Be conservative — false positives (extra paths) are fine; false negatives (missing paths) cause drift to be missed in CI. When unsure whether a path is relevant, include it.

**Output format (STRICT — one line per path, no leading dashes, no commentary inside the block):**

\`\`\`
RELATED_PATHS_BEGIN
src/features/tasks/**
src/app/tasks/page.tsx
RELATED_PATHS_END
\`\`\`

Emit the block outside any other code block, on its own lines. If the test could not exercise the feature at all (e.g. blocked early), emit the block anyway with whatever paths you can identify; emit \`RELATED_PATHS_BEGIN\` immediately followed by \`RELATED_PATHS_END\` only if you genuinely could not identify any related file.

`;
}

export function buildTracePrompt(title: string): string {
  return `Execute the test for "${title}". Each step's instruction includes the URL or selector context it needs.`;
}
