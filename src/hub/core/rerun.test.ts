import { describe, expect, test } from "vitest";
import type {
  Attestation,
  Attestations,
  AuditDismissals,
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

/** An attestation recorded at `deployedSha`, after every fixture timestamp above. */
function attested(deployedSha: string | null, overrides: Partial<Attestation> = {}): Attestations {
  return {
    specs: { "f/s": { by: "a-person", at: "2026-07-26T12:00:00Z", deployedSha, ...overrides } },
  };
}

function compute(overrides: Partial<RerunInput> = {}): ReturnType<typeof computeRerun>[string] {
  const base = {
    specs: [SPEC],
    ledger: ledgerWithRun(ranAt("sha-0")),
    log: log(deploy(0)),
    touchIndex: {},
    locks: emptyLocks(),
    attestations: { specs: {} },
    dismissals: { specs: {} },
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
    expect(verdict.execution).toBe("stale");
    // A deploy proved the touch, so nothing was assumed.
    expect(verdict.executionAssumedReached).toBeUndefined();
    expect(verdict.touchedBy).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("verified when nothing in range reached it", () => {
    const verdict = compute({ log: log(deploy(0), deploy(1)) });
    expect(verdict.verdict).toBe("verified");
    expect(verdict.audit).toBe("clean");
    expect(verdict.touchedByDeploy).toBeUndefined();
  });

  test("a selection in range answered unknown: not a reach, the spec stays verified (ADR-0023)", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: { "f/s": { undecidedIndex: 1 } },
    });
    expect(verdict).toMatchObject({
      verdict: "verified",
      execution: "passed",
    });
    expect(verdict.executionAssumedReached).toBeUndefined();
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

  test("never run and invalidated share a verdict but not an axis value", () => {
    // Both run, so the verdict is the same. A list that merged them could not
    // tell a spec added yesterday from one a deploy overtook.
    const never = compute({ ledger: ledgerWithRun(null) });
    const stale = compute({ log: log(deploy(0), deploy(1)), touchIndex: touchedAt(1) });
    expect(never.verdict).toBe(stale.verdict);
    expect(never.execution).not.toBe(stale.execution);
    expect([never.execution, stale.execution]).toEqual(["neverRun", "stale"]);
  });

  describe("a run the deploy log cannot place is stale, never `verified`", () => {
    test("the profile has neither a run nor a deploy recorded", () => {
      // Nothing to place anything against: the audit owes an answer, so the
      // verdict waits for it rather than being a question mark of its own.
      expect(compute({ ledger: ledgerWithRun(null), log: log(), drift: { specs: {} } })).toMatchObject({
        verdict: "inProgress",
        audit: "due",
        execution: "neverRun",
      });
    });

    test("noDeployLog: the profile's deploy job is not wired up", () => {
      // The spec has both a run and an audit; what is missing is the log that
      // would position either of them. Both are assumed reached, and the audit
      // owes the first answer.
      const verdict = compute({
        log: log(),
        ledger: ledgerWithRun(ranAt("sha-0")),
        drift: auditedAt(null, "sha-0"),
      });
      expect(verdict).toMatchObject({
        verdict: "inProgress",
        audit: "due",
        auditAssumedReached: "noDeployLog",
        execution: "stale",
        executionAssumedReached: "noDeployLog",
      });
    });

    test("unknownDeployedSha: the run was never attributed to a deploy", () => {
      const verdict = compute({ ledger: ledgerWithRun(ranAt(null)) });
      expect(verdict).toMatchObject({
        verdict: "rerunNeeded",
        execution: "stale",
        executionAssumedReached: "unknownDeployedSha",
      });
      // The result is not deleted, only invalidated.
      expect(verdict.lastRun).not.toBeNull();
    });

    test("ambiguousDeployedSha: the run straddled a deploy", () => {
      const verdict = compute({
        ledger: ledgerWithRun(ranAt("sha-0", { deployedShaAmbiguous: true })),
      });
      expect(verdict).toMatchObject({
        verdict: "rerunNeeded",
        execution: "stale",
        executionAssumedReached: "ambiguousDeployedSha",
      });
    });

    test("deployedShaNotInLog: the baseline is older than the retained log", () => {
      const verdict = compute({ ledger: ledgerWithRun(ranAt("sha-evicted")) });
      expect(verdict).toMatchObject({
        verdict: "rerunNeeded",
        execution: "stale",
        executionAssumedReached: "deployedShaNotInLog",
      });
    });

    test("gapInRange: deploys are missing between the baseline and now", () => {
      const verdict = compute({ log: log(deploy(0), deploy(1, { gapBefore: true })) });
      expect(verdict).toMatchObject({
        verdict: "rerunNeeded",
        execution: "stale",
        executionAssumedReached: "gapInRange",
      });
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
    expect(verdict.execution).toBe("failed");
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

describe("a deploy whose selection was not stored", () => {
  // The hub marks `hasSelection` only once the fold lands, so a lost fold
  // leaves it false. Before that ordering the flag was set first, which closed
  // the "no selection in range" escape hatch with the very flag that was
  // supposed to open it — and the deploy read as `verified`.
  test("reads as stale, never as verified", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1, { hasSelection: false })),
      // Pinned past the unjudged deploy so the audit is current and the run
      // axis is what this case tests.
      drift: auditedAt(null, "sha-1"),
    });
    expect(verdict).toMatchObject({
      verdict: "rerunNeeded",
      audit: "clean",
      execution: "stale",
      executionAssumedReached: "noSelectionInRange",
    });
  });

  test("holds the audit back too when the audit's own baseline sits behind it", () => {
    // One hole swallows both baselines: the audit is due and the run is stale,
    // and each says so on its own axis.
    const verdict = compute({
      log: log(deploy(0), deploy(1, { hasSelection: false })),
      drift: auditedAt(null, "sha-0"),
    });
    expect(verdict).toMatchObject({
      verdict: "inProgress",
      audit: "due",
      auditAssumedReached: "noSelectionInRange",
      execution: "stale",
      executionAssumedReached: "noSelectionInRange",
    });
  });
});

describe("computeRerun: the spec's own edits", () => {
  // A verdict is a claim about a (spec, product) pair. The deploy log covers
  // the product side; these cover the other one. Without them a spec repaired
  // and merged stays needsRepair until a deploy happens to reach it, and a run
  // that passed against the previous spec keeps answering verified.

  test("a drifted spec edited after the audit is due again, not needsRepair", () => {
    const verdict = compute({
      specs: [{ key: "f/s", changedAt: "2026-07-27T00:00:00Z" }],
      log: log(deploy(0)),
      drift: auditedAt("TEST_DRIFT", "sha-0"),
    });
    expect(verdict.audit).toBe("due");
    expect(verdict.verdict).toBe("inProgress");
    expect(verdict.specChangedSince).toBe("2026-07-27T00:00:00Z");
  });

  test("a passing run is stale once the spec it ran is edited", () => {
    const verdict = compute({
      specs: [{ key: "f/s", changedAt: "2026-07-27T00:00:00Z" }],
      log: log(deploy(0)),
      ledger: ledgerWithRun(ranAt("sha-0")),
    });
    // The new spec has never run, so the old pass cannot answer for it.
    expect(verdict.execution).toBe("stale");
    // The same edit stales the audit too, and the audit is asked first — the
    // spec has to be read again before running it is worth anything.
    expect(verdict.audit).toBe("due");
    expect(verdict.verdict).toBe("inProgress");
  });

  test("an edit older than the deploy the baseline read changes nothing", () => {
    const verdict = compute({
      specs: [{ key: "f/s", changedAt: "2026-07-19T00:00:00Z" }],
      log: log(deploy(0)),
      drift: auditedAt("TEST_DRIFT", "sha-0"),
    });
    expect(verdict.audit).toBe("drifted");
    expect(verdict.verdict).toBe("needsRepair");
    expect(verdict.specChangedSince).toBeUndefined();
  });

  test("an inventory with no edit time leaves the deploy-only answer alone", () => {
    const verdict = compute({
      specs: [{ key: "f/s" }],
      log: log(deploy(0)),
      drift: auditedAt("TEST_DRIFT", "sha-0"),
    });
    expect(verdict.audit).toBe("drifted");
    expect(verdict.verdict).toBe("needsRepair");
  });

  test("a failed run stays failed however the spec has moved", () => {
    // A red result is current information about the product whatever the spec
    // has done since, and re-running it before a person looks teaches nothing.
    const verdict = compute({
      specs: [{ key: "f/s", changedAt: "2026-07-27T00:00:00Z" }],
      log: log(deploy(0)),
      ledger: ledgerWithFailedRun(ranAt("sha-0")),
    });
    expect(verdict.execution).toBe("failed");
  });
});

describe("computeRerun: a manual attestation overriding the verdict", () => {
  test("a drifted spec with a covering attestation answers manuallyVerified, axes unchanged", () => {
    const verdict = compute({
      drift: auditedAt("TEST_DRIFT", "sha-0"),
      attestations: attested("sha-0", { note: "checked by hand" }),
    });
    expect(verdict.verdict).toBe("manuallyVerified");
    expect(verdict.audit).toBe("drifted");
    expect(verdict.manual).toMatchObject({ by: "a-person", note: "checked by hand" });
  });

  test("lapses when a deploy touches the spec after the attestation, naming the deploy", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
      drift: auditedAt("TEST_DRIFT", "sha-1"),
      attestations: attested("sha-0"),
    });
    expect(verdict.verdict).toBe("needsRepair");
    expect(verdict.manual).toBeUndefined();
    expect(verdict.manualLapsed).toMatchObject({ by: "a-person", because: "deployReached" });
    expect(verdict.manualLapsedByDeploy).toMatchObject({ sha: "sha-1" });
  });

  test("while it covers, the failure is still shipped on the axis it stands in for", () => {
    const verdict = compute({
      ledger: ledgerWithFailedRun(ranAt("sha-0", { at: "2026-07-26T06:00:00Z" })),
      attestations: attested("sha-0"),
    });
    expect(verdict.verdict).toBe("manuallyVerified");
    expect(verdict.execution).toBe("failed");
  });

  test("a lapse hands the spec back to the normal cycle, not to the red the person already answered", () => {
    const verdict = compute({
      log: log(deploy(0), deploy(1)),
      touchIndex: touchedAt(1),
      // Recorded before the attestation: the person looked at this failure and
      // settled it. `needsRepair` here would park the spec forever, since that
      // verdict is never re-run.
      ledger: ledgerWithFailedRun(ranAt("sha-0", { at: "2026-07-26T06:00:00Z" })),
      attestations: attested("sha-0"),
    });
    expect(verdict.verdict).toBe("rerunNeeded");
    expect(verdict.execution).toBe("stale");
    expect(verdict.manualLapsed?.because).toBe("deployReached");
  });

  test("a red run recorded after the attestation outranks it", () => {
    const verdict = compute({
      ledger: ledgerWithFailedRun(ranAt("sha-0", { at: "2026-07-26T18:00:00Z" })),
      attestations: attested("sha-0"),
    });
    expect(verdict.verdict).toBe("needsRepair");
    expect(verdict.manual).toBeUndefined();
    expect(verdict.manualLapsed?.because).toBe("newerRed");
  });

  test("lapses when the spec itself is edited after the attestation", () => {
    // The edit also re-opens the audit axis, so the verdict is the axes' own
    // answer (inProgress) rather than needsRepair — the point here is that
    // the attestation does not mask it, and says why.
    const verdict = compute({
      specs: [{ key: "f/s", changedAt: "2026-07-27T00:00:00Z" }],
      drift: auditedAt("TEST_DRIFT", "sha-0"),
      attestations: attested("sha-0"),
    });
    expect(verdict.verdict).toBe("inProgress");
    expect(verdict.manual).toBeUndefined();
    expect(verdict.manualLapsed?.because).toBe("specEdited");
  });

  test("the machine's own verified answer is not relabelled, but the attestation stays visible", () => {
    // Hiding it would leave an attestation nobody can see or revoke until
    // the axes happen to fall back to needing it.
    const verdict = compute({ attestations: attested("sha-0") });
    expect(verdict.verdict).toBe("verified");
    expect(verdict.manual).toMatchObject({ by: "a-person" });
  });

  test("a held spec stays inProgress — the attestation does not override a job in flight", () => {
    const verdict = compute({
      locks: { specs: { "f/s": { kind: "run", holder: "run-9", expiresAt: "2026-07-26T01:00:00Z" } } },
      drift: auditedAt("TEST_DRIFT", "sha-0"),
      attestations: attested("sha-0"),
    });
    expect(verdict.verdict).toBe("inProgress");
    expect(verdict.manual).toMatchObject({ by: "a-person" });
  });

  test("a null anchor with a log that has since grown lapses as cannotPlace, naming the hole", () => {
    // The person checked before any deploy was recorded; noDeployLog would
    // be factually wrong once entries exist, so the annotation says the
    // attestation itself has no sha to place.
    const verdict = compute({
      drift: auditedAt("TEST_DRIFT", "sha-0"),
      attestations: attested(null),
    });
    expect(verdict.verdict).toBe("needsRepair");
    expect(verdict.manualLapsed?.because).toBe("cannotPlace");
    expect(verdict.manualLapsedReason).toBe("unknownDeployedSha");
  });

  test("with no deploy log the attestation covers until a first deploy appears", () => {
    const empty: DeployLog = { nextIndex: 0, entries: [] };
    const verdict = compute({
      log: empty,
      ledger: { green: {}, run: {}, red: {} },
      drift: auditedAt("TEST_DRIFT", "no-deploys"),
      attestations: attested(null),
    });
    expect(verdict.verdict).toBe("manuallyVerified");
  });
});

describe("computeRerun: a person dismissing an audit finding", () => {
  /**
   * A dismissal answering the finding `auditedAt` records (runId "drift-1").
   * `label` is part of the answer, not decoration: it is what the person
   * judged wrong, and the engine matches on it.
   */
  function dismissed(
    { auditRunId = "drift-1", label = "TEST_DRIFT" as DriftLabel } = {},
  ): AuditDismissals {
    return {
      specs: {
        "f/s": {
          by: "a-person",
          at: "2026-07-26T12:00:00Z",
          note: "the selector is present; the finding rests on a replay note",
          auditRunId,
          label,
          headline: "a selector went stale",
        },
      },
    };
  }

  test("settles the audit axis, so the run side decides from there", () => {
    const verdict = compute({
      drift: auditedAt("TEST_DRIFT", "sha-0"),
      ledger: ledgerWithRun(null),
      dismissals: dismissed(),
    });
    expect(verdict.audit).toBe("clean");
    // Cleared by a person, never run: the machine's own answer is owed next.
    expect(verdict.verdict).toBe("rerunNeeded");
    expect(verdict.auditDismissed).toMatchObject({ by: "a-person", label: "TEST_DRIFT" });
    expect(verdict.auditDismissalApplied).toBe(true);
  });

  test("a spec the audit cleared and a run passed reads verified", () => {
    const verdict = compute({ drift: auditedAt("TEST_DRIFT", "sha-0"), dismissals: dismissed() });
    expect(verdict.verdict).toBe("verified");
  });

  test("UNKNOWN is dismissible too — the audit could not decide, the person could", () => {
    const verdict = compute({
      drift: auditedAt("UNKNOWN", "sha-0"),
      dismissals: dismissed({ label: "UNKNOWN" }),
    });
    expect(verdict.audit).toBe("clean");
  });

  test("a finding from a later audit is not answered by it, and the old one is still shown", () => {
    // Same spec, a new audit run: the machine gets to raise it again rather
    // than being silenced for good.
    const verdict = compute({ drift: auditedAt("TEST_DRIFT", "sha-0"), dismissals: dismissed({ auditRunId: "drift-9" }) });
    expect(verdict.audit).toBe("drifted");
    expect(verdict.verdict).toBe("needsRepair");
    expect(verdict.auditDismissed).toMatchObject({ auditRunId: "drift-9" });
  });

  test("a human regrade of the same run is a different finding, and stands", () => {
    // The triage flow rewrites the entry's label in place, keeping the run
    // id. A dismissal of what the audit originally said must not go on
    // suppressing what a person later confirmed.
    const graded: DriftLedger = {
      specs: {
        "f/s": { label: "SPEC_CHANGE", gitHead: "sha-0", runId: "drift-1", at: "2026-07-26T00:00:00Z", graded: true },
      },
    };
    const verdict = compute({ drift: graded, dismissals: dismissed() });
    expect(verdict.audit).toBe("drifted");
    expect(verdict.verdict).toBe("needsRepair");
    expect(verdict.auditDismissalApplied).toBe(false);
  });

  test("a later audit clearing the spec is the machine's own answer, not the person's", () => {
    // Both read `clean`, so the row says which one settled it — crediting a
    // person for an audit that cleared the spec by itself would be a lie the
    // detail panel repeats forever.
    const verdict = compute({ drift: auditedAt(null, "sha-0"), dismissals: dismissed() });
    expect(verdict.audit).toBe("clean");
    expect(verdict.auditDismissed).toBeDefined();
    expect(verdict.auditDismissalApplied).toBe(false);
  });

  test("a spec edited after the dismissal owes a fresh audit", () => {
    const verdict = compute({
      specs: [{ key: "f/s", changedAt: "2026-07-27T00:00:00Z" }],
      drift: auditedAt("TEST_DRIFT", "sha-0"),
      dismissals: dismissed(),
    });
    expect(verdict.audit).toBe("due");
    expect(verdict.verdict).toBe("inProgress");
  });
});
