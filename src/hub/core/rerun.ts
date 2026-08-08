import type {
  Attestation,
  AttestationLapse,
  Attestations,
  AuditDismissals,
  AuditState,
  DeployLog,
  DeployRef,
  DriftLedger,
  ExecutionState,
  RerunUnknownReason,
  SpecLedger,
  SpecLedgerEntry,
  SpecLock,
  SpecLocks,
  SpecRerun,
  SpecTouchIndex,
  SpecVerdict,
} from "../contract/schema.ts";
import type { DriftLabel } from "../../report/schema.ts";
import { auditNeed } from "./audit-need.ts";
import { buildRange, freshness, type Freshness, type RangeLookup } from "./deploy-range.ts";
import { heldBy } from "./locks.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "What should happen to this spec next?" — pure set arithmetic over data the
 * hub already stores (ADR-0010).
 *
 * Two independent axes, one derived answer. Neither axis determines the other
 * — a spec can be clean and stale, or drifted and freshly run — so collapsing
 * them into one value loses exactly the case that matters.
 */
export interface RerunInput {
  /** Every spec in the project's perspectives document. */
  specs: SpecTarget[];
  /** The profile's ledger, merged across branches. */
  ledger: SpecLedger;
  log: DeployLog;
  touchIndex: SpecTouchIndex;
  /** The project's drift ledger, keyed by spec. Carries the commit each audit read. */
  drift: DriftLedger;
  /** Who is working on what right now. Expired holds read as free. */
  locks: SpecLocks;
  /** Each spec's standing manual attestation, if any. */
  attestations: Attestations;
  /** Each spec's last dismissed audit finding, if any. Not profile-scoped, like the drift ledger. */
  dismissals: AuditDismissals;
  /** Compared against each hold's expiry. Passed in so the answer is reproducible in tests. */
  now: Date;
}

/**
 * When each deployed commit reached the environment. A baseline read at that
 * commit cannot have seen anything committed after it was deployed.
 */
function deployedAt(log: DeployLog): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of log.entries) out.set(entry.sha, entry.at);
  return out;
}

/**
 * Has the spec moved since the baseline was taken?
 *
 * A verdict is a claim about a (spec, product) pair, so either side moving
 * invalidates it. The deploy log covers the product side; this covers the
 * other one. Without it a spec repaired and merged stays `needsRepair` until
 * a deploy happens to reach it, and a run that passed against the previous
 * spec keeps answering `verified` for the new one.
 *
 * Compared against when the baseline commit was *deployed*, not when the audit
 * or run happened: the tree read at that commit predates its deployment, so an
 * edit after it is definitely not in it. Falls back to the baseline's own
 * timestamp when the log cannot place the commit.
 *
 * One-directional. A later edit time proves the baseline is stale; an earlier
 * one proves nothing, and this answers false rather than guessing.
 */
function specMovedSince(
  changedAt: string | undefined,
  baselineSha: string | null,
  baselineAt: string,
  deployTimes: Map<string, string>,
): string | null {
  if (!changedAt) return null;
  const cutoff = (baselineSha && deployTimes.get(baselineSha)) || baselineAt;
  return changedAt > cutoff ? changedAt : null;
}

export function computeRerun(input: RerunInput): Record<string, SpecRerun> {
  const { specs, ledger, log, touchIndex, drift, locks, attestations, dismissals, now } = input;
  const range = buildRange(log, touchIndex);
  const deployTimes = deployedAt(log);

  const out: Record<string, SpecRerun> = {};
  for (const spec of specs) {
    const coords = {
      lastRun: ledger.run[spec.key] ?? null,
      lastGreen: ledger.green[spec.key] ?? null,
      lastRed: ledger.red[spec.key] ?? null,
    };
    let audit = auditState(drift, spec.key, range);
    let execution = executionState(coords, (sha) => freshness(sha, spec.key, range));

    const driftEntry = drift.specs[spec.key];

    // A person answering the audit settles the audit axis: the finding was
    // wrong, so the spec is as clean as one the audit cleared, and the run
    // side decides from here. Pinned to the run that raised it — a later
    // audit is a new observation, and the machine gets to say its piece
    // again rather than being silenced for good.
    const dismissal = dismissals.specs[spec.key];
    const dismissed =
      dismissal !== undefined &&
      driftEntry !== undefined &&
      dismissal.auditRunId === driftEntry.runId &&
      (audit.audit === "drifted" || audit.audit === "undecided");
    if (dismissed) audit = { audit: "clean" };

    // The spec's own edits, applied to both axes. `due`/`stale` already mean
    // "the baseline no longer answers for what is here now", so an edit lands
    // in the existing vocabulary rather than adding a state.
    const auditMoved = specMovedSince(
      spec.changedAt,
      driftEntry?.gitHead ?? null,
      driftEntry?.at ?? "",
      deployTimes,
    );
    const runMoved = specMovedSince(
      spec.changedAt,
      coords.lastRun?.deployedSha ?? null,
      coords.lastRun?.at ?? "",
      deployTimes,
    );
    if (auditMoved && audit.audit !== "due") audit = { audit: "due" };
    // `failed` is left alone: a red result is current information about the
    // product whatever the spec has done since, and re-running it before a
    // person looks teaches nothing.
    if (runMoved && execution.execution === "passed") execution = { execution: "stale" };

    const held = heldBy(locks, spec.key, now);
    let verdict = decide(audit.audit, execution.execution, held);

    // A person's word overrides the machine's answer, never the axes: both
    // are shipped unchanged so the reader can see what the attestation is
    // standing in for. One that no longer covers is kept visible with the
    // reason it lapsed — the person deciding whether to attest again needs
    // to know what changed since they last looked.
    const manualState = readAttestation(
      attestations.specs[spec.key],
      spec,
      coords.lastRed,
      range,
      log,
      deployTimes,
    );
    if (manualState?.kind === "covers" && !held && verdict !== "verified") {
      verdict = "manuallyVerified";
    }

    out[spec.key] = {
      verdict,
      ...(auditMoved || runMoved ? { specChangedSince: (auditMoved ?? runMoved)! } : {}),
      ...audit,
      ...execution,
      // Shipped whether or not it still applies: one beside a `drifted` axis
      // is a finding raised again after being dismissed, which the reader
      // needs to see rather than argue with from scratch.
      ...(dismissal ? { auditDismissed: dismissal } : {}),
      // A standing attestation is emitted whether or not it decided the
      // verdict: on a held or machine-verified spec it changed nothing, but
      // hiding it would leave an attestation nobody can see or revoke until
      // the axes happen to fall back to needing it.
      ...(manualState?.kind === "covers" ? { manual: manualState.attest } : {}),
      ...(manualState?.kind === "lapsed"
        ? {
            manualLapsed: { ...manualState.attest, because: manualState.because },
            ...(manualState.because === "deployReached"
              ? { manualLapsedByDeploy: manualState.byDeploy }
              : {}),
            ...(manualState.reason ? { manualLapsedReason: manualState.reason } : {}),
          }
        : {}),
      heldBy: held,
      ...coords,
    };
  }
  return out;
}

type ManualState =
  | { kind: "covers"; attest: Attestation }
  | {
      kind: "lapsed";
      attest: Attestation;
      because: AttestationLapse;
      byDeploy?: DeployRef | null;
      /** Set only for `cannotPlace`: which hole made the log unable to answer. */
      reason?: RerunUnknownReason;
    };

/**
 * Does the attestation still speak for what is deployed? Checked in the order
 * the lapse enum documents: deploy coverage first (a sha the log cannot place
 * reads as reached, ADR-0014, with the hole kept as an annotation), then the
 * spec's own edits — compared against when the person looked, because they
 * read the spec as it stood that moment, which `specMovedSince` covers via a
 * null baseline sha — then a red run recorded after them, which is newer
 * information than their word. The null-sha case is the profile that had no
 * deploy log when they checked: their word covers exactly as long as that
 * stays true.
 */
function readAttestation(
  attest: Attestation | undefined,
  spec: SpecTarget,
  lastRed: SpecLedgerEntry | null,
  range: RangeLookup,
  log: DeployLog,
  deployTimes: Map<string, string>,
): ManualState | null {
  if (!attest) return null;

  // A null anchor means the profile had no deploy log when the person
  // checked. Once entries exist, the attestation has no sha to place — the
  // same shape as a run that predates deploy-sha stamping, and the same
  // word for it. `noDeployLog` would be factually wrong here: the reason
  // only fires when the log is non-empty.
  const coverage: Freshness =
    attest.deployedSha === null
      ? log.entries.length === 0
        ? { kind: "current" }
        : { kind: "unanswerable", reason: "unknownDeployedSha" }
      : freshness(attest.deployedSha, spec.key, range);
  if (coverage.kind === "touched") {
    return { kind: "lapsed", attest, because: "deployReached", byDeploy: coverage.touchedByDeploy };
  }
  if (coverage.kind === "unanswerable") {
    return { kind: "lapsed", attest, because: "cannotPlace", reason: coverage.reason };
  }

  if (specMovedSince(spec.changedAt, null, attest.at, deployTimes)) {
    return { kind: "lapsed", attest, because: "specEdited" };
  }
  if (lastRed !== null && lastRed.at > attest.at) {
    return { kind: "lapsed", attest, because: "newerRed" };
  }
  return { kind: "covers", attest };
}

/**
 * Axis 1, derived from the same freshness answer `--only-hub-audit-needed`
 * reads. The label only speaks once the audit is known to be current: a
 * verdict about an older commit says nothing about the one running now.
 *
 * A commit the log cannot place is `due` like any other: a deploy we cannot
 * rule out is treated as having landed (ADR-0014). The hole is kept as an
 * annotation so the answer stays explicable.
 */
function auditState(
  drift: DriftLedger,
  key: string,
  range: RangeLookup,
): {
  audit: AuditState;
  driftLabel?: Exclude<DriftLabel, "UNKNOWN">;
  auditAssumedReached?: RerunUnknownReason;
} {
  const need = auditNeed(drift, key, range);
  switch (need.because) {
    case "neverAudited":
    case "deployReached":
      return { audit: "due" };
    case "cannotTell":
      return { audit: "due", ...(need.reason ? { auditAssumedReached: need.reason } : {}) };
    case "current": {
      const label = drift.specs[key]!.label;
      if (label === null) return { audit: "clean" };
      if (label === "UNKNOWN") return { audit: "undecided" };
      return { audit: "drifted", driftLabel: label };
    }
    default: {
      const unreachable: never = need.because;
      throw new Error(`unhandled audit need: ${String(unreachable)}`);
    }
  }
}

/**
 * Axis 2: how the last run ended, and whether a deploy has overtaken it. The
 * red bucket is compared by run id rather than by timestamp because both
 * buckets advance from the same terminal-run trigger, so the run that wrote
 * `run` wrote exactly one of `green` or `red`.
 *
 * `failed` outranks `stale`: a red result is current information whatever has
 * deployed since, and re-running it teaches nothing until someone repairs it.
 */
function executionState(
  coords: { lastRun: SpecLedgerEntry | null; lastRed: SpecLedgerEntry | null },
  since: (baselineSha: string) => Freshness,
): Pick<SpecRerun, "execution" | "executionAssumedReached" | "touchedBy" | "touchedByDeploy"> {
  const { lastRun, lastRed } = coords;
  if (!lastRun) return { execution: "neverRun" };
  if (lastRed && lastRed.runId === lastRun.runId) return { execution: "failed" };
  // A run the log cannot place is stale, not discarded: the result is still
  // worth reading, only its currency is void (ADR-0014).
  if (lastRun.deployedShaAmbiguous) return assumedReached("ambiguousDeployedSha");
  if (!lastRun.deployedSha) return assumedReached("unknownDeployedSha");

  const answer = since(lastRun.deployedSha);
  if (answer.kind === "unanswerable") return assumedReached(answer.reason);
  if (answer.kind === "current") return { execution: "passed" };
  return {
    execution: "stale",
    ...(answer.touchedBy ? { touchedBy: answer.touchedBy } : {}),
    touchedByDeploy: answer.touchedByDeploy,
  };
}

function assumedReached(
  reason: RerunUnknownReason,
): { execution: "stale"; executionAssumedReached: RerunUnknownReason } {
  return { execution: "stale", executionAssumedReached: reason };
}

/**
 * The derived answer: a total function of the two axes plus whether a job
 * holds the spec. Nothing else is consulted — an axis that needed a third
 * input to be read is an axis that cannot be shown next to the verdict as its
 * reason.
 */
function decide(audit: AuditState, execution: ExecutionState, held: SpecLock | null): SpecVerdict {
  // A job already has this spec. Nothing below is worth asking: whatever the
  // answer, acting on it would race the job that is on it.
  if (held) return "inProgress";
  switch (audit) {
    case "due":
      return "inProgress";
    case "drifted":
    case "undecided":
      return "needsRepair";
    case "clean":
      break;
    default: {
      const unreachable: never = audit;
      throw new Error(`unhandled audit state: ${String(unreachable)}`);
    }
  }
  switch (execution) {
    case "failed":
      return "needsRepair";
    case "stale":
    case "neverRun":
      return "rerunNeeded";
    case "passed":
      return "verified";
    default: {
      const unreachable: never = execution;
      throw new Error(`unhandled execution state: ${String(unreachable)}`);
    }
  }
}
