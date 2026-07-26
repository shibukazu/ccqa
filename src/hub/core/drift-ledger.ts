import type { DriftLedger, SpecDriftEntry } from "../contract/schema.ts";

/**
 * Pure drift-ledger format rules: the empty document and the advance-only
 * merge. Mirrors spec-ledger.ts's shape, but the two must stay separate
 * modules — a spec ledger answers "is the last result still trustworthy"
 * (profile-scoped), a drift ledger answers "does the spec still describe the
 * code" (not profile-scoped), and folding them together would blur that.
 */

export function emptyDriftLedger(): DriftLedger {
  return { specs: {} };
}

export function toDriftLedger(raw: unknown): DriftLedger {
  if (raw === null || typeof raw !== "object") return emptyDriftLedger();
  const doc = raw as Record<string, unknown>;
  return { specs: (doc["specs"] as Record<string, SpecDriftEntry> | undefined) ?? {} };
}

/** Fold `from` into `into` in place, per key, newest `at` winning. */
export function mergeDriftLedgerInto(into: DriftLedger, from: DriftLedger): DriftLedger {
  for (const [key, entry] of Object.entries(from.specs)) {
    const prev = into.specs[key];
    // Only advance: a late-finalizing older run must not move a baseline
    // backwards past a newer one.
    if (!prev || prev.at <= entry.at) into.specs[key] = entry;
  }
  return into;
}
