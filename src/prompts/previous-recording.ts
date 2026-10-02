import { markedAssertArgs, toAgentBrowserArgs, type AbToken } from "../ir/to-agent-browser.ts";
import { SETUP_STEP_ID, type RecordedAction } from "../ir/types.ts";
import { isCascadeReason } from "../runtime/replay-validate.ts";

/**
 * The previous recording as the commands that perform it, for the trace prompt:
 * a re-record is usually one moved screen in an otherwise intact route.
 */
export function renderPreviousRecording(
  actions: readonly RecordedAction[],
  sessionName: string,
  currentStepIds: readonly string[],
): string {
  // Commands of a step the case no longer has would be run under whatever now holds its id.
  const current = new Set([SETUP_STEP_ID, ...currentStepIds]);
  // The validator replays every step even after one breaks, so failures after
  // the first broken step are mostly the wrong page, not the action.
  const brokenStep = actions.find(failedToReplay)?.stepId;
  const byStep = new Map<string, string[]>();
  for (const action of actions) {
    // The unattributed preamble (cookies clear) is already in the prompt's Start section.
    if (action.stepId === undefined || !current.has(action.stepId)) continue;
    const command = previousCommand(action, sessionName, action.stepId === brokenStep);
    if (command === null) continue;
    const lines = byStep.get(action.stepId) ?? [];
    lines.push(command);
    byStep.set(action.stepId, lines);
  }
  if (byStep.size === 0) return "";
  const blocks = [...byStep].map(
    ([stepId, lines]) => `### ${stepId}\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\``,
  );
  return `
## Previous recording

This case was recorded before. Below is what that recording did, step by step,
as the commands that perform it. The application may have moved since, and the
steps above may have been edited: **the steps above are the contract, this is a
map.**

For a step listed here, this replaces the snapshot-first routine of the
Execution Workflow:

1. While a step's previous commands still do what its instruction and
   \`Expected\` say, call the \`replay_step\` tool with the step id instead of
   running them yourself. It runs and records them in this session, checks
   included, and stops at the first that fails. Do not snapshot first.
2. When it reports they all ran, emit \`STEP_DONE\` and go to the next step
   without a confirming snapshot.
3. When it reports a failure, the commands before it are recorded and the
   page is where they left it: finish that step with the Execution Workflow —
   snapshot, find what works, record it — without re-running what was
   recorded. A step whose instruction or \`Expected\` asks for something these
   commands do not do skips \`replay_step\` and uses the Execution Workflow
   from the start. The next step goes back to \`replay_step\`.
4. A step you record yourself takes its assertions from its current
   \`Expected\`: keep a previous check only while it verifies what
   \`Expected\` says now. A step whose \`Expected\` has changed is one to
   record yourself, since \`replay_step\` records the previous checks as
   they are.
5. A command marked \`# did not replay last time\` is where the previous
   recording's own validation found the route broken: expect that step to
   need the Execution Workflow, and do not keep a form that only half works.

A step with no section here is recorded the usual way.

${blocks.join("\n\n")}
`;
}

function previousCommand(
  action: RecordedAction,
  sessionName: string,
  inBrokenStep: boolean,
): string | null {
  // A selector wait ignores --timeout and wedges the daemon (see Browser Commands); only text waits are safe to run blind.
  if (action.action === "wait" && action.locator?.by !== "text") return null;
  const marked = action.action === "assert" ? markedAssertArgs(action) : null;
  const tokens = marked?.tokens ?? (action.action === "assert" ? null : toAgentBrowserArgs(action));
  if (tokens === null) return null;
  const line = [
    `CCQA_STEP=${action.stepId}`,
    ...(marked ? [`CCQA_ASSERT=${shellWord(marked.marker)}`] : []),
    ...(action.secret ? ["CCQA_SECRET=1"] : []),
    "agent-browser",
    "--session",
    sessionName,
    renderTokens(tokens),
  ].join(" ");
  return inBrokenStep && failedToReplay(action) ? `${line}   # did not replay last time` : line;
}

/** Failed on its own, rather than skipped behind an earlier failure. */
function failedToReplay(action: RecordedAction): boolean {
  return action.replayUnstable === true && !isCascadeReason(action.replayReason);
}

function renderTokens(tokens: AbToken[]): string {
  return tokens.map((t) => (t.expandsEnv ? quote(t.text) : t.text)).join(" ");
}

/** Double-quoted with `${VAR}` refs left live, as the recording keeps them; any other `$` is literal text. */
function quote(s: string): string {
  return `"${s.replace(/(["\\`])|\$(?!\{[A-Za-z_]\w*\})/g, (m, c: string | undefined) => `\\${c ?? m}`)}"`;
}

function shellWord(s: string): string {
  return /^[\w:/.,=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
