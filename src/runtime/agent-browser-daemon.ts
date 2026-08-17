import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Forcing a session's agent-browser daemon out when it has stopped answering.
 *
 * Every other way ccqa reaches a daemon is a command over that daemon's socket
 * — `close`, the only shutdown the CLI offers, included — so none of them work
 * on one that no longer reads it. The per-session pid file does not.
 */

/** Measured against agent-browser 0.26-0.34. */
export function agentBrowserRuntimeDir(): string {
  const explicit = process.env["AGENT_BROWSER_SOCKET_DIR"];
  if (explicit) return explicit;
  const xdg = process.env["XDG_RUNTIME_DIR"];
  if (xdg) return join(xdg, "agent-browser");
  return join(homedir(), ".agent-browser");
}

/** The daemon pid agent-browser recorded for `sessionName`, if it wrote one. */
export function readDaemonPid(sessionName: string): number | null {
  try {
    const pid = Number(
      readFileSync(join(agentBrowserRuntimeDir(), `${sessionName}.pid`), "utf8").trim(),
    );
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to another user — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A pid file outlives an unclean exit, so its number may since have been handed
 * to something else. Where `ps` cannot answer, decline rather than guess.
 */
function looksLikeAgentBrowser(pid: number): boolean {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes("agent-browser");
}

function childPids(parent: number): number[] {
  const ps = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0) return [];
  const children: number[] = [];
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid === parent) children.push(pid);
  }
  return children;
}

/** Ramped so the common case — a daemon that exits at once — is not taxed. */
const TERM_POLL_MS = [25, 50, 100, 250, 250, 250, 500, 500, 1000, 1000, 1000];

export type DaemonKill = { killed: true; pid: number } | { killed: false; reason: string };

/** One phrase covering both outcomes, so callers log a single line. */
export function describeKill(kill: DaemonKill): string {
  return kill.killed ? `killed daemon pid ${kill.pid}` : `could not kill the daemon (${kill.reason})`;
}

/**
 * Stop the daemon serving `sessionName`. The session stays reusable —
 * agent-browser boots a fresh daemon under the same name and clears the stale
 * socket itself.
 *
 * SIGTERM is given time because a daemon that exits on its own signal takes its
 * browser down with it, while SIGKILL leaves that browser running with no owner.
 */
export async function killSessionDaemon(sessionName: string): Promise<DaemonKill> {
  const pid = readDaemonPid(sessionName);
  if (pid === null) return { killed: false, reason: "no pid file for this session" };
  if (!isAlive(pid)) return { killed: false, reason: `pid ${pid} is not running` };
  if (!looksLikeAgentBrowser(pid)) {
    return { killed: false, reason: `pid ${pid} is not an agent-browser process` };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { killed: false, reason: `pid ${pid} could not be signalled` };
  }
  for (const wait of TERM_POLL_MS) {
    if (!isAlive(pid)) return { killed: true, pid };
    await delay(wait);
  }
  if (!isAlive(pid)) return { killed: true, pid };

  // Read parentage while the daemon still holds it: SIGKILL reparents whatever
  // survives, and an ownerless browser is what the sweep below exists to stop.
  const owned = childPids(pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Raced with its own exit; the sweep still runs.
  }
  for (const child of owned) {
    if (isAlive(child) && looksLikeAgentBrowser(child)) {
      try {
        process.kill(child, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  return { killed: true, pid };
}
