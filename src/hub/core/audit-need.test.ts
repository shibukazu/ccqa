import { describe, expect, test } from "vitest";
import type {
  DeployEntry,
  DeployLog,
  DriftLedger,
  SpecTouchIndex,
} from "../contract/schema.ts";
import type { DriftLabel } from "../../report/schema.ts";
import { computeAuditNeed, type AuditNeedInput } from "./audit-need.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

const SPEC: SpecTarget = { key: "f/s" };

function deploy(index: number, overrides: Partial<DeployEntry> = {}): DeployEntry {
  return {
    index,
    sha: `sha-${index}`,
    previousSha: index === 0 ? null : `sha-${index - 1}`,
    at: `2026-07-2${index}T00:00:00Z`,
    changedPaths: ["docs/x.md"],
    hasSelection: true,
    gapBefore: false,
    ...overrides,
  };
}

function log(...entries: DeployEntry[]): DeployLog {
  return { nextIndex: (entries[entries.length - 1]?.index ?? -1) + 1, entries };
}

function touchedAt(index: number): SpecTouchIndex {
  return {
    "f/s": {
      needed: { index, sha: `sha-${index}`, at: "2026-07-21T00:00:00Z", matchedPaths: ["src/a.ts"] },
    },
  };
}

function auditedAt(label: DriftLabel | null, gitHead: string): DriftLedger {
  return {
    specs: { "f/s": { label, gitHead, runId: "drift-1", at: "2026-07-26T00:00:00Z" } },
  };
}

function compute(overrides: Partial<AuditNeedInput> = {}) {
  return computeAuditNeed({
    specs: [SPEC],
    log: log(deploy(0), deploy(1)),
    touchIndex: {},
    drift: auditedAt(null, "sha-1"),
    ...overrides,
  })["f/s"]!;
}

describe("computeAuditNeed", () => {
  test("a spec never audited is needed, with no diff consulted", () => {
    // The point of the flag: `ccqa select-specs` has nothing to narrow here,
    // because there is no baseline to diff from. A spec no deploy ever reached
    // would otherwise sit un-audited forever.
    expect(compute({ drift: { specs: {} }, touchIndex: {} })).toEqual({ because: "neverAudited" });
  });

  test("a spec in the sweep but not in the report is treated the same way", () => {
    // Added to the tree after the perspectives document was computed. Not an
    // occasion to skip it.
    const out = computeAuditNeed({
      specs: [],
      log: log(deploy(0)),
      touchIndex: {},
      drift: { specs: {} },
    });
    expect(out["f/s"]).toBeUndefined();
  });

  test("not needed when no deploy has reached it since the audit read it", () => {
    expect(compute()).toEqual({ because: "current" });
  });

  test("needed when a deploy since the audit reached it", () => {
    expect(compute({ drift: auditedAt(null, "sha-0"), touchIndex: touchedAt(1) })).toEqual({
      because: "deployReached",
    });
  });

  test("a drifted spec is re-audited once a later deploy reaches it", () => {
    // The label is not a reason to stop looking: the code it complained about
    // may be exactly what the deploy changed.
    expect(
      compute({ drift: auditedAt("SPEC_CHANGE", "sha-0"), touchIndex: touchedAt(1) }),
    ).toMatchObject({ because: "deployReached" });
  });

  test("a hole in the deploy log audits rather than skips", () => {
    // The opposite default to the re-run verdict, and deliberately so: an
    // audit costs cents where a live run costs dollars, so "I cannot tell"
    // does the work here and declines it there.
    expect(
      compute({ drift: auditedAt(null, "sha-0"), log: log(deploy(0), deploy(1, { gapBefore: true })) }),
    ).toMatchObject({ because: "cannotTell", reason: "gapInRange" });

    expect(compute({ drift: auditedAt(null, "sha-0"), log: log() })).toMatchObject({
      because: "cannotTell",
      reason: "noDeployLog",
    });
  });
});
