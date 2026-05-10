import type { StepStatus } from "../types.ts";

const STEP_ICONS: Record<StepStatus, string> = {
  STEP_START: "▶",
  STEP_DONE: "✓",
  ASSERTION_FAILED: "✗",
  STEP_SKIPPED: "⊘",
  RUN_COMPLETED: "■",
};

/**
 * Output convention (case A): every line that conveys CLI status carries a
 * leading `[scope]` tag. Tags are short, lowercase, and stable so users can
 * grep / filter by them. Examples:
 *   [run]   - vitest invocations
 *   [fix]   - auto-fix loop (diagnose, snapshot, applying fixes)
 *   [meta]  - key/value summary lines for the current command
 *   [info]  - free-form status that doesn't fit the above
 *   [warn]  - recoverable problems
 *   [error] - hard failures (also routed to stderr)
 *   [hint]  - suggested next step
 *
 * Sub-process output (vitest stdout, agent-browser stream) is intentionally
 * untagged: it is somebody else's output and tagging would lie about who
 * wrote it. Tags belong to ccqa's own narration.
 */
export type Scope = "run" | "fix" | "meta" | "info" | "warn" | "error" | "hint";

export function header(command: string, target?: string): void {
  process.stdout.write(`\nccqa ${command}${target ? ` ${target}` : ""}\n\n`);
}

function write(scope: Scope, message: string, sink: NodeJS.WritableStream = process.stdout): void {
  sink.write(`[${scope}] ${message}\n`);
}

export function meta(key: string, value: string | number): void {
  write("meta", `${key}: ${value}`);
}

export function blank(): void {
  process.stdout.write("\n");
}

export function info(message: string): void {
  write("info", message);
}

export function step(type: StepStatus, stepId: string, detail: string): void {
  process.stdout.write(`  ${STEP_ICONS[type]} [${stepId}] ${detail}\n`);
}

export function bash(command: string): void {
  process.stdout.write(`  $ ${command.slice(0, 120)}\n`);
}

export function error(message: string): void {
  write("error", message, process.stderr);
}

export function warn(message: string): void {
  write("warn", message, process.stderr);
}

export function hint(message: string): void {
  process.stdout.write("\n");
  write("hint", message);
}

export function fix(message: string): void {
  write("fix", message);
}

export function run(message: string): void {
  write("run", message);
}

/**
 * Time a long-running step under the given scope, emitting `started` and
 * `finished in N.Ns` markers. Scope must be a tag the user wants to grep
 * for — typically "run" for vitest and "fix" for diagnose-loop steps.
 */
export async function timedPhase<T>(
  label: string,
  fn: () => Promise<T>,
  scope: Scope = "fix",
): Promise<T> {
  const startedAt = Date.now();
  write(scope, `${label} started`);
  try {
    const result = await fn();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    write(scope, `${label} finished in ${elapsed}s`);
    return result;
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    write(scope, `${label} threw after ${elapsed}s`);
    throw err;
  }
}
