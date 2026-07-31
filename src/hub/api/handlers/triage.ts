import type { ActualCause, DriftLabel, FailureAnalysis } from "../../../report/schema.ts";
import {
  causesForKind,
  LabelsExportSchema,
  NO_DRIFT_CAUSE,
  RunReportDataSchema,
  type RunReportData,
} from "../../../report/schema.ts";
import {
  type ImportActualCauseRejection,
  PutActualCauseRequestSchema,
  type RunTriage,
  type TriageCase,
} from "../../contract/schema.ts";
import { gradedDriftEntry } from "../../core/drift-ledger.ts";
import type { HubStorage, TriageRecord } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { errMsg, HttpError, readBody, sendJson } from "../respond.ts";

const MAX_TRIAGE_BODY_BYTES = 256 * 1024;
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

/** GET /api/v1/runs/:id/triage — joins the run's predicted labels (report.json) with recorded actual causes. */
export function createGetTriageHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const runId = ctx.params.id!;
    const report = await readReport(storage, runId);
    const records = await storage.triage.list(runId);
    sendJson(ctx.res, 200, buildRunTriage(runId, report, records));
  };
}

/** PUT /api/v1/runs/:id/triage/:feature/:spec/actual-cause */
export function createPutActualCauseHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const { id: runId, feature, spec } = ctx.params;
    const report = await readReport(storage, runId!);
    if (!report) throw new HttpError(409, "conflict", "run has no report yet — it hasn't finished, or has no --report data");
    const result = report.results.find((r) => r.feature === feature && r.spec === spec);
    if (!result || !result.analysis) {
      throw new HttpError(404, "not_found", `no triage case "${feature}/${spec}" in this run's report`);
    }

    const body = await readBody(ctx.req, MAX_TRIAGE_BODY_BYTES);
    const parsed = PutActualCauseRequestSchema.safeParse(JSON.parse(body.toString("utf8") || "{}"));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid request body");
    }

    const allowedCauses = causesForKind(report.kind);
    if (!allowedCauses.includes(parsed.data.cause)) {
      throw new HttpError(
        400,
        "invalid_request",
        `"${parsed.data.cause}" is not a valid actual cause for a ${report.kind} run (expected one of ${allowedCauses.join(", ")})`,
      );
    }

    const record = buildTriageRecord(feature!, spec!, result.analysis, report.promptVersion, {
      cause: parsed.data.cause,
      note: parsed.data.note,
      target: result.target,
    });
    await storage.triage.putActualCause(runId!, record);
    await applyGradeToDriftLedger(storage, runId!, feature!, spec!, parsed.data.cause);

    sendJson(ctx.res, 200, toTriageCase(feature!, spec!, result.analysis, result.target, record, allowedCauses));
  };
}

/** DELETE /api/v1/runs/:id/triage/:feature/:spec/actual-cause */
export function createDeleteActualCauseHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    await storage.triage.deleteActualCause(ctx.params.id!, ctx.params.feature!, ctx.params.spec!);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/** PUT /api/v1/runs/:id/triage/actual-causes — bulk import of a static report's exported LabelsExport JSON. */
export function createImportActualCausesHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const runId = ctx.params.id!;
    const report = await readReport(storage, runId);
    if (!report) throw new HttpError(409, "conflict", "run has no report yet");

    const body = await readBody(ctx.req, MAX_IMPORT_BODY_BYTES);
    const parsed = LabelsExportSchema.safeParse(JSON.parse(body.toString("utf8") || "{}"));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid LabelsExport body");
    }

    // Same per-kind check as the single PUT (:45) — a bulk import must not be
    // able to write a cause invalid for the target row's kind, which would
    // manufacture a fresh invalid-for-kind grade on the spot.
    const allowedCauses = causesForKind(report.kind);
    let imported = 0;
    const rejected: ImportActualCauseRejection[] = [];
    for (const entry of parsed.data.labels) {
      const result = report.results.find((r) => r.feature === entry.feature && r.spec === entry.spec);
      if (!result?.analysis) {
        rejected.push({ feature: entry.feature, spec: entry.spec, reason: `no triage case "${entry.feature}/${entry.spec}" in this run's report` });
        continue;
      }
      if (!allowedCauses.includes(entry.label)) {
        rejected.push({
          feature: entry.feature,
          spec: entry.spec,
          reason: `"${entry.label}" is not a valid actual cause for a ${report.kind} run (expected one of ${allowedCauses.join(", ")})`,
        });
        continue;
      }
      const record = buildTriageRecord(entry.feature, entry.spec, result.analysis, parsed.data.promptVersion, {
        cause: entry.label,
        note: entry.note,
        target: result.target,
      });
      await storage.triage.putActualCause(runId, record);
      imported++;
    }
    sendJson(ctx.res, 200, { imported, rejected });
  };
}

async function readReport(storage: HubStorage, runId: string): Promise<RunReportData | null> {
  const bytes = await storage.artifacts.read(runId, "report.json");
  if (!bytes) return null;
  const parsed = RunReportDataSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return parsed.success ? parsed.data : null;
}

/**
 * Carry a grade on a drift row through to the drift ledger, so the Perspectives
 * view shows what the human decided rather than what the audit guessed.
 *
 * A grade is the ground truth; the ledger is the one place that answers "does
 * this spec still describe the code" for a reader who is not looking at the
 * run. Leaving it at the audit's answer would mean a case a human has already
 * cleared keeps flagging itself.
 *
 * Best-effort, like the ledger update at push time: a triage grade must be
 * recorded even if the ledger write fails. A `kind: "run"` grade is a no-op —
 * `gradedDriftEntry` finds no entry that names this run.
 */
async function applyGradeToDriftLedger(
  storage: HubStorage,
  runId: string,
  feature: string,
  spec: string,
  cause: ActualCause,
): Promise<void> {
  try {
    const run = await storage.runs.get(runId);
    if (!run || run.kind !== "drift" || !run.branch) return;
    const ledger = await storage.driftLedger.getMerged(run.project);
    const label = cause === NO_DRIFT_CAUSE ? null : (cause as DriftLabel);
    const entry = gradedDriftEntry(ledger, `${feature}/${spec}`, runId, label);
    if (!entry) return;
    await storage.driftLedger.merge(run.project, run.branch, { specs: { [`${feature}/${spec}`]: entry } });
  } catch (err) {
    console.error(`hub: drift ledger grade update failed for run "${runId}": ${errMsg(err)}`);
  }
}

function buildRunTriage(runId: string, report: RunReportData | null, records: TriageRecord[]): RunTriage {
  if (!report) return { runId, promptVersion: "", cases: [], recorded: 0, recordedInvalidForKind: 0, total: 0 };

  const allowedCauses = causesForKind(report.kind);
  const recordByKey = new Map(records.map((r) => [`${r.feature}/${r.spec}`, r]));
  const cases: TriageCase[] = [];
  for (const result of report.results) {
    if (!result.analysis) continue;
    const record = recordByKey.get(`${result.feature}/${result.spec}`);
    // The report row is the authoritative target; a record written before the
    // field existed falls back to it too.
    cases.push(toTriageCase(result.feature, result.spec, result.analysis, result.target, record, allowedCauses));
  }
  const graded = cases.filter((c) => c.actual !== null);
  // invalidForKind rows are graded, but under a cause this row's kind does
  // not offer — split out so a caller can tell "done" from "needs a regrade"
  // instead of one number quietly absorbing both.
  const invalidForKind = graded.filter((c) => c.actual?.invalidForKind).length;
  return {
    runId,
    promptVersion: report.promptVersion,
    cases,
    recorded: graded.length - invalidForKind,
    recordedInvalidForKind: invalidForKind,
    total: cases.length,
  };
}

function buildTriageRecord(
  feature: string,
  spec: string,
  analysis: FailureAnalysis,
  promptVersion: string,
  actual: { cause: ActualCause; note?: string; target?: string },
): TriageRecord {
  return {
    feature,
    spec,
    predicted: {
      label: analysis.label,
      confidence: analysis.confidence,
      ...(analysis.subDiagnosis ? { subDiagnosis: analysis.subDiagnosis } : {}),
      headline: analysis.headline,
    },
    actualCause: actual.cause,
    ...(actual.note ? { note: actual.note } : {}),
    ...(actual.target ? { target: actual.target } : {}),
    promptVersion,
    recordedAt: new Date().toISOString(),
  };
}

function toTriageCase(
  feature: string,
  spec: string,
  analysis: FailureAnalysis,
  target: string | undefined,
  record: TriageRecord | undefined,
  allowedCauses: readonly ActualCause[],
): TriageCase {
  // Prefer the current report row's target; fall back to the stored grade's
  // recorded target for a row that lacks one (e.g. the report was replaced by a
  // push that didn't set `target`, but an earlier grade recorded it).
  const resolvedTarget = target ?? record?.target;
  return {
    feature,
    spec,
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
    predicted: {
      label: analysis.label,
      confidence: analysis.confidence,
      ...(analysis.subDiagnosis ? { subDiagnosis: analysis.subDiagnosis } : {}),
      headline: analysis.headline,
    },
    actual: record
      ? {
          cause: record.actualCause as ActualCause,
          ...(record.note ? { note: record.note } : {}),
          recordedAt: record.recordedAt,
          // A grade whose cause this row's kind does not accept (e.g.
          // NO_DRIFT on a kind:"run" row). Never remapped — that would
          // fabricate a claim nobody made — so it's flagged for a regrade.
          ...(allowedCauses.includes(record.actualCause as ActualCause) ? {} : { invalidForKind: true }),
        }
      : null,
  };
}
