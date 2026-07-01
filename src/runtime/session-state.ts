import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** The per-profile sessions directory: `<cwd>/.ccqa/sessions/<profile>/`. */
export function sessionsDir(profile: string | undefined, cwd: string): string {
  return join(cwd, SESSIONS_SUBDIR, profile ?? DEFAULT_SESSION_PROFILE);
}

/**
 * Resolve a session name to its state file path:
 * `<cwd>/.ccqa/sessions/<profile>/<name>.json`. The name is a slug (validated
 * by SessionNameSchema), so it can't escape the sessions directory.
 */
export function sessionFilePath(
  name: string,
  profile: string | undefined,
  cwd: string,
): string {
  return join(sessionsDir(profile, cwd), `${name}.json`);
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
 * Write a merged state to a fresh temp file and return its path. Source
 * session files are never modified; the temp file is what gets restored via
 * `--state`, so re-runs (local or CI) leave the source-of-truth untouched.
 */
export async function writeMergedTempState(state: StorageState): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-session-"));
  const file = join(dir, "merged-state.json");
  await writeFile(file, JSON.stringify(state), "utf8");
  return file;
}
