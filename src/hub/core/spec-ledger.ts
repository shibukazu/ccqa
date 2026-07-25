import type { SpecLedger, SpecLedgerEntry } from "../contract/schema.ts";

/**
 * Pure spec-ledger format rules: the empty document, the read-time shape
 * normalization that carries pre-`run`/`red` documents forward, and the
 * advance-only merge. Backend-independent, so a second storage backend
 * inherits them rather than re-deriving them.
 */

type Bucket = Record<string, SpecLedgerEntry>;

const BUCKET_NAMES = ["green", "run", "red"] as const;

export function emptyLedger(): SpecLedger {
  return { green: {}, run: {}, red: {} };
}

/**
 * Documents written before the ledger grew `run` and `red` are a flat
 * `Record<specKey, entry>` of greens. A spec key is "feature/spec" and always
 * contains a '/', so it can never collide with a bucket name and the two
 * shapes are unambiguous. The first `merge` rewrites the file in the new
 * shape; nothing else migrates it.
 */
export function toLedger(raw: unknown): SpecLedger {
  if (raw === null || typeof raw !== "object") return emptyLedger();
  const doc = raw as Record<string, unknown>;
  if (!BUCKET_NAMES.some((name) => name in doc)) return { green: doc as Bucket, run: {}, red: {} };
  return {
    green: (doc["green"] as Bucket | undefined) ?? {},
    run: (doc["run"] as Bucket | undefined) ?? {},
    red: (doc["red"] as Bucket | undefined) ?? {},
  };
}

/** Fold `from` into `into` in place, per bucket and key, newest `at` winning. */
export function mergeLedgerInto(into: SpecLedger, from: SpecLedger): SpecLedger {
  for (const name of BUCKET_NAMES) {
    for (const [key, entry] of Object.entries(from[name])) {
      const prev = into[name][key];
      // Only advance: a late-finalizing older run must not move a baseline
      // backwards past a newer one.
      if (!prev || prev.at <= entry.at) into[name][key] = entry;
    }
  }
  return into;
}
