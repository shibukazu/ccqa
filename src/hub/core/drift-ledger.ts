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

/**
 * The entry a human grade should leave, or null when the grade must not touch
 * the ledger.
 *
 * The guard is the point. Grading is retrospective — a run from last week can
 * be graded today — and the ledger holds one entry per spec, the newest audit.
 * Writing the grade unconditionally would let a correction to an old verdict
 * overwrite a newer audit of newer code, which is the one direction that
 * silently loses a real finding.
 *
 * `label: null` is how a cleared row is recorded, the same shape a clean audit
 * produces, so every reader already handles it.
 */
export function gradedDriftEntry(
  ledger: DriftLedger,
  key: string,
  runId: string,
  label: SpecDriftEntry["label"],
): SpecDriftEntry | null {
  const entry = ledger.specs[key];
  if (!entry || entry.runId !== runId) return null;
  if (entry.label === label && entry.graded === true) return null;
  const graded: SpecDriftEntry = { ...entry, label, graded: true };
  // None of these describes a cleared row; leaving them would caption a "no
  // drift" entry with the finding the audit had claimed.
  if (label === null) {
    delete graded.surface;
    delete graded.subDiagnosis;
    delete graded.headline;
    delete graded.confidence;
  }
  // Narrower than the above: a regrade from SPEC_CHANGE to any other answer
  // leaves a repair kind that names a spec change nobody now claims.
  if (label !== "SPEC_CHANGE") delete graded.specChangeKind;
  return graded;
}
