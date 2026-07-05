import type { FailureAnalysis, FailureLabel } from "../../../report/schema.ts";
import { LabelsExportSchema, RunReportDataSchema, type RunReportData } from "../../../report/schema.ts";
import { PutActualCauseRequestSchema, type RunTriage, type TriageCase } from "../../contract/schema.ts";
import type { HubStorage, TriageRecord } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendJson } from "../respond.ts";

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

    const record = buildTriageRecord(feature!, spec!, result.analysis, report.promptVersion, {
      cause: parsed.data.cause,
      note: parsed.data.note,
    });
    await storage.triage.putActualCause(runId!, record);

    sendJson(ctx.res, 200, toTriageCase(feature!, spec!, result.analysis, record));
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

    let imported = 0;
    for (const entry of parsed.data.labels) {
      const result = report.results.find((r) => r.feature === entry.feature && r.spec === entry.spec);
      if (!result?.analysis) continue;
      const record = buildTriageRecord(entry.feature, entry.spec, result.analysis, parsed.data.promptVersion, {
        cause: entry.label,
        note: entry.note,
      });
      await storage.triage.putActualCause(runId, record);
      imported++;
    }
    sendJson(ctx.res, 200, { imported });
  };
}

async function readReport(storage: HubStorage, runId: string): Promise<RunReportData | null> {
  const bytes = await storage.artifacts.read(runId, "report.json");
  if (!bytes) return null;
  const parsed = RunReportDataSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return parsed.success ? parsed.data : null;
}

function buildRunTriage(runId: string, report: RunReportData | null, records: TriageRecord[]): RunTriage {
  if (!report) return { runId, promptVersion: "", cases: [], recorded: 0, total: 0 };

  const recordByKey = new Map(records.map((r) => [`${r.feature}/${r.spec}`, r]));
  const cases: TriageCase[] = [];
  for (const result of report.results) {
    if (!result.analysis) continue;
    const record = recordByKey.get(`${result.feature}/${result.spec}`);
    cases.push(toTriageCase(result.feature, result.spec, result.analysis, record));
  }
  return {
    runId,
    promptVersion: report.promptVersion,
    cases,
    recorded: cases.filter((c) => c.actual !== null).length,
    total: cases.length,
  };
}

function buildTriageRecord(
  feature: string,
  spec: string,
  analysis: FailureAnalysis,
  promptVersion: string,
  actual: { cause: FailureLabel; note?: string },
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
    promptVersion,
    recordedAt: new Date().toISOString(),
  };
}

function toTriageCase(
  feature: string,
  spec: string,
  analysis: FailureAnalysis,
  record: TriageRecord | undefined,
): TriageCase {
  return {
    feature,
    spec,
    predicted: {
      label: analysis.label,
      confidence: analysis.confidence,
      ...(analysis.subDiagnosis ? { subDiagnosis: analysis.subDiagnosis } : {}),
      headline: analysis.headline,
    },
    actual: record
      ? {
          cause: record.actualCause as FailureLabel,
          ...(record.note ? { note: record.note } : {}),
          recordedAt: record.recordedAt,
        }
      : null,
  };
}
