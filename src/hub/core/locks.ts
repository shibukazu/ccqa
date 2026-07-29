import type { SpecLock, SpecLocks } from "../contract/schema.ts";

/**
 * Which specs a job may work on, and which one is already busy.
 *
 * A hold lapses rather than being reaped: `expiresAt` is compared on every
 * read, so a job killed without releasing frees its specs by itself. The cost
 * is that they stay held until it passes, which is why the caller picks the
 * TTL from how long its own work can take.
 */
export function emptyLocks(): SpecLocks {
  return { specs: {} };
}

/** The holder of `key`, or null when nobody holds it or the hold has lapsed. */
export function heldBy(locks: SpecLocks, key: string, now: Date): SpecLock | null {
  const lock = locks.specs[key];
  if (!lock) return null;
  return Date.parse(lock.expiresAt) > now.getTime() ? lock : null;
}

export interface AcquireInput {
  specs: readonly string[];
  kind: SpecLock["kind"];
  /** Opaque id of the job asking. Re-asking with the same one extends its hold. */
  holder: string;
  ttlSeconds: number;
  now: Date;
}

/**
 * Take what is free, report what is not.
 *
 * Re-asking for what this job already holds extends it, which is how a job
 * that outlives its own TTL keeps its specs. A spec another job holds is
 * denied rather than stolen — the caller skips it this cycle.
 */
export function acquire(
  locks: SpecLocks,
  input: AcquireInput,
): { locks: SpecLocks; granted: string[]; denied: string[] } {
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000).toISOString();
  const specs = { ...locks.specs };
  const granted: string[] = [];
  const denied: string[] = [];
  for (const key of input.specs) {
    const current = heldBy(locks, key, input.now);
    if (current && current.holder !== input.holder) {
      denied.push(key);
      continue;
    }
    specs[key] = { kind: input.kind, holder: input.holder, expiresAt };
    granted.push(key);
  }
  return { locks: { specs }, granted, denied };
}

/**
 * Drop everything this job holds. Keyed by holder rather than by spec so a job
 * that lost track of what it took still releases all of it, and so a late
 * release from a job whose hold already lapsed cannot take away a lock the
 * next one has since acquired.
 */
export function releaseAll(locks: SpecLocks, holder: string): SpecLocks {
  const specs: SpecLocks["specs"] = {};
  for (const [key, lock] of Object.entries(locks.specs)) {
    if (lock.holder !== holder) specs[key] = lock;
  }
  return { specs };
}
