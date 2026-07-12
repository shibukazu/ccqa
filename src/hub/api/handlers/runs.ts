import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Run, type RunStatus } from "../../contract/schema.ts";
import { RunReportDataSchema, ReportSpecResultSchema, type ReportSpecResult, type RunReportData } from "../../../report/schema.ts";
import type { ReportEnvelope } from "../../../run/incremental-report.ts";
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
    const { project, branch, profile, kind } = parseRunScope(ctx);

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

export interface OpenRunHandlerConfig {
  storage: HubStorage;
}

/**
 * POST /api/v1/runs/open?project=&branch=&profile=&kind= — start a "running"
 * run with no report yet. Unlike `POST /runs`, nothing is pushed up front:
 * the caller patches results in as they finish (`PATCH /runs/:id`), so an
 * interrupted run still leaves a partial report on the hub instead of none.
 */
export function createOpenRunHandler(config: OpenRunHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const { project, branch, profile, kind } = parseRunScope(ctx);

    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      project,
      profile,
      branch,
      status: "running",
      kind,
      drift: null,
      specs: { total: 0, passed: 0, failed: 0 },
      gitHead: null,
      promptVersion: "",
      ciRunId: null,
      reportCreatedAt: now,
      createdAt: now,
    };

    await config.storage.runs.create(run);
    sendJson(ctx.res, 201, run);
  };
}

const PatchRunRequestSchema = z.object({
  rows: z.array(ReportSpecResultSchema),
  evidence: z.record(z.string(), z.string()).optional(),
  done: z.boolean().optional(),
  finalStatus: z.enum(["passed", "failed"]).optional(),
  reportMeta: z
    .object({
      git: z.object({ head: z.string().nullable(), base: z.string().nullable() }).partial().optional(),
      model: z.string().nullable().optional(),
      language: z.string().nullable().optional(),
      promptVersion: z.string().optional(),
      customPromptVersion: z.string().nullable().optional(),
      triageUserPromptHash: z.string().optional(),
    })
    .partial()
    .optional(),
});

export interface PatchRunHandlerConfig {
  storage: HubStorage;
  maxPushBytes?: number;
}

/** Insert or replace `rows` into `results`, upserting by feature/spec identity. */
function mergeResults(existing: ReportSpecResult[], rows: ReportSpecResult[]): ReportSpecResult[] {
  const byKey = new Map(existing.map((r) => [`${r.feature}/${r.spec}`, r]));
  for (const row of rows) byKey.set(`${row.feature}/${row.spec}`, row);
  return [...byKey.values()];
}

function countSpecs(results: ReportSpecResult[]): { total: number; passed: number; failed: number } {
  const total = results.length;
  const failed = results.filter((r) => r.status === "failed").length;
  // Count "passed" explicitly: skipped rows are neither passed nor failed.
  const passed = results.filter((r) => r.status === "passed").length;
  return { total, passed, failed };
}

/**
 * PATCH /api/v1/runs/:id — incrementally add spec results (and evidence) to a
 * "running" run. Once the run is terminal (`done: true` was sent, or it was
 * pushed immutably via `POST /runs`), further patches are rejected with 409.
 */
export function createPatchRunHandler(config: PatchRunHandlerConfig) {
  const maxPushBytes = config.maxPushBytes ?? DEFAULT_MAX_PUSH_BYTES;
  return async (ctx: RouteContext): Promise<void> => {
    const id = ctx.params.id!;
    const run = await getRunOr404(config.storage, id);
    if (run.status !== "running") {
      throw new HttpError(409, "conflict", "run is not running (already terminal)");
    }
    // report.json and the Run record are each updated through their own
    // per-path serialization (updateJsonFile / runs.update), and the terminal
    // check above is a separate read. That's sufficient because a single
    // `ccqa run` is the only writer for a given run id and serializes its own
    // patches (the incremental-report promise chain; the reconcile is awaited
    // after the pool drains). If the hub ever allows concurrent writers to one
    // run id, the report mutation + specs recompute + record write would need a
    // single run-id-keyed critical section to keep Run.specs and report.json in
    // agreement.

    const raw = await readBody(ctx.req, maxPushBytes);
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_body", "request body is not valid JSON");
    }
    const parsed = PatchRunRequestSchema.safeParse(bodyJson);
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", `request body is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const { rows, evidence, done, finalStatus, reportMeta } = parsed.data;

    // `mutate` runs inside the storage layer; capture the recomputed specs via
    // closure so they're available afterward to update the Run record.
    let specs = run.specs;
    await config.storage.artifacts.updateJsonFile<RunReportData>(id, "report.json", (current) => {
      // The per-spec patches created report.json early with provisional
      // metadata (git=null, model=null — the diff isn't known until failure
      // analysis). The reconcile patch carries the real `reportMeta`, so merge
      // any provided fields over the existing envelope rather than discarding
      // them when report.json already exists — otherwise git/model/language
      // would stay stuck at their open-time defaults forever.
      const base: ReportEnvelope = current ?? {
        schemaVersion: 1,
        kind: run.kind,
        createdAt: run.reportCreatedAt,
        runId: run.ciRunId,
        git: { head: null, base: null },
        model: null,
        language: null,
        promptVersion: "",
        customPromptVersion: null,
      };
      const envelope: ReportEnvelope = {
        ...base,
        ...(reportMeta?.git ? { git: { head: reportMeta.git.head ?? base.git.head, base: reportMeta.git.base ?? base.git.base } } : {}),
        ...(reportMeta?.model !== undefined ? { model: reportMeta.model } : {}),
        ...(reportMeta?.language !== undefined ? { language: reportMeta.language } : {}),
        ...(reportMeta?.promptVersion !== undefined ? { promptVersion: reportMeta.promptVersion } : {}),
        ...(reportMeta?.customPromptVersion !== undefined ? { customPromptVersion: reportMeta.customPromptVersion } : {}),
        ...(reportMeta?.triageUserPromptHash !== undefined ? { triageUserPromptHash: reportMeta.triageUserPromptHash } : {}),
      };
      const merged = mergeResults(current?.results ?? [], rows);
      specs = countSpecs(merged);
      return { ...envelope, results: merged };
    });

    if (evidence) {
      for (const [relPath, b64] of Object.entries(evidence)) {
        await config.storage.artifacts.putFile(id, relPath, Buffer.from(b64, "base64"));
      }
    }

    const patch: Partial<Run> = done
      ? {
          status: finalStatus ?? (specs.failed > 0 ? "failed" : "passed"),
          specs,
          ...(reportMeta?.git?.head ? { gitHead: reportMeta.git.head } : {}),
          ...(reportMeta?.promptVersion ? { promptVersion: reportMeta.promptVersion } : {}),
        }
      : { specs };
    const updated = await config.storage.runs.update(id, patch);

    sendJson(ctx.res, 200, updated);
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

// Covers evidence PNGs plus the run-artifact kinds the UI renders inline
// (see src/targets/run-artifacts.ts) — an image data URI with the wrong mime
// won't render, and text served as octet-stream downloads instead of opening.
function contentTypeFor(relPath: string): string {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (/\.(txt|log|md|yaml|yml)$/.test(lower)) return "text/plain; charset=utf-8";
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
 * Parse the `project`/`branch`/`profile`/`kind` query params shared by
 * `POST /runs` (push) and `POST /runs/open`. `project` is required; `profile`
 * is optional and recorded for display only (runs are not scoped by profile);
 * `kind` defaults to "run".
 */
function parseRunScope(ctx: RouteContext): {
  project: string;
  branch: string | null;
  profile: string | null;
  kind: "run" | "drift";
} {
  const projectRaw = ctx.url.searchParams.get("project");
  if (!projectRaw) throw new HttpError(400, "missing_param", "project query parameter is required");
  const project = requireSafeSegment(projectRaw, "project");
  const branch = requireBranch(ctx.url.searchParams.get("branch"));
  const profileRaw = ctx.url.searchParams.get("profile");
  const profile = profileRaw ? requireSafeSegment(profileRaw, "profile") : null;
  const kindRaw = ctx.url.searchParams.get("kind");
  if (kindRaw !== null && kindRaw !== "run" && kindRaw !== "drift") {
    throw new HttpError(400, "invalid_param", `invalid kind: must be "run" or "drift"`);
  }
  return { project, branch, profile, kind: kindRaw ?? "run" };
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
