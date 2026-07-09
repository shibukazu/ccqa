import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ReportSpecResult, RunReportData } from "../report/schema.ts";

/**
 * The report envelope fields that don't change spec-to-spec — everything in
 * `RunReportData` except `results`. Captured once when the writer is created
 * so each incremental flush produces the same envelope the final batch write
 * used to.
 */
export type ReportEnvelope = Omit<RunReportData, "results">;

/**
 * Accumulates per-spec report rows and rewrites `report.json` after each one,
 * so an interrupted run leaves a valid report of the specs that finished
 * instead of nothing. The old pipeline wrote `report.json` exactly once after
 * the whole batch; interrupting before that lost every result.
 *
 * `upsert` is keyed by `feature/spec` so re-reporting a spec (e.g. a tail-phase
 * drift backfill) replaces its row rather than duplicating it. Every flush is a
 * temp-file + atomic rename, so a concurrent reader (`ccqa hub push`, an
 * `if: always()` CI step) never observes a half-written file. Writes are
 * serialized through a single promise chain so `--concurrency > 1` workers
 * flushing at once can't interleave into a truncated file.
 */
export interface IncrementalReport {
  /** Insert or replace a spec's row (by `feature/spec`) and flush report.json. */
  upsert(row: ReportSpecResult): Promise<void>;
  /** Insert/replace several rows in one flush. */
  upsertAll(rows: readonly ReportSpecResult[]): Promise<void>;
  /** Rewrite report.json from the current rows without changing them. */
  flush(): Promise<void>;
  /** Snapshot the current rows in insertion order. */
  rows(): ReportSpecResult[];
  /** The assembled report data as it stands now. */
  snapshot(): RunReportData;
}

/**
 * A side channel notified after each row is durably flushed to disk — used to
 * mirror the row to a hub (`PATCH /runs/:id`). It runs inside the same promise
 * chain as the flush, so hub patches are serialized in flush order even under
 * `--concurrency > 1`, and a slow/failed patch never interleaves two rows.
 */
export interface ReportSink {
  /** Called once per upsert, after the local report.json flush succeeds. */
  onUpsert(row: ReportSpecResult): void | Promise<void>;
}

export function createIncrementalReport(
  reportDir: string,
  envelope: ReportEnvelope,
  sink?: ReportSink,
): IncrementalReport {
  const byKey = new Map<string, ReportSpecResult>();
  const reportPath = join(reportDir, "report.json");
  // Single promise chain: each flush waits for the previous one, so parallel
  // workers serialize their rewrites rather than racing the same file.
  let queue: Promise<void> = Promise.resolve();

  const key = (r: ReportSpecResult) => `${r.feature}/${r.spec}`;

  const buildData = (): RunReportData => ({ ...envelope, results: [...byKey.values()] });

  const doFlush = async (): Promise<void> => {
    const data = buildData();
    await mkdir(dirname(reportPath), { recursive: true });
    const tmp = `${reportPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, reportPath);
  };

  const enqueue = (): Promise<void> => {
    queue = queue.then(doFlush, doFlush);
    return queue;
  };

  /**
   * Flush, then notify the sink for `row`. The sink is best-effort — a failed
   * hub patch is swallowed so it can't reject the write chain (which would drop
   * every later flush) or fail the run. Chained after the flush so the local
   * report.json is always the durable source of truth.
   */
  const enqueueWithSink = (row: ReportSpecResult): Promise<void> => {
    queue = queue.then(doFlush, doFlush).then(async () => {
      if (!sink) return;
      try {
        await sink.onUpsert(row);
      } catch {
        // best-effort: the sink itself is expected to log; never break the chain.
      }
    });
    return queue;
  };

  return {
    upsert(row) {
      byKey.set(key(row), row);
      return enqueueWithSink(row);
    },
    upsertAll(rows) {
      for (const row of rows) byKey.set(key(row), row);
      return enqueue();
    },
    flush() {
      return enqueue();
    },
    rows() {
      return [...byKey.values()];
    },
    snapshot() {
      return buildData();
    },
  };
}
