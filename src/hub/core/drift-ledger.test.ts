import { describe, expect, test } from "vitest";
import type { DriftLedger, SpecDriftEntry } from "../contract/schema.ts";
import { emptyDriftLedger, gradedDriftEntry, mergeDriftLedgerInto, toDriftLedger } from "./drift-ledger.ts";

function entry(overrides: Partial<SpecDriftEntry> = {}): SpecDriftEntry {
  return { label: null, gitHead: "a", runId: "r", at: "2026-07-21T00:00:00Z", ...overrides };
}

function ledger(specs: Record<string, SpecDriftEntry>): DriftLedger {
  return { specs };
}

describe("drift ledger", () => {
  test("merge only advances: an older run cannot move an entry backwards", () => {
    const newer = entry({ gitHead: "new", runId: "r2", at: "2026-07-22T00:00:00Z", label: "TEST_DRIFT" });
    const older = entry({ gitHead: "old", runId: "r1", at: "2026-07-21T00:00:00Z" });
    const into = mergeDriftLedgerInto(emptyDriftLedger(), ledger({ "f/s": newer }));
    mergeDriftLedgerInto(into, ledger({ "f/s": older, "f/other": older }));

    expect(into.specs["f/s"]?.gitHead).toBe("new");
    expect(into.specs["f/other"]?.gitHead).toBe("old"); // new key still lands
  });

  test("label: null (audited, no drift) and a missing key (never audited) stay distinct", () => {
    const into = mergeDriftLedgerInto(emptyDriftLedger(), ledger({ "f/clean": entry({ label: null }) }));

    expect(into.specs["f/clean"]).toBeDefined();
    expect(into.specs["f/clean"]?.label).toBeNull();
    expect(into.specs["f/never-audited"]).toBeUndefined();
  });

  test("a diagnosed entry carries surface/confidence/headline; toDriftLedger tolerates a bare/empty document", () => {
    const diagnosed = entry({ label: "SPEC_CHANGE", surface: "spec", confidence: 0.8, headline: "UI redesign" });
    const into = mergeDriftLedgerInto(emptyDriftLedger(), ledger({ "f/s": diagnosed }));
    expect(into.specs["f/s"]).toMatchObject({ label: "SPEC_CHANGE", surface: "spec", confidence: 0.8 });

    expect(toDriftLedger(null)).toEqual(emptyDriftLedger());
    expect(toDriftLedger({})).toEqual(emptyDriftLedger());
  });

  test("a grade replaces the verdict, and clearing a row drops the finding's caption", () => {
    const led = ledger({
      "f/s": entry({ label: "TEST_DRIFT", surface: "spec", confidence: 0.9, headline: "stale copy" }),
    });

    const corrected = gradedDriftEntry(led, "f/s", "r", "SPEC_CHANGE");
    expect(corrected).toMatchObject({ label: "SPEC_CHANGE", graded: true, headline: "stale copy" });

    // Cleared: surface/headline/confidence described a finding that is now
    // withdrawn, so leaving them would caption "no drift" with the old claim.
    const cleared = gradedDriftEntry(led, "f/s", "r", null);
    expect(cleared).toMatchObject({ label: null, graded: true });
    expect(cleared).not.toHaveProperty("surface");
    expect(cleared).not.toHaveProperty("headline");
    expect(cleared).not.toHaveProperty("confidence");
  });

  test("grading an older run never overwrites a newer audit of the same spec", () => {
    // The failure this guards: grading is retrospective, so a correction to a
    // run from last week must not land on top of an audit of newer code.
    const led = ledger({ "f/s": entry({ runId: "newer-run", label: "TEST_DRIFT" }) });

    expect(gradedDriftEntry(led, "f/s", "older-run", null)).toBeNull();
    expect(gradedDriftEntry(led, "f/never-audited", "newer-run", null)).toBeNull();
    expect(gradedDriftEntry(led, "f/s", "newer-run", null)).not.toBeNull();
  });
});
