import { describe, expect, test } from "vitest";
import type { DeployEntry, DeployLog, SpecLedger, SpecLedgerEntry, SpecTouchIndex } from "../contract/schema.ts";
import { computeRerun, type RerunInput } from "./rerun.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

const SPEC: SpecTarget = { key: "f/s", relatedPaths: ["src/**"] };

function deploy(index: number, overrides: Partial<DeployEntry> = {}): DeployEntry {
  return {
    index,
    sha: `sha-${index}`,
    previousSha: index === 0 ? null : `sha-${index - 1}`,
    at: `2026-07-2${index}T00:00:00Z`,
    changedPaths: ["docs/x.md"],
    truncated: false,
    gapBefore: false,
    ...overrides,
  };
}

function log(...entries: DeployEntry[]): DeployLog {
  return { nextIndex: (entries[entries.length - 1]?.index ?? -1) + 1, entries };
}

function ranAt(deployedSha: string | null, overrides: Partial<SpecLedgerEntry> = {}): SpecLedgerEntry {
  return { gitHead: "head", runId: "run-1", at: "2026-07-25T00:00:00Z", deployedSha, ...overrides };
}

function ledgerWithRun(entry: SpecLedgerEntry | null): SpecLedger {
  return { green: {}, run: entry ? { "f/s": entry } : {}, red: {} };
}

function touchedAt(index: number, matchedPaths: string[] = ["src/a.ts"]): SpecTouchIndex {
  return {
    "f/s": {
      lastTouchedIndex: index,
      lastTouchedSha: `sha-${index}`,
      lastTouchedAt: "2026-07-21T00:00:00Z",
      matchedPaths,
    },
  };
}

function compute(overrides: Partial<RerunInput> = {}): ReturnType<typeof computeRerun>[string] {
  const result = computeRerun({
    specs: [SPEC],
    ledger: ledgerWithRun(ranAt("sha-0")),
    log: log(deploy(0)),
    touchIndex: {},
    ...overrides,
  });
  return result["f/s"]!;
}

describe("computeRerun", () => {
  test("needed when a deploy after the baseline touches the spec's relatedPaths", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1, { changedPaths: ["src/a.ts", "src/b.ts"] })),
    });
    expect(verdict.state).toBe("needed");
    expect(verdict.touchedBy).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("notNeeded when every deploy after the baseline misses it", () => {
    expect(compute({ log: log(deploy(0), deploy(1)) }).state).toBe("notNeeded");
  });

  test("the deploy the spec ran against does not count against itself", () => {
    // The baseline deploy touched the spec, but the run already exercised it.
    expect(compute({ log: log(deploy(0, { changedPaths: ["src/a.ts"] })) }).state).toBe("notNeeded");
  });

  test("a sha deployed twice resolves to its earliest position, widening the range", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1, { changedPaths: ["src/a.ts"] }), deploy(2, { sha: "sha-0" })),
    });
    expect(verdict.state).toBe("needed");
  });

  test("`touchedBy` comes from the most recent touching deploy", () => {
    const verdict = compute({
      log: log(
        deploy(0),
        deploy(1, { changedPaths: ["src/old.ts"] }),
        deploy(2, { changedPaths: ["src/new.ts"] }),
      ),
    });
    expect(verdict.touchedBy).toEqual(["src/new.ts"]);
  });

  test("the three ledger coordinates ride along with every verdict", () => {
    const run = ranAt("sha-0");
    const green: SpecLedgerEntry = { gitHead: "g", runId: "run-0", at: "2026-07-01T00:00:00Z", deployedSha: null };
    const verdict = compute({
      ledger: { green: { "f/s": green }, run: { "f/s": run }, red: { "f/s": run } },
    });
    expect(verdict.lastRun).toEqual(run);
    expect(verdict.lastGreen).toEqual(green);
    expect(verdict.lastRed).toEqual(run);
  });

  test("neverRun when the spec has no run entry but the profile has data", () => {
    expect(compute({ ledger: ledgerWithRun(null) }).state).toBe("neverRun");
  });

  test("notEvaluated when the profile has neither a run nor a deploy recorded", () => {
    expect(compute({ ledger: ledgerWithRun(null), log: log() }).state).toBe("notEvaluated");
  });

  describe("unknown, never `notNeeded`", () => {
    test("noRelatedPaths: the spec declares nothing to match against", () => {
      const verdict = compute({ specs: [{ key: "f/s", relatedPaths: [] }] });
      expect(verdict).toMatchObject({ state: "unknown", reason: "noRelatedPaths" });
    });

    test("noDeployLog: the profile's deploy job is not wired up", () => {
      const verdict = compute({ log: log(), ledger: ledgerWithRun(ranAt("sha-0")) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "noDeployLog" });
    });

    test("unknownDeployedSha: the run was never attributed to a deploy", () => {
      const verdict = compute({ ledger: ledgerWithRun(ranAt(null)) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "unknownDeployedSha" });
    });

    test("ambiguousDeployedSha: the run straddled a deploy", () => {
      const verdict = compute({
        ledger: ledgerWithRun(ranAt("sha-0", { deployedShaAmbiguous: true })),
      });
      expect(verdict).toMatchObject({ state: "unknown", reason: "ambiguousDeployedSha" });
    });

    test("deployedShaNotInLog: the baseline is older than the retained log", () => {
      const verdict = compute({ ledger: ledgerWithRun(ranAt("sha-evicted")) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "deployedShaNotInLog" });
    });

    test("gapInRange: deploys are missing between the baseline and now", () => {
      const verdict = compute({ log: log(deploy(0), deploy(1, { gapBefore: true })) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "gapInRange" });
    });

    test("truncatedInRange: a deploy in range no longer lists all it changed", () => {
      const verdict = compute({ log: log(deploy(0), deploy(1, { truncated: true })) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "truncatedInRange" });
    });

    test("truncatedInRange: a deploy in range reported no paths at all", () => {
      const verdict = compute({ log: log(deploy(0), deploy(1, { changedPaths: null })) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "truncatedInRange" });
    });

    test("a definite match outranks a gap or truncation later in the range", () => {
      const verdict = compute({
        log: log(deploy(0), deploy(1, { changedPaths: ["src/a.ts"] }), deploy(2, { gapBefore: true })),
      });
      expect(verdict.state).toBe("needed");
    });
  });

  test("the write-time touch index rescues a range the retained log can no longer match", () => {
    const truncated = log(deploy(0), deploy(1, { truncated: true }));
    expect(compute({ log: truncated, touchIndex: touchedAt(1) }).state).toBe("needed");

    // A touch at or before the baseline proves nothing about the range.
    expect(compute({ log: truncated, touchIndex: touchedAt(0) })).toMatchObject({
      state: "unknown",
      reason: "truncatedInRange",
    });
  });

  test("the touch index is compared on log position, not on array offset", () => {
    // A log whose oldest entries were evicted: the baseline sits at array
    // offset 0 but log position 40, and a touch recorded at position 40 is at
    // the baseline, not after it.
    const evicted = log(deploy(40, { gapBefore: true }), deploy(41, { truncated: true }));
    expect(compute({ log: evicted, ledger: ledgerWithRun(ranAt("sha-40")), touchIndex: touchedAt(40) })).toMatchObject({
      state: "unknown",
      reason: "truncatedInRange",
    });
    expect(
      compute({ log: evicted, ledger: ledgerWithRun(ranAt("sha-40")), touchIndex: touchedAt(41) }).state,
    ).toBe("needed");
  });

  test("the touch index never overrides a conclusive log scan", () => {
    // Folded when the spec still claimed `src/**`; its relatedPaths have since
    // narrowed, and the retained log can answer, so the current paths win.
    const verdict = compute({
      specs: [{ key: "f/s", relatedPaths: ["src/kept/**"] }],
      log: log(deploy(0), deploy(1, { changedPaths: ["src/a.ts"] })),
      touchIndex: touchedAt(1),
    });
    expect(verdict.state).toBe("notNeeded");
  });
});
