import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { describeStepAction } from "../ir/route-diff.ts";
import type { RecordedAction } from "../ir/types.ts";
import { replayUntilFailure } from "../runtime/replay-validate.ts";
import * as log from "./logger.ts";

export const REPLAY_STEP_SERVER = "ccqa";

/**
 * The `replay_step` tool: runs one step's previous commands in the trace's own
 * session and records the ones that pass. A step that still works costs the
 * recorder one turn instead of one per command.
 */
export function buildReplayStepServer(input: {
  previous: readonly RecordedAction[];
  sessionName: string;
  envOverrides: Record<string, string>;
  onReplayed: (stepId: string, passed: RecordedAction[]) => void;
}): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: REPLAY_STEP_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "replay_step",
        "Run one step's previous-recording commands in this browser session and record those that pass. Stops at the first that fails.",
        { step: z.string().describe("The step id, e.g. step-03") },
        async ({ step }) => ({ content: [{ type: "text" as const, text: replayStep(step, input) }] }),
      ),
    ],
  });
}

function replayStep(step: string, input: Parameters<typeof buildReplayStepServer>[0]): string {
  // Copies without the old stability tags: the post-trace validation sets them afresh.
  const actions = input.previous
    .filter((a) => a.stepId === step && a.action !== "snapshot")
    .map(({ replayUnstable: _u, replayReason: _r, ...a }) => a);
  if (actions.length === 0) {
    return `No previous commands for ${step}. Record it with the Execution Workflow.`;
  }
  const { passed, unchecked, failed } = replayUntilFailure(actions, {
    sessionName: input.sessionName,
    envOverrides: input.envOverrides,
  });
  input.onReplayed(step, passed);
  log.info(`replay_step ${step}: ${passed.length}/${actions.length} replayed${failed ? "" : " — all passed"}`);
  const notRun =
    unchecked.length === 0
      ? ""
      : `\nThese checks could not be run here and were not recorded — perform the ones Expected still asks for yourself:\n` +
        unchecked.map((a) => `- ${describeStepAction(a)}`).join("\n");
  if (!failed) {
    const next = unchecked.length === 0 ? " Emit STEP_DONE and go on." : "";
    return `${passed.length} of ${actions.length} previous command(s) of ${step} ran and are recorded, its checks included.${next}${notRun}`;
  }
  return (
    `${passed.length} of ${actions.length} previous command(s) of ${step} ran and are recorded. ` +
    `The next one failed: ${describeStepAction(failed.action)} — ${failed.reason}\n` +
    `The page is where the recorded commands left it. Finish ${step} with the Execution Workflow ` +
    `(snapshot first); do not re-run the recorded commands.${notRun}`
  );
}
