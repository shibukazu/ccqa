import { spawnSync } from "node:child_process";
import { resolveAgentBrowserBin } from "./agent-browser-bin.ts";

// Shared resolution with the PATH handed to the Claude subprocess — see the
// INVARIANT note in agent-browser-bin.ts: host-side spawns and the model's
// `agent-browser ...` commands must hit the same binary (one daemon per
// binary), or a state loaded here is invisible to the session Claude drives.
const AB = resolveAgentBrowserBin();

export type Result = {
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * The command was cut off at {@link PROCESS_HARD_TIMEOUT_MS} rather than
   * answering — the only signal separating a daemon that stopped reading its
   * socket from one that answered with an error. Absent on a synthesized
   * result, which never ran a command to be cut off.
   */
  wedged?: boolean;
};

// agent-browser surfaces EAGAIN (os error 35 / "Resource temporarily
// unavailable") when its state file is being written by a concurrent
// command and the reader hits the filesystem mid-flush. The flake is most
// severe right after `open` while a fresh Chrome instance is booting —
// the daemon's own internal retry budget (~ a couple of seconds) regularly
// exhausts before the state file stabilises.
//
// We wrap spawnSync with an outer retry loop that polls for up to ~30s
// before giving up. Real failures (selector mismatches, true timeouts,
// non-zero exits without the EAGAIN signature) are returned on the first
// attempt — we only loop when stdout/stderr explicitly mentions the
// EAGAIN signature.
const EAGAIN_PATTERN = /Resource temporarily unavailable|os error 35/i;
const EAGAIN_TOTAL_BUDGET_MS = 30_000;
const EAGAIN_BACKOFF_MS = [
  // Quick polls cover the common case (daemon settles in < 2s).
  100, 200, 300, 500, 700, 1000,
  // Then back off slowly through the budget for stubborn cases (a few
  // seconds of state-file contention, especially during fresh `open`).
  1500, 2000, 2500, 3000, 3000, 3000, 3000, 3000, 3000,
] as const;

// Hard ceiling on a single agent-browser invocation. If the daemon is wedged
// (stale session, dead Chrome) spawnSync would otherwise wait forever because
// stdio never closes. Element-existence waits no longer go through the
// blocking `wait <css-selector>` (they poll `get count` instead — see
// test-helpers / replay-validate), and `wait --text` honours its own
// --timeout (≤30s in our callers), so any single invocation that exceeds this
// ceiling is genuinely wedged rather than legitimately slow. 35s leaves room
// for a `wait --text --timeout 30000` plus settle time without letting a
// hung daemon stall the whole run for a minute and a half.
const PROCESS_HARD_TIMEOUT_MS = 35_000;

export function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function spawnABOnce(args: string[], timeoutMs: number): Result {
  const result = spawnSync(AB, args, { stdio: "pipe", timeout: timeoutMs });
  // ETIMEDOUT, not the SIGTERM it is delivered with: an interrupted run signals
  // the whole process group, and a healthy daemon must not be read as wedged.
  const wedged = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr:
      (result.stderr?.toString() ?? "") +
      // Names the command and the ceiling: "killed after hard timeout" alone
      // leaves a reader to work out which invocation stopped answering.
      (wedged
        ? `\n[ccqa] agent-browser ${subcommand(args)} did not answer in ${timeoutMs}ms — killed after hard timeout`
        : ""),
    wedged,
  };
}

/** The verb a reader recognises, past the one prefix every caller writes. */
function subcommand(args: readonly string[]): string {
  return (args[0] === "--session" ? args[2] : args[0]) ?? "(no command)";
}

/**
 * Invoke `agent-browser` once and return its exit status/stdout/stderr,
 * retrying internally up to ~30s while the daemon's state file is in the
 * "Resource temporarily unavailable" race window. Used by both the test
 * runtime (`test-helpers.ts`) and the post-trace replay validation
 * (`replay-validate.ts`). Kept out of `test-helpers.ts` because that
 * module is also the public surface for generated test scripts — exposing
 * the raw spawner there would widen the contract for end users.
 */
export function spawnAB(args: string[], opts?: { timeoutMs?: number }): Result {
  const timeoutMs = opts?.timeoutMs ?? PROCESS_HARD_TIMEOUT_MS;
  let result = spawnABOnce(args, timeoutMs);
  let elapsed = 0;
  let attempt = 0;
  while (result.status !== 0 && elapsed < EAGAIN_TOTAL_BUDGET_MS) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (!EAGAIN_PATTERN.test(combined)) return result;
    const wait = EAGAIN_BACKOFF_MS[attempt] ?? 3000;
    sleepSync(wait);
    elapsed += wait;
    attempt++;
    result = spawnABOnce(args, timeoutMs);
  }
  return result;
}
