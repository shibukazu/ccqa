import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getSpecDir } from "./index.ts";
import * as log from "../cli/logger.ts";

/**
 * Per-spec advisory lock for `ccqa record` / `ccqa generate`. Two concurrent
 * generations of the same spec interleave writes to ir.json, test files, and
 * the generated.json manifest with no defined winner, so the second caller
 * must fail fast instead. The lock is a JSON file in the spec directory
 * created with O_EXCL; a lock whose PID is no longer alive (crashed or
 * SIGKILLed run) is reclaimed automatically, so abnormal exits never wedge a
 * spec. Same-machine only by design — the spec tree is a local working copy.
 */

export const SPEC_LOCK_FILE = ".ccqa-lock.json";

interface SpecLockBody {
  pid: number;
  command: string;
  startedAt: string;
}

/** Thrown when another live process holds the spec lock. */
export class SpecLockedError extends Error {
  constructor(lockPath: string, body: SpecLockBody | null) {
    const holder = body
      ? `pid ${body.pid} (${body.command}, started ${body.startedAt})`
      : "an unknown process";
    super(
      `another ccqa record/generate is already running for this spec — held by ${holder}. ` +
        `Wait for it to finish, or delete ${lockPath} if you are sure it is stale.`,
    );
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to another user — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the lock for `<feature>/<spec>`; returns a release function. Throws
 * `SpecLockedError` when a live process already holds it. A stale lock (dead
 * PID or unreadable body) is reclaimed with a warning.
 */
export async function acquireSpecLock(
  featureName: string,
  specName: string,
  command: string,
  cwd?: string,
): Promise<() => Promise<void>> {
  const lockPath = join(getSpecDir(featureName, specName, cwd), SPEC_LOCK_FILE);
  const body: SpecLockBody = {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify(body, null, 2) + "\n", "utf8");
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = await readLockBody(lockPath);
      // Re-entrant hold (ccqa record calls runGenerate in-process): the outer
      // acquisition owns the file; the inner one is a no-op.
      if (existing && existing.pid === process.pid) return async () => {};
      if (existing && isPidAlive(existing.pid)) throw new SpecLockedError(lockPath, existing);
      // Dead holder (crash / SIGKILL) or unreadable body: reclaim and retry
      // the exclusive create once — a concurrent reclaimer may win the race,
      // in which case the second iteration reports it as the live holder.
      log.warn(
        `removing stale spec lock ${lockPath}` +
          (existing ? ` (pid ${existing.pid} is gone)` : " (unreadable)"),
      );
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new SpecLockedError(lockPath, await readLockBody(lockPath));
}

async function readLockBody(lockPath: string): Promise<SpecLockBody | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<SpecLockBody>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      command: typeof parsed.command === "string" ? parsed.command : "?",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "?",
    };
  } catch {
    return null;
  }
}
