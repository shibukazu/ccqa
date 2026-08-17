import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { killSessionDaemon } from "../runtime/agent-browser-daemon.ts";

const require = createRequire(import.meta.url);

const SNAPSHOT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 60_000;

function resolveAgentBrowserBin(): string | null {
  try {
    return require.resolve("agent-browser/bin/agent-browser.js");
  } catch {
    return null;
  }
}

/**
 * Run `agent-browser snapshot` against the session that the failed vitest
 * run just used, and return its accessibility-tree dump.
 *
 * Returns null when agent-browser is missing, the daemon has no live page
 * for the session, or the call exceeds {@link SNAPSHOT_TIMEOUT_MS}. We
 * never throw — a missing snapshot just means diagnose has less context.
 *
 * The output is truncated to {@link MAX_OUTPUT_BYTES} so the prompt stays
 * within budget on large pages.
 */
export async function captureSnapshot(sessionName: string): Promise<string | null> {
  const abBin = resolveAgentBrowserBin();
  if (!abBin) return null;

  return new Promise<string | null>((resolve) => {
    const child = spawn(process.execPath, [abBin, "snapshot"], {
      env: { ...process.env, AGENT_BROWSER_SESSION: sessionName },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SNAPSHOT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      // stderr is informational at best — drop it to keep the prompt focused.
      void stderr;
      resolve(truncate(trimmed, MAX_OUTPUT_BYTES));
    });
  });
}

function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return `${s.slice(0, maxBytes)}\n... [truncated, ${s.length - maxBytes} more chars]`;
}

/**
 * Close an agent-browser session by name. Used before/after a `ccqa generate`
 * run so a wedged daemon from a previous attempt can't hang the next one.
 *
 * Always resolves; never throws. If the binary is missing or the session
 * doesn't exist, we silently return — close is best-effort cleanup, not a
 * precondition.
 */
export async function closeSession(sessionName: string): Promise<void> {
  const abBin = resolveAgentBrowserBin();
  if (!abBin) return;

  let unanswered = false;
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [abBin, "close"], {
      env: { ...process.env, AGENT_BROWSER_SESSION: sessionName },
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      unanswered = true;
      child.kill("SIGTERM");
    }, CLOSE_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", finish);
    child.on("exit", finish);
  });

  // Only a close that never answered means the daemon is still there — `close`
  // travels over the socket it stopped reading, and killing the client frees
  // nothing. A non-zero exit is the ordinary "no such session" of a pre-run
  // cleanup, where there is nothing to reach.
  if (unanswered) await killSessionDaemon(sessionName);
}
