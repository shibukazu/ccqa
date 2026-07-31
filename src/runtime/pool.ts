/**
 * Run each item through `fn` with at most `concurrency` running at once, and
 * never two items sharing a `resources` name. Results preserve input order.
 * A throwing `fn` stops the queue and rejects the pool once the in-flight
 * items have settled — nothing here can cancel them, and an unobserved
 * rejection is worse.
 */
export interface PoolOptions<T> {
  /** Shared resource names for an item. Items sharing one are serialised against each other. */
  resources?: (item: T) => readonly string[];
}

export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: PoolOptions<T> = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const needs = items.map((item) => opts.resources?.(item) ?? []);
  const busy = new Set<string>();
  // A Set keeps insertion order, so "oldest runnable first" survives removal.
  const queued = new Set(items.map((_, i) => i));
  const inFlight = new Map<number, Promise<void>>();
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const failures: unknown[] = [];

  const start = (idx: number): void => {
    queued.delete(idx);
    for (const name of needs[idx]!) busy.add(name);
    // Deferred to a microtask so the registration below always precedes the
    // `finally`'s delete. Called inline, an `fn` that throws synchronously
    // would delete before it was ever set, leaving the entry — and its
    // resource names — held forever while the loop spins.
    inFlight.set(idx, Promise.resolve().then(async () => {
      try {
        results[idx] = await fn(items[idx]!, idx);
      } catch (err) {
        // Collected rather than thrown: rejecting here would leave the other
        // in-flight promises unobserved, and they keep running regardless.
        failures.push(err);
      } finally {
        for (const name of needs[idx]!) busy.delete(name);
        inFlight.delete(idx);
      }
    }));
  };

  while (queued.size > 0 || inFlight.size > 0) {
    // A pool that has already failed is going to reject, so stop launching:
    // on the live path every queued item is another paid Claude session.
    if (failures.length === 0) {
      // Oldest runnable first, so an item whose resource is busy is not starved
      // by later ones that keep taking the slot it is waiting for.
      for (const idx of queued) {
        if (inFlight.size >= limit) break;
        if (needs[idx]!.some((name) => busy.has(name))) continue;
        start(idx);
      }
      // Only in-flight items mark a resource busy, so this cannot happen — but
      // returning a results array with holes silently would be worse.
      if (inFlight.size === 0) {
        throw new Error(`runPool: ${queued.size} item(s) unrunnable with nothing in flight`);
      }
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight.values());
  }

  // Every failure, not just the first: which one wins is otherwise a matter of
  // timing, and the same broken tree reports a different error each run.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} items failed`);
  return results;
}
