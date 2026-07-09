import { rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { spawnAB } from "./spawn-ab.ts";

/**
 * A saved browser session: agent-browser's storage-state JSON (cookies +
 * per-origin localStorage / sessionStorage), as written by
 * `agent-browser state save <path>`. ccqa only restores these read-only.
 */
export interface StorageState {
  cookies: StateCookie[];
  origins: StateOrigin[];
}

interface StateCookie {
  name: string;
  domain: string;
  path: string;
  [key: string]: unknown;
}

interface StateOrigin {
  origin: string;
  [key: string]: unknown;
}

/** Default per-profile sessions root, relative to the project (`--cwd`). */
const SESSIONS_SUBDIR = ".ccqa/sessions";

/** The profile bucket sessions live under when no `--profile` was given. */
export const DEFAULT_SESSION_PROFILE = "default";

/**
 * Resolve a session name to its state file path:
 * `<cwd>/.ccqa/sessions/<profile>/<name>.json`. The name is a slug (validated
 * by SessionNameSchema), so it can't escape the sessions directory. Used by
 * `ccqa hub session push`, which uploads an externally-produced storage-state
 * file from this local path to the hub.
 */
export function sessionFilePath(
  name: string,
  profile: string | undefined,
  cwd: string,
): string {
  return join(cwd, SESSIONS_SUBDIR, profile ?? DEFAULT_SESSION_PROFILE, `${name}.json`);
}

/** Read and parse a saved session file. Throws if missing or malformed. */
export async function loadStorageState(path: string): Promise<StorageState> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<StorageState>;
  if (!Array.isArray(parsed?.cookies) || !Array.isArray(parsed?.origins)) {
    throw new Error(`not a valid agent-browser state file (expected { cookies, origins }): ${path}`);
  }
  return parsed as StorageState;
}

/**
 * Merge several saved sessions into one. Cookies are unioned by
 * (name, domain, path); origins by `origin`. Later states win on collision.
 * Distinct providers don't collide (different domains / origins), so merging
 * two single-provider sessions yields a combined signed-in state.
 */
export function mergeStorageStates(states: StorageState[]): StorageState {
  const cookies = new Map<string, StateCookie>();
  for (const s of states) {
    for (const c of s.cookies) cookies.set(`${c.name}\t${c.domain}\t${c.path}`, c);
  }
  const origins = new Map<string, StateOrigin>();
  for (const s of states) {
    for (const o of s.origins) origins.set(o.origin, o);
  }
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

/**
 * Temp directories created by `writeMergedTempState` that haven't been
 * cleaned up yet via `removeTempStateDir`. Holds auth cookies, so anything
 * left behind at process exit is removed by `cleanupTrackedDirsSync`.
 */
const trackedTempDirs = new Set<string>();

function cleanupTrackedDirsSync(): void {
  for (const dir of trackedTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on process exit; nothing to recover into.
    }
  }
  trackedTempDirs.clear();
}

let cleanupRegistered = false;
function ensureProcessCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // Only hook "exit" — the temp-dir removal runs no matter how we leave.
  // We deliberately do NOT register SIGINT/SIGTERM handlers here: a signal
  // handler that calls process.exit() would preempt the run command's own
  // teardown (report finalize + agent-browser reap) and exit before it runs.
  // The run command owns signal handling; its exit still triggers this
  // "exit" hook, so the temp state dir is cleaned up on Ctrl-C too.
  process.once("exit", cleanupTrackedDirsSync);
}

/**
 * Write a merged state to a fresh temp file and return its path. Source
 * session files are never modified; the temp file is what gets restored via
 * `--state`, so re-runs (local or CI) leave the source-of-truth untouched.
 * The file holds live auth cookies, so it's written 0600 and tracked so a
 * killed process still cleans it up (`removeTempStateDir` is the normal path).
 */
export async function writeMergedTempState(state: StorageState): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-session-"));
  ensureProcessCleanupRegistered();
  trackedTempDirs.add(dir);
  const file = join(dir, "merged-state.json");
  await writeFile(file, JSON.stringify(state), "utf8");
  await chmod(file, 0o600);
  return file;
}

/** Remove a temp state dir created by `writeMergedTempState` and stop tracking it. */
export async function removeTempStateDir(statePath: string): Promise<void> {
  const dir = dirname(statePath);
  trackedTempDirs.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

export interface StateInjectionResult {
  ok: boolean;
  error?: string;
}

/**
 * Cold-start an agent-browser daemon for `sessionName` and attach a saved
 * auth-state to it, up front and exactly once, before any real navigation.
 *
 * Why not just pass `--state` on the first real command? agent-browser treats
 * `--state` as a *daemon-launch* flag: it only takes effect on the invocation
 * that boots the daemon, and later `--state` flags are ignored with a
 * misleading "already running" warning. Relying on the model (or a screenshot
 * helper) to carry `--state` on whichever command happens to boot the daemon
 * couples restore to command ordering. Doing `open about:blank` (boot, no
 * navigation) and then `state load <path>` (a runtime command that sets the
 * state path in place) makes injection explicit and order-independent: cookies
 * + localStorage are attached to the session once, up front, so the very first
 * screenshot / step already sees a signed-in page.
 *
 * `state load` never writes back to the file (load-only), so re-runs leave the
 * source-of-truth untouched. Returns `{ ok: false, error }` on failure rather
 * than throwing; the caller decides whether an un-restored session is fatal.
 */
export function loadStateIntoSession(sessionName: string, statePath: string): StateInjectionResult {
  // Boot the daemon without navigating, so the state attaches to the session
  // rather than racing a page load.
  const boot = spawnAB(["--session", sessionName, "open", "about:blank"]);
  if (boot.status !== 0) {
    return { ok: false, error: (boot.stderr || boot.stdout || `open exited ${boot.status}`).trim() };
  }
  const load = spawnAB(["--session", sessionName, "state", "load", statePath]);
  if (load.status !== 0) {
    return { ok: false, error: (load.stderr || load.stdout || `state load exited ${load.status}`).trim() };
  }
  return { ok: true };
}

export type SessionRestoreCheck =
  | { restored: true }
  | { restored: false; reason: string };

/**
 * Prove a just-saved session actually restores to a signed-in page, in a fresh
 * throwaway agent-browser session, before it's trusted (e.g. uploaded to the
 * hub). Loads `statePath` into a clean session, navigates to `verifyUrl`, and
 * checks that a login form did NOT appear — the common failure mode where a
 * bootstrap was saved before the app finished signing in, so cookies restore
 * but the app still demands re-auth.
 *
 * "Signed-in" is detected generically (no product strings): a password input
 * present means a login form is showing → not restored. This is a positive
 * gate on the save, not a runtime check. Best-effort: on infrastructure errors
 * (daemon won't start, navigation fails) it returns `restored: false` with the
 * error so the caller can surface it rather than silently trusting the save.
 * Always closes the throwaway session.
 */
export function verifySessionRestores(statePath: string, verifyUrl: string): SessionRestoreCheck {
  const verifySession = `ccqa-session-verify-${process.pid}-${trackedTempDirs.size}`;
  try {
    const injected = loadStateIntoSession(verifySession, statePath);
    if (!injected.ok) return { restored: false, reason: injected.error ?? "state load failed" };

    const nav = spawnAB(["--session", verifySession, "open", verifyUrl]);
    if (nav.status !== 0) {
      return { restored: false, reason: (nav.stderr || nav.stdout || `open exited ${nav.status}`).trim() };
    }
    // Let the app settle so an SPA that redirects to a sign-in screen has time
    // to render it before we probe.
    spawnAB(["--session", verifySession, "wait", "--load", "networkidle"]);
    spawnAB(["--session", verifySession, "wait", "3000"]);

    const probe = spawnAB(["--session", verifySession, "get", "count", "input[type=password]"]);
    if (probe.status !== 0) {
      return { restored: false, reason: (probe.stderr || probe.stdout || `probe exited ${probe.status}`).trim() };
    }
    const passwordInputs = Number.parseInt(probe.stdout.replace(/[^0-9]/g, ""), 10) || 0;
    if (passwordInputs >= 1) {
      return { restored: false, reason: "a sign-in form appeared — the app is not signed in after restore" };
    }
    return { restored: true };
  } finally {
    spawnAB(["--session", verifySession, "close"]);
  }
}
