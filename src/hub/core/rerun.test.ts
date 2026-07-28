import { describe, expect, test } from "vitest";
import type {
  DeployEntry,
  DeployLog,
  DriftLedger,
  SpecLedger,
  SpecLedgerEntry,
  SpecTouchIndex,
} from "../contract/schema.ts";
import { computeRerun, type RerunInput } from "./rerun.ts";
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

function ranAt(deployedSha: string | null, overrides: Partial<SpecLedgerEntry> = {}): SpecLedgerEntry {
  return { gitHead: "head", runId: "run-1", at: "2026-07-25T00:00:00Z", deployedSha, ...overrides };
}

function ledgerWithRun(entry: SpecLedgerEntry | null): SpecLedger {
  return { green: {}, run: entry ? { "f/s": entry } : {}, red: {} };
}

/** A touch index where deploy `index` is the newest one that needed the spec. */
function touchedAt(index: number, matchedPaths: string[] = ["src/a.ts"]): SpecTouchIndex {
  return {
    "f/s": { needed: { index, sha: `sha-${index}`, at: "2026-07-21T00:00:00Z", matchedPaths } },
  };
}

function compute(overrides: Partial<RerunInput> = {}): ReturnType<typeof computeRerun>[string] {
  const result = computeRerun({
    specs: [SPEC],
    ledger: ledgerWithRun(ranAt("sha-0")),
    log: log(deploy(0)),
    touchIndex: {},
    drift: { specs: {} },
    ...overrides,
  });
  return result["f/s"]!;
}

describe("computeRerun", () => {
  test("needed when the touch index records a needed touch after the baseline", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1, ["src/a.ts", "src/b.ts"]),
    });
    expect(verdict.state).toBe("needed");
    expect(verdict.touchedBy).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("notNeeded when nothing in range needed it", () => {
    const verdict = compute({ log: log(deploy(0), deploy(1)) });
    expect(verdict.state).toBe("notNeeded");
    expect(verdict.touchedByDeploy).toBeUndefined();
  });

  test("a touch at the baseline itself does not count against it", () => {
    expect(compute({ touchIndex: touchedAt(0) }).state).toBe("notNeeded");
  });

  test("a sha deployed twice resolves to its earliest position, widening the range", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1), deploy(2, { sha: "sha-0" })),
      touchIndex: touchedAt(1),
    });
    expect(verdict.state).toBe("needed");
  });

  test("touchedBy and touchedByDeploy come from the touch index's needed entry", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1), deploy(2), deploy(3)),
      touchIndex: touchedAt(2, ["src/new.ts"]),
    });
    expect(verdict.touchedBy).toEqual(["src/new.ts"]);
    expect(verdict.touchedByDeploy).toEqual({ index: 2, sha: "sha-2", at: "2026-07-22T00:00:00Z" });
  });

  test("a touch the log still retains is named; one it has evicted is not", () => {
    const short = log(deploy(0), deploy(1));
    expect(compute({ log: short, touchIndex: touchedAt(1) })).toMatchObject({
      state: "needed",
      touchedByDeploy: { index: 1, sha: "sha-1" },
    });

    // The touch index points at a deploy the ring buffer has since evicted:
    // the position still proves a touch in range, but no entry backs the
    // sha, so none is claimed.
    const verdict = compute({ log: short, touchIndex: touchedAt(9) });
    expect(verdict.state).toBe("needed");
    expect(verdict.touchedByDeploy).toBeNull();
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

    test("noSelectionInRange: a deploy in range was recorded without a spec selection", () => {
      const verdict = compute({ log: log(deploy(0), deploy(1, { hasSelection: false })) });
      expect(verdict).toMatchObject({ state: "unknown", reason: "noSelectionInRange" });
    });

    test("selectionUnknown: a selection in range answered unknown for this spec", () => {
      const verdict = compute({
        log: log(deploy(0), deploy(1)),
        touchIndex: { "f/s": { undecidedIndex: 1 } },
      });
      expect(verdict).toMatchObject({ state: "unknown", reason: "selectionUnknown" });
    });

    test("needed in range outranks a gap or a missing selection later in the range", () => {
      const verdict = compute({
        log: log(deploy(0), deploy(1), deploy(2, { gapBefore: true, hasSelection: false })),
        touchIndex: touchedAt(1),
      });
      expect(verdict.state).toBe("needed");
    });
  });

  test("the touch index is compared on log position, not on array offset", () => {
    // A log whose oldest entries were evicted: the baseline sits at array
    // offset 0 but log position 40, and a touch recorded at position 40 is at
    // the baseline, not after it.
    const evicted = log(deploy(40, { gapBefore: true }), deploy(41, { hasSelection: false }));
    expect(
      compute({ log: evicted, ledger: ledgerWithRun(ranAt("sha-40")), touchIndex: touchedAt(40) }),
    ).toMatchObject({ state: "unknown", reason: "noSelectionInRange" });
    expect(
      compute({ log: evicted, ledger: ledgerWithRun(ranAt("sha-40")), touchIndex: touchedAt(41) }).state,
    ).toBe("needed");
  });
});

/** A drift ledger holding one audit verdict for the spec under test. */
function audited(label: "TEST_DRIFT" | "SPEC_CHANGE" | "UNKNOWN" | null): DriftLedger {
  return {
    specs: {
      "f/s": { label, gitHead: "head", runId: "drift-1", at: "2026-07-26T00:00:00Z" },
    },
  };
}

describe("a spec the audit rejected", () => {
  test("is blocked, and carries which repair it needs", () => {
    // The two reasons differ in who repairs them and how long that takes, so
    // collapsing them into a bare "blocked" would hide what matters most.
    expect(compute({ drift: audited("TEST_DRIFT") })).toMatchObject({
      state: "blocked",
      blockedReason: "testDrift",
    });
    expect(compute({ drift: audited("SPEC_CHANGE") })).toMatchObject({
      state: "blocked",
      blockedReason: "specChange",
    });
  });

  test("stays blocked even when it would otherwise need a re-run", () => {
    // Blocking has to win: re-running cannot repair a spec that no longer
    // describes the code, so offering it as `needed` would spend a run to
    // rediscover what the audit already said.
    const verdict = compute({
      drift: audited("SPEC_CHANGE"),
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
    });
    expect(verdict.state).toBe("blocked");
  });

  test("a clean, unknown or absent verdict does not block", () => {
    // "never audited" and "the audit could not tell" are not findings. Treating
    // either as one would stop every newly written spec from ever running.
    expect(compute({ drift: audited(null) }).state).not.toBe("blocked");
    expect(compute({ drift: audited("UNKNOWN") }).state).not.toBe("blocked");
    expect(compute({ drift: { specs: {} } }).state).not.toBe("blocked");
  });
});
