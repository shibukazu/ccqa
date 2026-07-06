import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Run, type RunStatus } from "../../contract/schema.ts";
import { RunReportDataSchema, type ReportSpecResult } from "../../../report/schema.ts";
import { unpackTarGz } from "../../core/tar.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendBytes, sendJson } from "../respond.ts";
import { requireSafeRelPath, requireSafeSegment } from "../validate.ts";

/** Default cap on a pushed report bundle. Overridable via `serve --max-push-mb`. */
const DEFAULT_MAX_PUSH_BYTES = 32 * 1024 * 1024;

export interface PushRunHandlerConfig {
  storage: HubStorage;
  maxPushBytes?: number;
}

/**
 * POST /api/v1/runs?project=&branch= — accept the report directory (as a
 * tar.gz) of an already-finished `ccqa run` and record it as an immutable
 * Run. The hub never executes anything; every field of the Run is derived
 * from the pushed report.
 */
export function createPushRunHandler(config: PushRunHandlerConfig) {
  const maxPushBytes = config.maxPushBytes ?? DEFAULT_MAX_PUSH_BYTES;
  return async (ctx: RouteContext): Promise<void> => {
    const projectRaw = ctx.url.searchParams.get("project");
    if (!projectRaw) throw new HttpError(400, "missing_param", "project query parameter is required");
    const project = requireSafeSegment(projectRaw, "project");
    const branch = requireBranch(ctx.url.searchParams.get("branch"));
    // Optional: which profile (env-var set) the run executed against, recorded
    // for display only — runs are not scoped by profile.
    const profileRaw = ctx.url.searchParams.get("profile");
    const profile = profileRaw ? requireSafeSegment(profileRaw, "profile") : null;
    const kindRaw = ctx.url.searchParams.get("kind");
    if (kindRaw !== null && kindRaw !== "run" && kindRaw !== "drift") {
      throw new HttpError(400, "invalid_param", `invalid kind: must be "run" or "drift"`);
    }
    const kind = kindRaw ?? "run";

    const body = await readBody(ctx.req, maxPushBytes);

    const dir = await mkdtemp(join(tmpdir(), "ccqa-hub-push-"));
    try {
      try {
        await unpackTarGz(body, dir);
      } catch (err) {
        throw new HttpError(400, "invalid_archive", `could not read the pushed archive: ${errMsg(err)}`);
      }

      let reportJson: unknown;
      try {
        reportJson = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
      } catch {
        // Missing report.json, or present but not valid JSON — both are the
        // client pushing a bad bundle (400), never a hub-side fault (500).
        throw new HttpError(
          400,
          "invalid_report",
          "report.json is missing or not valid JSON — push a report directory produced by `ccqa run --report`",
        );
      }
      const parsed = RunReportDataSchema.safeParse(reportJson);
      if (!parsed.success) {
        throw new HttpError(400, "invalid_report", `report.json is not a valid report: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
      }
      const report = parsed.data;
      if (report.kind !== kind) {
        throw new HttpError(
          400,
          "kind_mismatch",
          `?kind=${kind} does not match report.json's kind ("${report.kind}") — push with the matching ?kind= query param`,
        );
      }

      const total = report.results.length;
      const failed = report.results.filter((r) => r.status === "failed").length;
      const status: RunStatus = failed > 0 ? "failed" : "passed";
      const drift = kind === "drift" ? summarizeDrift(report.results) : null;

      const run: Run = {
        id: randomUUID(),
        project,
        profile,
        branch,
        status,
        kind,
        drift,
        specs: { total, passed: total - failed, failed },
        gitHead: report.git.head,
        promptVersion: report.promptVersion,
        ciRunId: report.runId,
        reportCreatedAt: report.createdAt,
        createdAt: new Date().toISOString(),
      };

      // Store artifacts before the run record so that once the run is listable,
      // its report is always fetchable.
      await config.storage.artifacts.putDir(run.id, dir);
      await config.storage.runs.create(run);

      sendJson(ctx.res, 201, run);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** GET /api/v1/runs?project&branch&status&limit */
export function createListRunsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = ctx.url.searchParams.get("project");
    const branch = ctx.url.searchParams.get("branch");
    const status = ctx.url.searchParams.get("status");
    const limitRaw = ctx.url.searchParams.get("limit");
    const runs = await storage.runs.list({
      ...(project ? { project } : {}),
      ...(branch ? { branch } : {}),
      ...(status ? { status: status as Run["status"] } : {}),
      ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    });
    sendJson(ctx.res, 200, { runs });
  };
}

/** GET /api/v1/runs/:id */
export function createGetRunHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const run = await getRunOr404(storage, ctx.params.id!);
    sendJson(ctx.res, 200, run);
  };
}

/** GET /api/v1/runs/:id/report */
export function createGetReportHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    await getRunOr404(storage, ctx.params.id!);
    const bytes = await storage.artifacts.read(ctx.params.id!, "report.json");
    if (!bytes) throw new HttpError(404, "not_found", "report.json not available for this run");
    sendBytes(ctx.res, 200, bytes, "application/json; charset=utf-8");
  };
}

/** GET /api/v1/runs/:id/artifacts (tar.gz) */
export function createGetArtifactsArchiveHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    await getRunOr404(storage, ctx.params.id!);
    const bytes = await storage.artifacts.readTarGz(ctx.params.id!);
    if (!bytes) throw new HttpError(404, "not_found", "no artifacts stored for this run");
    sendBytes(ctx.res, 200, bytes, "application/gzip");
  };
}

/** GET /api/v1/runs/:id/artifacts/*path (individual file — the hub UI fetches evidence PNGs this way) */
export function createGetArtifactFileHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    await getRunOr404(storage, ctx.params.id!);
    const relPath = requireSafeRelPath(ctx.params.path!, "artifacts path");
    const bytes = await storage.artifacts.read(ctx.params.id!, relPath);
    if (!bytes) throw new HttpError(404, "not_found", `artifact "${relPath}" not found for this run`);
    sendBytes(ctx.res, 200, bytes, contentTypeFor(relPath));
  };
}

function contentTypeFor(relPath: string): string {
  if (relPath.endsWith(".png")) return "image/png";
  if (relPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (relPath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

async function getRunOr404(storage: HubStorage, id: string): Promise<Run> {
  const run = await storage.runs.get(id);
  if (!run) throw new HttpError(404, "not_found", `run "${id}" not found`);
  return run;
}

/** Tally `driftIssues` across all specs into the `Run.drift` summary counters. */
function summarizeDrift(results: ReportSpecResult[]): { issues: number; errors: number; warnings: number; specsWithIssues: number } {
  let issues = 0;
  let errors = 0;
  let warnings = 0;
  let specsWithIssues = 0;
  for (const r of results) {
    const driftIssues = r.driftIssues ?? [];
    if (driftIssues.length > 0) specsWithIssues++;
    for (const issue of driftIssues) {
      issues++;
      if (issue.severity === "ERROR") errors++;
      else if (issue.severity === "WARN") warnings++;
    }
  }
  return { issues, errors, warnings, specsWithIssues };
}

/**
 * A branch is a free-form label (e.g. `feature/foo`), stored verbatim and
 * never used to build a filesystem path, so `/` is allowed — only length is
 * bounded. null when the client didn't send one.
 */
function requireBranch(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  if (raw.length > 256) throw new HttpError(400, "invalid_param", "branch is too long (max 256 chars)");
  return raw;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
