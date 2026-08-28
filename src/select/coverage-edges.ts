import { z } from "zod";

import type { HubContext } from "../cli/hub-conn.ts";
import * as log from "../cli/logger.ts";
import type { HubCoverageAnswer } from "../hub-client/index.ts";
import { errMessage } from "../run/errors.ts";
import { runPool } from "../runtime/pool.ts";
import { specKeyFromSpecId } from "../coverage/spec-id.ts";

/**
 * The measured reach edges spec selection intersects a diff with (ADR-0026).
 *
 * The primary source is the hub's coverage-edge ledger — one document, one
 * GET, entries that never expire and are replaced whenever a spec runs
 * measured. Two legacy sources remain for hubs and data that predate the
 * ledger: the coverage event stream's resolves and the coverage rows of
 * pushed run reports. Per spec the newest measurement wins; every timestamp
 * compared here was stamped by the hub's own clock, which is what makes the
 * sources comparable at all.
 */

export interface CoverageEdge {
  /**
   * Files the spec's most recent measured execution reached, relative to
   * `coverage.projectRoot` (the base every producer reports under).
   */
  files: ReadonlySet<string>;
  /** When that measurement was taken (epoch ms, hub clock). */
  measuredAt: number;
}

/** Measured reach per spec, keyed `"feature/spec"`. */
export type CoverageEdges = Map<string, CoverageEdge>;

/**
 * What a read of the hub's measurements amounts to. `degraded` is the
 * difference between "this spec was never measured" and "the measurements
 * could not be read": an absent edge selects the spec (it runs until a
 * measurement lands), so a read failure must not masquerade as absence — it
 * would stampede every spec into a run each time the hub hiccups. Degraded
 * reads leave undecided specs `unknown` instead.
 */
export interface CoverageEdgesReadout {
  edges: CoverageEdges;
  degraded: boolean;
}

/**
 * How many recent hub runs are probed for legacy report-row coverage.
 * Bounded because every probe downloads a whole report.json; anything this
 * far back has usually been superseded by the ledger anyway.
 */
const MAX_REPORT_RUNS = 20;

/**
 * How many reads one source keeps in flight. The two sources run together, so
 * the hub sees twice this. All at once is what it cannot take: it serves one
 * process, a resolve walks the whole event stream, and a report carries its
 * screenshots inline — forty of those together is what took it down, rather
 * than any single one of them.
 */
const HUB_READ_CONCURRENCY = 4;

/**
 * Read every spec's most recent measured reach from the hub. Never throws: a
 * source that cannot be read warns, and `degraded` flips when the failure
 * leaves absence ambiguous (the ledger itself, or the legacy sources while
 * no ledger answers).
 */
export async function loadCoverageEdges(
  input: HubContext | null | undefined,
): Promise<CoverageEdgesReadout> {
  // No hub is a read that cannot happen, not a suite that was never measured.
  if (input == null) return { edges: new Map(), degraded: true };

  // Candidates keep their file lists as-is; only the winners are turned into
  // sets at the end, so a spec reported by several sources does not build a
  // set per loser just to throw it away.
  const candidates = new Map<string, Candidate>();
  const merge = (key: string, candidate: Candidate): void => {
    const existing = candidates.get(key);
    if (!existing || candidate.measuredAt > existing.measuredAt) candidates.set(key, candidate);
  };

  const [ledger, ...legacy] = await Promise.allSettled([
    collectLedgerEdges(input, merge),
    collectStreamEdges(input, merge),
    collectReportEdges(input, merge),
  ]);
  let skipped = 0;
  let legacyBroken = false;
  for (const result of legacy) {
    if (result.status === "rejected") {
      legacyBroken = true;
      log.warn(
        `select-specs: could not read coverage measurements from the hub (${errMessage(result.reason)})`,
      );
    } else {
      skipped += result.value;
    }
  }
  if (skipped > 0) {
    legacyBroken = true;
    log.warn(
      `select-specs: ${skipped} measured run(s) on the hub could not be read; treating the ` +
        "measurements as unreadable rather than absent",
    );
  }
  if (ledger.status === "rejected") {
    log.warn(
      `select-specs: could not read the hub's coverage-edge ledger (${errMessage(ledger.reason)})`,
    );
  }
  // The legacy sources veto only until the ledger answers: once it does, a
  // spec they alone knew reads as unmeasured, which runs it — the safe
  // direction, and a measured run moves the spec into the ledger. Without a
  // ledger (older hub, none written yet) they are the record, so their
  // failure must not masquerade as absence.
  const ledgerAnswered = ledger.status === "fulfilled" && ledger.value;
  const degraded = ledger.status === "rejected" || (!ledgerAnswered && legacyBroken);
  const edges: CoverageEdges = new Map(
    [...candidates].map(([key, c]) => [key, { files: new Set(c.files), measuredAt: c.measuredAt }]),
  );
  return { edges, degraded };
}

interface Candidate {
  files: readonly string[];
  measuredAt: number;
}

type Merge = (key: string, candidate: Candidate) => void;

/**
 * The ledger itself; true when a document answered. A 404 is an older hub or
 * a project that never wrote one, not a failure: the legacy sources answer.
 */
async function collectLedgerEdges(input: HubContext, merge: Merge): Promise<boolean> {
  const doc = await input.hub.getCoverageEdges(input.project);
  if (doc === null) return false;
  for (const [key, entry] of Object.entries(doc.specs)) {
    // The upsert schema refuses empty file sets, but the read stays lenient:
    // a hand-edited or future document must not clear specs on no evidence.
    if (entry.files.length === 0) continue;
    merge(key, { files: entry.files, measuredAt: entry.measuredAt });
  }
  return true;
}

/**
 * Legacy: edges from the coverage event stream. The plain read answers for
 * the most recently measured run and lists every run the stream retains;
 * each older run is then resolved individually. Returns how many runs could
 * not be read.
 */
async function collectStreamEdges(input: HubContext, merge: Merge): Promise<number> {
  const { hub, project } = input;
  const latest = await hub.getCoverage(project);
  ingestResolved(latest.resolved, merge);
  const older = latest.runIds.filter((runId) => runId !== latest.resolved?.runId);
  const read = await runPool(older, HUB_READ_CONCURRENCY, async (runId) => {
    try {
      ingestResolved((await hub.getCoverage(project, { runId })).resolved, merge);
      return true;
    } catch {
      return false;
    }
  });
  return read.filter((ok) => !ok).length;
}

function ingestResolved(resolved: HubCoverageAnswer["resolved"], merge: Merge): void {
  if (!resolved) return;
  for (const spec of resolved.specs) {
    const key = specKeyFromSpecId(spec.specId, resolved.runId);
    if (key === null) continue;
    // An empty file set is indistinguishable from a measurement that never
    // landed (no instrumented process answered for this spec), so it is not
    // an edge — consulting it would clear the spec against no evidence.
    if (spec.files.length === 0) continue;
    merge(key, { files: spec.files, measuredAt: resolved.asOf });
  }
}

/**
 * The one slice of report.json this consumer reads. Parsed with its own
 * narrow schema rather than the full report schema so a report from another
 * ccqa version still yields its edges as long as this shape holds.
 */
const ReportCoverageRowsSchema = z.object({
  results: z.array(
    z.object({
      feature: z.string(),
      spec: z.string(),
      coverage: z.object({ files: z.array(z.string()) }).optional(),
    }),
  ),
});

/**
 * Legacy: edges from pushed run reports, newest first. Only `kind: run` runs
 * are probed — audits and recordings execute no specs — and a still-`running`
 * run is skipped: its rows are still arriving. Returns how many reports
 * could not be read.
 */
async function collectReportEdges(input: HubContext, merge: Merge): Promise<number> {
  const { hub, project } = input;
  const runs = await hub.listRuns({ project, kind: "run", limit: MAX_REPORT_RUNS });
  const eligible = runs.flatMap((run) => {
    if (run.status === "running") return [];
    const measuredAt = Date.parse(run.createdAt);
    if (Number.isNaN(measuredAt)) return [];
    return [{ id: run.id, measuredAt }];
  });
  // The whole body is guarded: `runPool` rejects the pool when its callback
  // throws, and one unreadable report has to stay one unreadable report.
  // A report whose shape does not match is read but has nothing to give.
  const read = await runPool(eligible, HUB_READ_CONCURRENCY, async ({ id, measuredAt }) => {
    try {
      const parsed = ReportCoverageRowsSchema.safeParse(await hub.getReport(id));
      if (!parsed.success) return true;
      for (const row of parsed.data.results) {
        if (!row.coverage || row.coverage.files.length === 0) continue;
        merge(`${row.feature}/${row.spec}`, { files: row.coverage.files, measuredAt });
      }
      return true;
    } catch {
      return false;
    }
  });
  return read.filter((ok) => !ok).length;
}
