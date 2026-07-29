import { describe, expect, test } from "vitest";
import type {
  DeployEntry,
  DeployLog,
  DriftLedger,
  SpecLedger,
  SpecLedgerEntry,
  SpecLocks,
  SpecTouchIndex,
} from "../contract/schema.ts";
import type { DriftLabel } from "../../report/schema.ts";
import { emptyLocks } from "./locks.ts";
import { computeRerun, type RerunInput } from "./rerun.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

const SPEC: SpecTarget = { key: "f/s" };
/** Fixed so a hold's expiry is compared against a known point, not the clock. */
const NOW = new Date("2026-07-26T00:00:00Z");

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

/** A ledger whose last run failed: the run and red buckets hold the same entry. */
function ledgerWithFailedRun(entry: SpecLedgerEntry): SpecLedger {
  return { green: {}, run: { "f/s": entry }, red: { "f/s": entry } };
}

/** A touch index where deploy `index` is the newest one that needed the spec. */
function touchedAt(index: number, matchedPaths: string[] = ["src/a.ts"]): SpecTouchIndex {
  return {
    "f/s": { needed: { index, sha: `sha-${index}`, at: "2026-07-21T00:00:00Z", matchedPaths } },
  };
}

/** A drift ledger holding one audit verdict, read at `gitHead`. */
function auditedAt(label: DriftLabel | null, gitHead: string): DriftLedger {
  return {
    specs: { "f/s": { label, gitHead, runId: "drift-1", at: "2026-07-26T00:00:00Z" } },
  };
}

function compute(overrides: Partial<RerunInput> = {}): ReturnType<typeof computeRerun>[string] {
  const base = {
    specs: [SPEC],
    ledger: ledgerWithRun(ranAt("sha-0")),
    log: log(deploy(0)),
    touchIndex: {},
    locks: emptyLocks(),
    now: NOW,
    ...overrides,
  };
  // Default the audit to "clean, read at the newest deploy". Without it every
  // case below would answer `inProgress` on the audit axis before the run axis
  // was ever consulted, which is correct behaviour but useless for isolating
  // the run side.
  const drift = overrides.drift ?? auditedAt(null, base.log.entries.at(-1)?.sha ?? "no-deploys");
  return computeRerun({ ...base, drift })["f/s"]!;
}

describe("computeRerun: the run axis, with the audit already current", () => {
  test("rerunNeeded when the touch index records a touch after the baseline", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1, ["src/a.ts", "src/b.ts"]),
    });
    expect(verdict.verdict).toBe("rerunNeeded");
    expect(verdict.execution).toBe("passed");
    expect(verdict.touchedBy).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("verified when nothing in range reached it", () => {
    const verdict = compute({ log: log(deploy(0), deploy(1)) });
    expect(verdict.verdict).toBe("verified");
    expect(verdict.audit).toBe("clean");
    expect(verdict.touchedByDeploy).toBeUndefined();
  });

  test("a touch at the baseline itself does not count against it", () => {
    expect(compute({ touchIndex: touchedAt(0) }).verdict).toBe("verified");
  });

  test("a sha deployed twice resolves to its earliest position, widening the range", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1), deploy(2, { sha: "sha-0" })),
      touchIndex: touchedAt(1),
      // Pinned to the touch's own deploy so the audit is current and the run
      // side is what the case is testing.
      drift: auditedAt(null, "sha-1"),
    });
    expect(verdict.verdict).toBe("rerunNeeded");
  });

  test("touchedBy and touchedByDeploy come from the touch index's needed entry", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1), deploy(2), deploy(3)),
      touchIndex: touchedAt(2, ["src/new.ts"]),
    });
    expect(verdict.touchedBy).toEqual(["src/new.ts"]);
    expect(verdict.touchedByDeploy).toEqual({ index: 2, sha: "sha-2", at: "2026-07-22T00:00:00Z" });
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

  test("a spec that has never run is rerunNeeded, not a category of its own", () => {
    // No result at all is as uncovered as a result a deploy invalidated, and
    // the action is identical: run it. A separate state only meant new specs
    // sat out every cycle until someone opted them in by hand.
    const verdict = compute({ ledger: ledgerWithRun(null) });
    expect(verdict.execution).toBe("neverRun");
    expect(verdict.verdict).toBe("rerunNeeded");
  });

  describe("unanswerable, never `verified`", () => {
    test("notEvaluated: the profile has neither a run nor a deploy recorded", () => {
      // A profile-wide fact, so it replaces the verdict without touching the
      // axes — the same spec must not read differently because some *other*
      // spec happens to have a run.
      expect(compute({ ledger: ledgerWithRun(null), log: log(), drift: { specs: {} } })).toMatchObject({
        verdict: "unanswerable",
        reason: "notEvaluated",
        audit: "due",
        execution: "neverRun",
      });
    });

    test("noDeployLog: the profile's deploy job is not wired up", () => {
      // The spec has both a run and an audit; what is missing is the log that
      // would position either of them.
      const verdict = compute({
        log: log(),
        ledger: ledgerWithRun(ranAt("sha-0")),
        drift: auditedAt(null, "sha-0"),
      });
      expect(verdict).toMatchObject({ verdict: "unanswerable", reason: "noDeployLog" });
    });

    test("unknownDeployedSha: the run was never attributed to a deploy", () => {
      const verdict = compute({ ledger: ledgerWithRun(ranAt(null)) });
      expect(verdict).toMatchObject({ verdict: "unanswerable", reason: "unknownDeployedSha" });
    });

    test("ambiguousDeployedSha: the run straddled a deploy", () => {
      const verdict = compute({
        ledger: ledgerWithRun(ranAt("sha-0", { deployedShaAmbiguous: true })),
      });
      expect(verdict).toMatchObject({ verdict: "unanswerable", reason: "ambiguousDeployedSha" });
    });

    test("deployedShaNotInLog: the baseline is older than the retained log", () => {
      const verdict = compute({ ledger: ledgerWithRun(ranAt("sha-evicted")) });
      expect(verdict).toMatchObject({ verdict: "unanswerable", reason: "deployedShaNotInLog" });
    });

    test("gapInRange: deploys are missing between the baseline and now", () => {
      const verdict = compute({ log: log(deploy(0), deploy(1, { gapBefore: true })) });
      expect(verdict).toMatchObject({ verdict: "unanswerable", reason: "gapInRange" });
    });

    test("selectionUnknown: a selection in range answered unknown for this spec", () => {
      const verdict = compute({
        log: log(deploy(0), deploy(1)),
        touchIndex: { "f/s": { undecidedIndex: 1 } },
      });
      expect(verdict).toMatchObject({ verdict: "unanswerable", reason: "selectionUnknown" });
    });

    test("a touch in range outranks a gap later in the range", () => {
      const verdict = compute({
        log: log(deploy(0), deploy(1), deploy(2, { gapBefore: true })),
        touchIndex: touchedAt(1),
      });
      expect(verdict.verdict).toBe("rerunNeeded");
    });
  });

  test("the touch index is compared on log position, not on array offset", () => {
    // A log whose oldest entries were evicted: the baseline sits at array
    // offset 0 but log position 40, and a touch recorded at position 40 is at
    // the baseline, not after it.
    const evicted = log(deploy(40, { gapBefore: true }), deploy(41));
    expect(
      compute({
        log: evicted,
        ledger: ledgerWithRun(ranAt("sha-40")),
        touchIndex: touchedAt(40),
        drift: auditedAt(null, "sha-41"),
      }).verdict,
    ).toBe("verified");
    expect(
      compute({
        log: evicted,
        ledger: ledgerWithRun(ranAt("sha-40")),
        touchIndex: touchedAt(41),
        drift: auditedAt(null, "sha-41"),
      }).verdict,
    ).toBe("rerunNeeded");
  });
});

describe("computeRerun: the audit axis", () => {
  test("a spec never audited is checking, and its verdict is inProgress", () => {
    // Not `needsRepair`: nobody has found anything. Not `rerunNeeded` either —
    // running before the audit has spoken is what the whole ordering exists to
    // prevent.
    const verdict = compute({ drift: { specs: {} } });
    expect(verdict.audit).toBe("due");
    expect(verdict.verdict).toBe("inProgress");
  });

  test("an audit that read an older commit is checking, not clean", () => {
    // The audit answered about a commit a later deploy has already replaced
    // for this spec, so it says nothing about what is running now.
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
      drift: auditedAt(null, "sha-0"),
    });
    expect(verdict.audit).toBe("due");
    expect(verdict.verdict).toBe("inProgress");
  });

  test("an audit whose commit no deploy reached since still stands", () => {
    const verdict = compute({ log: log(deploy(0), deploy(1)), drift: auditedAt(null, "sha-0") });
    expect(verdict.audit).toBe("clean");
    expect(verdict.verdict).toBe("verified");
  });

  test("drift and an undecided audit both need a person, and carry which", () => {
    // The label rides along because the three repairs go to different people:
    // a re-record, a spec rewrite, and a look at why the audit could not tell.
    expect(compute({ drift: auditedAt("TEST_DRIFT", "sha-0") })).toMatchObject({
      verdict: "needsRepair",
      audit: "drifted",
      driftLabel: "TEST_DRIFT",
    });
    expect(compute({ drift: auditedAt("SPEC_CHANGE", "sha-0") })).toMatchObject({
      verdict: "needsRepair",
      audit: "drifted",
      driftLabel: "SPEC_CHANGE",
    });
    expect(compute({ drift: auditedAt("UNKNOWN", "sha-0") })).toMatchObject({
      verdict: "needsRepair",
      audit: "undecided",
    });
  });

  test("drift outranks a needed re-run", () => {
    // Re-running cannot repair a spec that no longer describes the code, so
    // offering it would spend a run to rediscover what the audit already said.
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
      drift: auditedAt("SPEC_CHANGE", "sha-1"),
    });
    expect(verdict.verdict).toBe("needsRepair");
  });
});

describe("computeRerun: a failed run", () => {
  test("is needsRepair, and is not offered for a re-run", () => {
    // Re-running a red spec teaches nothing until the code it exercises moves
    // or the spec is fixed, and a live spec costs dollars a go.
    const verdict = compute({ ledger: ledgerWithFailedRun(ranAt("sha-0")) });
    expect(verdict.execution).toBe("failed");
    expect(verdict.verdict).toBe("needsRepair");
  });

  test("stays needsRepair even when a later deploy reached the spec", () => {
    // The order is deliberate: a red result is current information, so its age
    // is not the question. What clears it is a repair, and the repair shows up
    // as a new run.
    const verdict = compute({
      ledger: ledgerWithFailedRun(ranAt("sha-0")),
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
      drift: auditedAt(null, "sha-1"),
    });
    expect(verdict.verdict).toBe("needsRepair");
  });

  test("a spec whose last run passed after an earlier failure is not failed", () => {
    // Both buckets hold entries; only the one naming the same run as `run`
    // describes the last execution.
    const failed = ranAt("sha-0", { runId: "run-0", at: "2026-07-01T00:00:00Z" });
    const passed = ranAt("sha-0", { runId: "run-1" });
    const verdict = compute({
      ledger: { green: { "f/s": passed }, run: { "f/s": passed }, red: { "f/s": failed } },
    });
    expect(verdict.execution).toBe("passed");
    expect(verdict.verdict).toBe("verified");
  });
});

describe("computeRerun: a job already on the spec", () => {
  function heldLocks(expiresAt: string): SpecLocks {
    return { specs: { "f/s": { kind: "run", holder: "run-9", expiresAt } } };
  }

  test("is inProgress, whatever the axes would otherwise say", () => {
    // Acting on any other answer would race the job that is on it.
    const verdict = compute({
      locks: heldLocks("2026-07-26T01:00:00Z"),
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
    });
    expect(verdict.verdict).toBe("inProgress");
    expect(verdict.heldBy).toMatchObject({ kind: "run", holder: "run-9" });
  });

  test("outranks even a repair the audit found", () => {
    const verdict = compute({
      locks: heldLocks("2026-07-26T01:00:00Z"),
      drift: auditedAt("SPEC_CHANGE", "sha-0"),
    });
    expect(verdict.verdict).toBe("inProgress");
  });

  test("a lapsed hold reads as free, with no reaper having run", () => {
    // The job died without releasing. Nothing swept the document; the expiry
    // is simply compared on read.
    const verdict = compute({ locks: heldLocks("2026-07-25T23:59:00Z") });
    expect(verdict.heldBy).toBeNull();
    expect(verdict.verdict).toBe("verified");
  });
});
