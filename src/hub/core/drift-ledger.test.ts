import { describe, expect, test } from "vitest";
import type { DriftLedger, SpecDriftEntry } from "../contract/schema.ts";
import { emptyDriftLedger, mergeDriftLedgerInto, toDriftLedger } from "./drift-ledger.ts";

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
});
