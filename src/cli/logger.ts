import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * When a `withBuffer` scope is active, every log line (stdout and stderr) is
 * appended to its buffer instead of being written immediately. Parallel spec
 * runs use this so each spec's narration — including logs emitted deep inside
 * the live executor — flushes as one contiguous block, not interleaved.
 */
const bufferStore = new AsyncLocalStorage<{ out: string[] }>();

/** True while inside a `withBuffer` scope: progress lines avoid TTY cursor tricks. */
export function isBuffered(): boolean {
  return bufferStore.getStore() !== undefined;
}

function emit(text: string, sink: NodeJS.WritableStream = process.stdout): void {
  const store = bufferStore.getStore();
  if (store) {
    store.out.push(text);
    return;
  }
  sink.write(text);
}

/**
 * Write raw text to the active `withBuffer` scope, or straight to stdout when
 * none is active. Lets a runner redirect sub-process output (e.g. a child's
 * stdout) into the same buffer as its `log.*` lines so they flush together.
 */
export function emitRaw(text: string): void {
  emit(text);
}

/**
 * Run `fn` with all its log output captured into a buffer, then flush the
 * buffer in one shot under `label`. Used by parallel runners to keep each
 * spec's output legible. Output is flushed even when `fn` throws.
 *
 * When `buffered` is false, `fn` runs with no buffer so its output streams
 * live — this is the sequential (concurrency 1) path, unchanged from before.
 */
export async function withBuffer<T>(label: string, buffered: boolean, fn: () => Promise<T>): Promise<T> {
  if (!buffered) return fn();
  const store = { out: [] as string[] };
  try {
    return await bufferStore.run(store, fn);
  } finally {
    process.stdout.write(`\n──── ${label} ────\n${store.out.join("")}`);
  }
}

export function header(command: string, target?: string): void {
  emit(`\nccqa ${command}${target ? ` ${target}` : ""}\n\n`);
}

function write(scope: Scope, message: string, sink: NodeJS.WritableStream = process.stdout): void {
  emit(`[${scope}] ${message}\n`, sink);
}

export function meta(key: string, value: string | number): void {
  write("meta", `${key}: ${value}`);
}

export function blank(): void {
  emit("\n");
}

export function info(message: string): void {
  write("info", message);
}

export function step(type: StepStatus, stepId: string, detail: string): void {
  emit(`  ${STEP_ICONS[type]} [${stepId}] ${detail}\n`);
}

export function bash(command: string): void {
  emit(`  $ ${command.slice(0, 120)}\n`);
}

export function error(message: string): void {
  write("error", message, process.stderr);
}

export function warn(message: string): void {
  write("warn", message, process.stderr);
}

export function hint(message: string): void {
  emit("\n");
  write("hint", message);
}

export function fix(message: string): void {
  write("fix", message);
}

export function run(message: string): void {
  write("run", message);
}

/**
 * Render a single-line progress indicator for a step-by-step loop.
 *
 * On a TTY the line is rewritten in place via `\r` so the terminal stays
 * uncluttered. In a non-TTY environment (CI, piped runs) we fall back to
 * a regular `[info]` line every PROGRESS_NONTTY_STRIDE steps to avoid
 * spamming the log with one line per action.
 *
 * Callers MUST call `progressEnd()` when the loop finishes (or aborts) so
 * the carriage-return line gets a final newline; otherwise the next log
 * line lands on the same physical row.
 */
const PROGRESS_NONTTY_STRIDE = 5;
let lastProgressNonTtyEmit = -1;
export function progress(current: number, total: number, label: string): void {
  // 1-based display index — the operator's mental model is "doing #N of #M".
  const idx = current + 1;
  const text = `[info] ${idx}/${total} ${label}`;
  // In-place \r rewriting only works on a live TTY; a buffered scope flushes
  // later, so emit stride-throttled plain lines there instead (same as non-TTY).
  if (process.stdout.isTTY && !isBuffered()) {
    // Pad with spaces to overwrite a possibly longer previous line.
    process.stdout.write(`\r${text}\x1b[K`);
    return;
  }
  // Non-TTY / buffered: emit at stride boundaries (plus the first action) so logs don't flood.
  if (current === 0 || current - lastProgressNonTtyEmit >= PROGRESS_NONTTY_STRIDE) {
    emit(`${text}\n`);
    lastProgressNonTtyEmit = current;
  }
}
export function progressEnd(): void {
  if (process.stdout.isTTY && !isBuffered()) {
    process.stdout.write(`\r\x1b[K`);
  }
  lastProgressNonTtyEmit = -1;
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
