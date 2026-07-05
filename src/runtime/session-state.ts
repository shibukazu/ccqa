import { rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

let signalHandlersRegistered = false;
function ensureProcessCleanupRegistered(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  process.once("exit", cleanupTrackedDirsSync);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      cleanupTrackedDirsSync();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
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
