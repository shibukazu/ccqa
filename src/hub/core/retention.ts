import type { Run } from "../contract/schema.ts";
import type { HubStorage } from "./storage/types.ts";

/**
 * How many runs one (project, branch) keeps. Overridable with
 * `serve --max-runs-per-branch`.
 *
 * A count, where the spend log's retention is a 90-day window (ADR-0017): what
 * has to be bounded here is a burst — an automated fix loop leaves a
 * `kind: "record"` run per re-recorded spec — and any time window admits an
 * unbounded number of those. A spend entry is a few hundred bytes and arrives
 * once per job, so age is the right axis there and the wrong one here.
 */
export const DEFAULT_MAX_RUNS_PER_BRANCH = 200;

/**
 * Drop everything past the newest `maxRuns` of the (project, branch) that
 * `run` belongs to, taking each evicted run's artifacts and triage records
 * with it.
 *
 * Runs at a terminal state trigger this, rather than a sweep at startup: the
 * hub whose disk grows is the one written to constantly and never restarted,
 * which is exactly the one a startup sweep never fires on.
 *
 * Best-effort like the ledger updates it runs beside — a lost sweep costs
 * disk, while failing the push it hangs off would cost the run.
 */
export async function sweepRunRetention(storage: HubStorage, run: Run, maxRuns: number): Promise<void> {
  try {
    // Listed per project and grouped here, since `list` has no way to ask for
    // the `branch: null` group a run pushed without a branch lands in.
    // "running" runs are still being written, so they neither count nor go.
    const group = (await storage.runs.list({ project: run.project })).filter(
      (r) => r.branch === run.branch && r.status !== "running",
    );
    for (const evicted of group.slice(maxRuns)) {
      // Reverse of the order a push writes them in, so the window in between
      // holds bytes nothing points at rather than a listed run whose report
      // has already gone.
      await storage.runs.delete(evicted.id);
      await storage.artifacts.delete(evicted.id);
      await storage.triage.deleteAll(evicted.id);
    }
  } catch (err) {
    console.error(
      `hub: run retention sweep failed for "${run.project}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
