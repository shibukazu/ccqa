import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Run, type RunStatus, type SpecLedger, type SpecLedgerEntry } from "../../contract/schema.ts";
import { GitEnvelopeSchema, RunReportDataSchema, ReportSpecResultSchema, type ReportSpecResult, type RunReportData } from "../../../report/schema.ts";
import type { ReportEnvelope } from "../../../run/incremental-report.ts";
import { unpackTarGz } from "../../core/tar.ts";
import { emptyLedger } from "../../core/spec-ledger.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { errMsg, HttpError, readBody, readJsonBody, sendBytes, sendJson } from "../respond.ts";
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
    const { project, branch, profile, kind, deployedSha } = parseRunScope(ctx);

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
        runUrl: report.runUrl ?? null,
        reportCreatedAt: report.createdAt,
        createdAt: new Date().toISOString(),
        // A pushed run is already over, so the head the hub reads here is the
        // head *after* it. A deploy that landed mid-run therefore reads as the
        // run's baseline and under-reports "needs re-run" — pass ?deployedSha=
        // (captured before the run started) to close that window.
        ...(await resolveDeployedSha(config.storage, project, profile, deployedSha)),
        deployedShaAmbiguous: false,
      };

      // Store artifacts before the run record so that once the run is listable,
      // its report is always fetchable.
      await config.storage.artifacts.putDir(run.id, dir);
      await config.storage.runs.create(run);
      await updateSpecLedger(config.storage, run, report.results);

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
 * POST /api/v1/runs/open?project=&branch=&profile=&kind=&gitHead= — start a
 * "running" run with no report yet. Unlike `POST /runs`, nothing is pushed up
 * front: the caller patches results in as they finish (`PATCH /runs/:id`), so
 * an interrupted run still leaves a partial report on the hub instead of
 * none. `gitHead` (optional) attributes the run to a commit from the start —
 * without it an interrupted run would never learn its commit.
 */
export function createOpenRunHandler(config: OpenRunHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const { project, branch, profile, kind, deployedSha } = parseRunScope(ctx);
    const gitHead = ctx.url.searchParams.get("gitHead");
    // Attributed from the start (like gitHead) so an incremental run that dies
    // before its final reconcile patch still links back to its CI run.
    const ciRunId = ctx.url.searchParams.get("ciRunId");
    const runUrl = ctx.url.searchParams.get("runUrl");

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
      gitHead: gitHead || null,
      promptVersion: "",
      ciRunId: ciRunId || null,
      runUrl: runUrl || null,
      reportCreatedAt: now,
      createdAt: now,
      // Stamped at open, not at finalize: this is the commit the environment
      // was actually running when the run started. The finalize patch checks
      // whether the head moved underneath it.
      ...(await resolveDeployedSha(config.storage, project, profile, deployedSha)),
      deployedShaAmbiguous: false,
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
      // Derived from the report envelope's git schema so a new field can't be
      // silently stripped here (which would 400 the final `done` patch).
      git: GitEnvelopeSchema.partial().optional(),
      model: z.string().nullable().optional(),
      language: z.string().nullable().optional(),
      promptVersion: z.string().optional(),
      customPromptVersion: z.string().nullable().optional(),
      runUrl: z.string().nullable().optional(),
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
 * Advance the spec ledger's three buckets from a terminal `kind: "run"` run.
 * Spec-level, not run-level: a run with one chronically failing spec still
 * moves the baselines of every spec that did pass.
 *
 * A skipped row did not execute, so it advances nothing — not even `run`.
 * Everything else lands in `run` (the "needs re-run" baseline) and in `green`
 * or `red` (the last outcome), which are orthogonal axes.
 *
 * Best-effort — a ledger failure must not fail the push; the ledger is an
 * accelerator for `--failure-analysis=last-green` and re-run selection, not
 * part of the run record. Runs without a branch or gitHead can't be placed in
 * the ledger and are skipped.
 *
 * Ordering caveat (known approximation): `at` is the run's reportCreatedAt —
 * open time for incremental runs, report time for immutable pushes. When two
 * runs on the same branch+profile overlap, "newest at wins" can pick either
 * of the two genuinely-green commits, since the hub has no git ancestry to
 * order them properly. Accepted: CI serializes per branch in practice, and a
 * baseline can only ever point at a commit where the spec really ran.
 */
async function updateSpecLedger(
  storage: HubStorage,
  run: Run,
  results: ReportSpecResult[],
): Promise<void> {
  const { gitHead, branch } = run;
  if (run.kind !== "run" || !gitHead || !branch) return;
  const entry: SpecLedgerEntry = {
    gitHead,
    runId: run.id,
    at: run.reportCreatedAt,
    // Denormalized from the Run so a re-run verdict is pure ledger + deploy
    // log, with no per-spec run lookup.
    deployedSha: run.deployedSha ?? null,
    deployedShaAmbiguous: run.deployedShaAmbiguous ?? false,
  };
  const ledger: SpecLedger = emptyLedger();
  for (const row of results) {
    if (row.status === "skipped") continue;
    const key = `${row.feature}/${row.spec}`;
    ledger.run[key] = entry;
    if (row.status === "passed") ledger.green[key] = entry;
    else ledger.red[key] = entry;
  }
  if (Object.keys(ledger.run).length === 0) return;
  try {
    await storage.ledger.merge(run.project, run.profile ?? "default", branch, ledger);
  } catch (err) {
    console.error(`hub: spec ledger update failed for run "${run.id}": ${errMsg(err)}`);
  }
}

/**
 * What commit the environment was running for this run. An explicit
 * `?deployedSha=` wins — ccqa never guesses a baseline, and a caller that
 * knows what it deployed against is more authoritative than the log head.
 *
 * Best-effort: a deploy log the hub can't read leaves the run unattributed
 * (re-run selection then answers `unknown`) rather than rejecting the run.
 */
async function resolveDeployedSha(
  storage: HubStorage,
  project: string,
  profile: string | null,
  explicit: string | null,
): Promise<Pick<Run, "deployedSha" | "deployedShaSource">> {
  if (explicit) return { deployedSha: explicit, deployedShaSource: "client" };
  try {
    const head = await storage.deploys.head(project, profile ?? "default");
    if (head) return { deployedSha: head.sha, deployedShaSource: "hub-deploy-log" };
  } catch (err) {
    console.error(`hub: could not read the deploy log for "${project}/${profile ?? "default"}": ${errMsg(err)}`);
  }
  return { deployedSha: null, deployedShaSource: null };
}

/**
 * True when the deploy-log head moved while the run was open: the run
 * straddled a deploy, so which commit it exercised is not knowable and re-run
 * selection must report `unknown` instead of picking one. Only meaningful for
 * a sha the hub stamped itself — a client-asserted one is the caller's claim
 * about its own run, not the hub's observation.
 */
async function deployHeadMovedDuringRun(storage: HubStorage, run: Run): Promise<boolean> {
  if (run.deployedShaSource !== "hub-deploy-log" || !run.deployedSha) return false;
  try {
    const head = await storage.deploys.head(run.project, run.profile ?? "default");
    return head !== null && head.sha !== run.deployedSha;
  } catch {
    return false;
  }
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

    const { rows, evidence, done, finalStatus, reportMeta } = await readJsonBody(
      ctx.req,
      maxPushBytes,
      PatchRunRequestSchema,
      "request body",
    );

    // `mutate` runs inside the storage layer; capture the recomputed specs and
    // the merged results via closure so they're available afterward to update
    // the Run record and (on `done`) the spec ledger.
    let specs = run.specs;
    let mergedResults: ReportSpecResult[] = [];
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
        ...(reportMeta?.git
          ? {
              git: {
                head: reportMeta.git.head ?? base.git.head,
                base: reportMeta.git.base ?? base.git.base,
                baseSha: reportMeta.git.baseSha ?? base.git.baseSha ?? null,
                baseSource: reportMeta.git.baseSource ?? base.git.baseSource ?? null,
              },
            }
          : {}),
        ...(reportMeta?.model !== undefined ? { model: reportMeta.model } : {}),
        ...(reportMeta?.language !== undefined ? { language: reportMeta.language } : {}),
        ...(reportMeta?.promptVersion !== undefined ? { promptVersion: reportMeta.promptVersion } : {}),
        ...(reportMeta?.customPromptVersion !== undefined ? { customPromptVersion: reportMeta.customPromptVersion } : {}),
        ...(reportMeta?.runUrl !== undefined ? { runUrl: reportMeta.runUrl } : {}),
        ...(reportMeta?.triageUserPromptHash !== undefined ? { triageUserPromptHash: reportMeta.triageUserPromptHash } : {}),
      };
      const merged = mergeResults(current?.results ?? [], rows);
      specs = countSpecs(merged);
      mergedResults = merged;
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
          ...((await deployHeadMovedDuringRun(config.storage, run)) ? { deployedShaAmbiguous: true } : {}),
        }
      : { specs };
    const updated = await config.storage.runs.update(id, patch);
    if (done) await updateSpecLedger(config.storage, updated, mergedResults);

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
 * Parse the `project`/`branch`/`profile`/`kind`/`deployedSha` query params
 * shared by `POST /runs` (push) and `POST /runs/open`. `project` is required;
 * `profile` is optional and recorded for display only (runs are not scoped by
 * profile); `kind` defaults to "run"; `deployedSha` overrides what the hub
 * would read from the profile's deploy log.
 */
function parseRunScope(ctx: RouteContext): {
  project: string;
  branch: string | null;
  profile: string | null;
  kind: "run" | "drift";
  deployedSha: string | null;
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
  const deployedSha = boundedParam(ctx.url.searchParams.get("deployedSha"), "deployedSha", 64);
  return { project, branch, profile, kind: kindRaw ?? "run", deployedSha };
}

/**
 * A branch is a free-form label (e.g. `feature/foo`), so `/` is allowed —
 * only length is bounded (a sanity cap; the last-green ledger separately
 * hash-truncates long percent-encoded names into a safe filename, see
 * paths.ts). Run records store it verbatim. null when the client didn't
 * send one. Exported for the last-green handler.
 */
export function requireBranch(raw: string | null): string | null {
  return boundedParam(raw, "branch", 256);
}

/** An opaque free-form query param: null when absent, otherwise length-capped as a sanity check. */
function boundedParam(raw: string | null, name: string, max: number): string | null {
  if (raw === null || raw === "") return null;
  if (raw.length > max) throw new HttpError(400, "invalid_param", `${name} is too long (max ${max} chars)`);
  return raw;
}

