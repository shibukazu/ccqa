import { spawn } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  abActionEventFromCommand,
  abPositionalTokens,
  abCommandBlockReason,
  extractCcqaStepFromBashCommand,
  isAgentBrowserCommand,
  type AbActionEvent,
} from "../claude/invoke.ts";
import { describeStepAction } from "../ir/route-diff.ts";
import type { RecordedAction } from "../ir/types.ts";
import { scrubEnvValues } from "../runtime/env-scrub.ts";
import { replayUntilFailure } from "../runtime/replay-validate.ts";
import { scrollCoveredIntoView } from "../runtime/spawn-ab.ts";
import * as log from "./logger.ts";

export const TRACE_TOOLS_SERVER = "ccqa";

/** A wedged command must not hold the whole trace; agent-browser's own waits are far shorter. */
const COMMAND_TIMEOUT_MS = 120_000;
/** Enough of a snapshot or a `get` answer to act on, without flooding the turn. */
const OUTPUT_CAP = 6_000;

export interface TraceToolsInput {
  /** The replaced recording's steps whose text is unchanged; `replay_step` runs only these. */
  previous: readonly RecordedAction[];
  sessionName: string;
  /** What the recorder's own Bash sees, so a batch runs against the same session and values. */
  env: Record<string, string>;
  envScrubMap: Array<[string, string]>;
  onReplayed: (stepId: string, passed: RecordedAction[]) => void;
  /** The same recording path the Bash hook feeds. */
  onAbAction: (event: AbActionEvent) => void;
  beforeAbCommand: (stepId: string | undefined) => string | null;
}

/**
 * The trace's own tools. Both exist to cut round trips: one turn per browser
 * command is what made a re-record cost hundreds of turns.
 *
 * - `run_commands` runs a batch the recorder wrote, recording each that passes.
 * - `replay_step` runs one step's previous commands.
 */
export function buildTraceTools(input: TraceToolsInput): {
  server: ReturnType<typeof createSdkMcpServer>;
  allowedTools: string[];
} {
  const offersReplay = input.previous.length > 0;
  const tools = [
    tool(
      "run_commands",
      "Run several agent-browser commands in order, each written exactly as you would run it in Bash (with its CCQA_STEP / CCQA_ASSERT / CCQA_SECRET prefixes). Each that succeeds is recorded; the batch stops at the first that fails. Returns each command's outcome and the output of the last one.",
      { commands: z.array(z.string()).min(1).describe("agent-browser command lines, one per entry") },
      async ({ commands }) => ({ content: [{ type: "text" as const, text: await runCommands(commands, input) }] }),
    ),
    ...(offersReplay
      ? [
          tool(
            "replay_step",
            "Run one step's previous-recording commands in this browser session and record those that pass. Stops at the first that fails.",
            { step: z.string().describe("The step id, e.g. step-03") },
            async ({ step }) => ({ content: [{ type: "text" as const, text: replayStep(step, input) }] }),
          ),
        ]
      : []),
  ];
  return {
    server: createSdkMcpServer({ name: TRACE_TOOLS_SERVER, version: "1.0.0", tools }),
    allowedTools: ["run_commands", ...(offersReplay ? ["replay_step"] : [])].map((t) => `mcp__${TRACE_TOOLS_SERVER}__${t}`),
  };
}

export async function runCommands(commands: string[], input: TraceToolsInput): Promise<string> {
  const report: string[] = [];
  for (const [i, cmd] of commands.entries()) {
    const stop = (why: string): string =>
      [...report, `✗ ${cmd}\n${why}`, ...(i + 1 < commands.length ? [`The ${commands.length - i - 1} command(s) after it were not run.`] : [])].join("\n");
    if (!isAgentBrowserCommand(cmd)) return stop("Only agent-browser commands can be batched; run anything else with Bash.");
    const blocked = abCommandBlockReason(cmd, input.envScrubMap);
    if (blocked !== null) return stop(blocked);
    const recorded = abActionEventFromCommand(cmd);
    const checkpoint = input.beforeAbCommand(extractCcqaStepFromBashCommand(cmd) ?? undefined);
    if (checkpoint) return stop(checkpoint);
    log.info(`$ ${scrubEnvValues(cmd, input.envScrubMap)}`);
    const env = { ...process.env, ...input.env };
    let result = await runShell(cmd, env);
    if (result.status !== 0 && scrollCoveredIntoView(["--session", input.sessionName], abPositionalTokens(cmd), result)) {
      result = await runShell(cmd, env);
    }
    const out = result.stdout.trim();
    const ok = result.status === 0 && (recorded?.holds ? recorded.holds(out) : true);
    if (!ok) {
      const detail = (result.stderr || out || `exit ${result.status ?? "timeout"}`).trim().slice(0, 600);
      return stop(result.status === 0 ? `The check did not hold; the page answered: ${out.slice(0, 300)}` : detail);
    }
    if (recorded) input.onAbAction(recorded.event);
    const last = i === commands.length - 1;
    report.push(`✓ ${cmd}${out && (last || out.length < 200) ? `\n${cap(out)}` : ""}`);
  }
  return report.join("\n");
}

/**
 * Async, so the trace's deadline and signal teardown still run while a batch
 * does. Settles on `exit` too: a daemon the command started may hold the pipes open.
 */
function runShell(
  cmd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { env, timeout: COMMAND_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const done = (status: number | null, err?: string) => resolve({ status, stdout, stderr: stderr || (err ?? "") });
    child.on("error", (e) => done(null, e.message));
    child.on("close", (status) => done(status));
    child.on("exit", (status) => setTimeout(() => done(status), 1_000).unref());
  });
}

function cap(out: string): string {
  return out.length <= OUTPUT_CAP ? out : `${out.slice(0, OUTPUT_CAP)}\n… (${out.length - OUTPUT_CAP} more characters; scope it with snapshot -s <selector>)`;
}

function replayStep(step: string, input: TraceToolsInput): string {
  // Copies without the old stability tags: the post-trace validation sets them afresh.
  const actions = input.previous
    .filter((a) => a.stepId === step && a.action !== "snapshot")
    .map(({ replayUnstable: _u, replayReason: _r, ...a }) => a);
  if (actions.length === 0) {
    return `No previous commands for ${step}: it is new or its text changed since the last recording. Record it with the Execution Workflow.`;
  }
  const { passed, unchecked, failed } = replayUntilFailure(actions, {
    sessionName: input.sessionName,
    envOverrides: { CCQA_RUN_ID: input.env["CCQA_RUN_ID"] ?? input.sessionName },
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
