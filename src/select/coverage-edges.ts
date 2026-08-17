import { z } from "zod";
import type { HubContext } from "../cli/hub-conn.ts";
import * as log from "../cli/logger.ts";
import type { HubCoverageAnswer } from "../hub-client/index.ts";
import { errMessage } from "../run/errors.ts";

/**
 * The measured reach edges spec selection intersects a diff with (ADR-0024).
 *
 * Two hub-side stores can hold a spec's reach, depending on which inbox a
 * project's runs fed: the coverage event stream (`--coverage-inbox hub`) and
 * the coverage rows of pushed run reports (the run-local sink). Both are
 * read, and per spec the newer measurement wins — the timestamps compared
 * are all stamped by the hub's own clock (the stream's event stamps, a run's
 * accept time), which is what makes the two sources comparable at all.
 */

export interface CoverageEdge {
  /**
   * Files the spec's most recent measured execution reached, relative to
   * `coverage.projectRoot` (the base both producers report under).
   */
  files: ReadonlySet<string>;
  /** When that measurement was taken (epoch ms, hub clock). */
  measuredAt: number;
}

/** Measured reach per spec, keyed `"feature/spec"`. */
export type CoverageEdges = Map<string, CoverageEdge>;

/**
 * How many recent hub runs are probed for report-row coverage. Bounded
 * because every probe downloads a whole report.json; past this many runs a
 * measurement is old enough that treating it as absent — `unknown`, so the
 * spec runs — is the safer answer anyway. The stream side carries its own
 * bound: the hub lists at most its newest twenty measured runs.
 */
const MAX_REPORT_RUNS = 20;

/**
 * How old a measurement may be and still decide a spec. The same fourteen
 * days the stream store retains events for (`COVERAGE_RETENTION_DAYS`): past
 * it an edge is too stale to clear a spec with confidence, so it is not
 * adopted and the spec degrades to `unknown` — which runs.
 */
export const EDGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Read every spec's most recent measured reach from the hub.
 *
 * Never throws: a hub that cannot be read yields an empty map (warned), which
 * the selection degrades to `unknown` across the board — the caller runs
 * those specs, so an unreadable hub costs runs, never a skipped regression.
 */
export async function loadCoverageEdges(input: HubContext): Promise<CoverageEdges> {
  const edges: CoverageEdges = new Map();
  const freshAfter = Date.now() - EDGE_MAX_AGE_MS;
  const merge = (key: string, edge: CoverageEdge): void => {
    // Both sources land here, so the freshness bound holds for both.
    if (edge.measuredAt < freshAfter) return;
    const existing = edges.get(key);
    if (!existing || edge.measuredAt > existing.measuredAt) edges.set(key, edge);
  };

  const results = await Promise.allSettled([
    collectStreamEdges(input, merge),
    collectReportEdges(input, merge),
  ]);
  let skipped = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn(
        `select-specs: could not read coverage measurements from the hub (${errMessage(result.reason)})`,
      );
    } else {
      skipped += result.value;
    }
  }
  if (skipped > 0) {
    log.warn(
      `select-specs: ${skipped} measured run(s) on the hub could not be read; their reach is treated as absent`,
    );
  }
  return edges;
}

type Merge = (key: string, edge: CoverageEdge) => void;

/**
 * Edges from the coverage event stream. The plain read answers for the most
 * recently measured run and lists every run the stream retains; each older
 * run is then resolved individually. Returns how many runs could not be read.
 */
async function collectStreamEdges(input: HubContext, merge: Merge): Promise<number> {
  const { hub, project } = input;
  const latest = await hub.getCoverage(project);
  ingestResolved(latest.resolved, merge);
  // Resolved concurrently: the hub lists at most its newest twenty measured
  // runs, so the fan-out is bounded without a pool. One unreadable run loses
  // that run's edges, not the whole load; its specs stay `unknown` unless a
  // readable run measured them.
  const older = latest.runIds.filter((runId) => runId !== latest.resolved?.runId);
  const results = await Promise.allSettled(
    older.map(async (runId) => ingestResolved((await hub.getCoverage(project, { runId })).resolved, merge)),
  );
  return results.filter((r) => r.status === "rejected").length;
}

function ingestResolved(resolved: HubCoverageAnswer["resolved"], merge: Merge): void {
  if (!resolved) return;
  for (const spec of resolved.specs) {
    const key = stripRunIdPrefix(spec.specId, resolved.runId);
    if (key === null) continue;
    // An empty file set is indistinguishable from a measurement that never
    // landed (no instrumented process answered for this spec), so it is not
    // an edge — consulting it would clear the spec against no evidence.
    if (spec.files.length === 0) continue;
    merge(key, { files: new Set(spec.files), measuredAt: resolved.asOf });
  }
}

/**
 * A stream specId is `<runId>.<feature>/<spec>` (src/coverage/session.ts).
 * The runId itself may contain `.`, so the known prefix is stripped by
 * length, never by splitting on the dot.
 */
function stripRunIdPrefix(specId: string, runId: string): string | null {
  return specId.startsWith(`${runId}.`) ? specId.slice(runId.length + 1) : null;
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
 * Edges from pushed run reports, newest first. Only `kind: run` runs are
 * probed — audits and recordings execute no specs, so they carry no reach —
 * and a still-`running` run is skipped: its rows are still arriving, so its
 * measurement is not settled. Returns how many reports could not be read.
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
  // Probed concurrently — at most `MAX_REPORT_RUNS` independent downloads. A
  // report that cannot be fetched counts as failed; one that fetches but does
  // not parse yields no edges and no failure.
  const results = await Promise.allSettled(
    eligible.map(async ({ id, measuredAt }) => {
      const parsed = ReportCoverageRowsSchema.safeParse(await hub.getReport(id));
      if (!parsed.success) return;
      for (const row of parsed.data.results) {
        if (!row.coverage || row.coverage.files.length === 0) continue;
        merge(`${row.feature}/${row.spec}`, { files: new Set(row.coverage.files), measuredAt });
      }
    }),
  );
  return results.filter((r) => r.status === "rejected").length;
}
