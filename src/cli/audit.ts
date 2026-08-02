import { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  ensureCcqaDir,
  listFeatureTree,
  loadAvailableBlocks,
  parseSpecPath,
} from "../store/index.ts";
import { errMessage, RunUsageError } from "../run/errors.ts";
import { analyzeDrift } from "../drift/analyze.ts";
import { renderDrift, type AuditJsonPayload } from "../drift/format.ts";
import { determineExitCode } from "../drift/exit-code.ts";
import { driftResultsToReport, driftResultToRow } from "../drift/to-report.ts";
import { currentReportCost } from "../report/run-cost.ts";
import type { Format, SpecResult, SpecTarget, Threshold } from "../drift/types.ts";
import type { DriftGuidance } from "../prompts/drift.ts";
import {
  buildCustomPromptBlock,
  buildTriageUserPromptBlock,
  fetchCustomPrompt,
  fetchTriageUserPrompt,
  hashTriageUserPrompt,
} from "../prompts/custom-prompt.ts";
import { collectChangedSpecs } from "./changed-specs.ts";
import type { HubClient } from "../hub-client/index.ts";
import { addLanguageOption, addProfileOption } from "./options.ts";
import { fetchAuditNeed, selectSpecsNeedingAudit } from "../drift/audit-selection.ts";
import { requireHubProfile } from "../run/hub-selection.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { ProjectNameError, resolveProject } from "./resolve-project.ts";
import {
  hubHeaderOption,
  hubTokenOption,
  hubUrlOption,
  HubConnectionError,
  resolveHubClient,
  resolveHubContext,
  type HubContext,
} from "./hub-conn.ts";
import {
  openHubRun,
  requireReportToHubConnection,
  sealHubRun,
  type HubRunPush,
} from "./open-hub-run.ts";
import { withUsageErrors } from "./usage-errors.ts";
import * as log from "./logger.ts";
import { withCostReporting } from "./cost-line.ts";

interface AuditOptions {
  reportFormat?: Format;
  exitOn?: Threshold;
  concurrency?: string;
  model?: string;
  cwd?: string;
  onlyAffectedBy?: string;
  onlyHubAuditNeeded?: boolean;
  hubProfile?: string;
  language?: string;
  reportToHub?: boolean;
  project?: string;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
}

const DEFAULT_CONCURRENCY = 3;

export const auditCommand = addProfileOption(addLanguageOption(
  new Command("audit")
    .argument(
      "[feature/spec]",
      "Optional spec id. If omitted, every spec under .ccqa/features/ is checked.",
    )
    .description(
      "Read each spec against the code it describes and report where the two have drifted. " +
        "Static: no browser is run, so this is the cheap check to put in front of `ccqa run`.",
    )
    .optionsGroup("Which specs to audit:")
    .option(
      "--only-affected-by <ref>",
      "Only specs `ccqa select-specs` judges reached by the diff against <ref> (e.g. origin/main). In pull_request CI, pass $GITHUB_BASE_REF. Costs one model call; specs it cannot decide are audited rather than skipped.",
    )
    .option(
      "--only-hub-audit-needed",
      "Only specs the hub says a deploy has landed on since the audit last read them. A spec that was never audited is always included, and one the hub cannot answer for is audited rather than skipped. No git diff involved. Requires a hub connection and --hub-profile.",
    )
    .optionsGroup("How to run it:")
    .option("--concurrency <n>", `Parallel spec checks (default: ${DEFAULT_CONCURRENCY})`)
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .optionsGroup("What to do with the results:")
    .option("--report-format <fmt>", "Output format: text | json | github", "text")
    .option(
      "--report-to-hub",
      "Push the result to a ccqa hub as a run (kind: drift), which is what updates the drift ledger. A spec it finds drifted answers `needsRepair` to `ccqa run --only-hub-rerun-needed`, and is not run until a person repairs it.",
    )
    .option(
      "--exit-on <level>",
      "Exit non-zero on this severity or higher: warn | error",
      "error",
    )
    .optionsGroup("Environment and connection:")
    .option(
      "--cwd <path>",
      "Working directory used as both the .ccqa root and the codebase Claude reads. Useful for monorepos. Defaults to process.cwd().",
    )
    .option("--project <name>", "Logical project name for the pushed run. Defaults to the current directory's name.")
    .option(...hubUrlOption)
    .option(...hubTokenOption)
    .option(...hubHeaderOption),
)).action(withUsageErrors(async (specPath: string | undefined, opts: AuditOptions) => {
  await withCostReporting("audit", () => runAudit(specPath, opts));
}));

async function runAudit(specPath: string | undefined, opts: AuditOptions): Promise<void> {
  const format = parseFormat(opts.reportFormat);
  const threshold = parseSeverity(opts.exitOn);
  const concurrency = parseConcurrency(opts.concurrency);
  const cwd = resolveCwd(opts.cwd);

  await ensureCcqaDir(cwd);

  if (opts.onlyAffectedBy && specPath) {
    log.error("--only-affected-by and an explicit spec id cannot be combined; it only applies to a full sweep");
    process.exit(2);
  }
  if (opts.onlyHubAuditNeeded && specPath) {
    log.error("--only-hub-audit-needed and an explicit spec id cannot be combined; it only applies to a full sweep");
    process.exit(2);
  }
  // The one --only-* pair that cannot compose. Both narrow, so together they
  // mean "due AND reached by the diff" — and a spec the hub says is due that
  // the diff drops is never audited, so its recorded commit never advances and
  // it is due again next time. The run side then never runs it either. Two
  // jobs at exit 0, forever.
  if (opts.onlyHubAuditNeeded && opts.onlyAffectedBy) {
    log.error(
      "--only-hub-audit-needed and --only-affected-by cannot be combined: a spec the hub says needs " +
        "auditing that the diff drops is never audited, so it stays due forever. Pick the one that " +
        "matches the job — the hub answer after a deploy, the diff on a pull request.",
    );
    process.exit(2);
  }

  // Resolved before the sweep so a usage error costs nothing: --only-affected-by
  // below spends a model call, and finding out after it that --hub-profile is
  // missing would bill for the mistake.
  let hub: HubClient | null = null;
  let hubProject: string | null = null;
  // Set only on the --only-hub-audit-needed path, which is also the only one
  // that resolves `hub` and `hubProject`.
  let holder: string | null = null;
  if (opts.onlyHubAuditNeeded) {
    hub = resolveHubClient(opts);
    if (!hub) {
      log.error(
        "--only-hub-audit-needed requires a hub connection: pass --hub-url/--hub-token (or set CCQA_HUB_URL/CCQA_HUB_TOKEN)",
      );
      process.exit(2);
    }
    requireHubProfile("--only-hub-audit-needed", opts.hubProfile, "which specs a deploy has reached");
    hubProject = resolveProject({ project: opts.project, cwd });
  }

  let targets = await collectTargets(specPath, cwd);
  if (targets.length === 0) {
    exitWithNoSpecs(format, "noSpecsFound", "no test specs found under .ccqa/features/");
  }

  if (format === "text") {
    log.header("audit", specPath ?? `${targets.length} spec${targets.length > 1 ? "s" : ""}`);
    if (opts.cwd) log.meta("cwd", cwd);
  }

  // Ahead of --only-affected-by: the two compose with AND, and this side is
  // one HTTP round trip where that one is a model call. Narrowing here shrinks
  // the prompt, and skips it entirely when nothing is left to audit.
  if (opts.onlyHubAuditNeeded) {
    const total = targets.length;
    const report = await fetchAuditNeed({ hub: hub!, project: hubProject! }, opts.hubProfile!);
    const selection = selectSpecsNeedingAudit(targets, report);
    targets = selection.selected;
    if (format === "text") {
      log.meta("hub", selection.summary);
      log.meta("scoped", `${targets.length} of ${total} spec${total > 1 ? "s" : ""}`);
    }
    if (targets.length === 0) {
      exitWithNoSpecs(format, "allCurrent", "every spec has been audited since the last deploy that reached it");
    }

    // Claim what is left, so a second cycle starting while this one runs does
    // not audit the same specs and write the same ledger entries twice.
    holder = randomUUID();
    const claimed = await claimSpecs(hub!, hubProject!, opts.hubProfile!, targets, holder);
    if (claimed.length < targets.length && format === "text") {
      log.meta("held-elsewhere", `${targets.length - claimed.length} spec(s) another job is auditing`);
    }
    targets = claimed;
    if (targets.length === 0) {
      exitWithNoSpecs(format, "allHeld", "every spec that needs auditing is already being audited by another job");
    }
  }

  let baseRef: string | null = null;

  if (opts.onlyAffectedBy) {
    const total = targets.length;
    const selection = await collectChangedSpecs(targets, {
      cwd,
      base: opts.onlyAffectedBy,
      quiet: format !== "text",
      ...(opts.model ? { model: opts.model } : {}),
    });
    // The base reported to the hub is the one selection actually diffed
    // against — resolving it a second time here could name another commit.
    targets = selection.specs;
    baseRef = selection.base.ref;
    if (format === "text") {
      log.meta("scoped", `${targets.length} of ${total} spec${total > 1 ? "s" : ""}`);
    }
    if (targets.length === 0) {
      exitWithNoSpecs(format, "noDiffIntersection", "no specs intersect the changed file set; nothing to check");
    }
  }

  const blocks = await loadAvailableBlocks(cwd);
  // Resolved before the prompt-context fetch and the sweep itself: a job that
  // asked to publish and cannot reach the hub should not spend the sweep first.
  let pushConn: HubContext | null = null;
  if (opts.reportToHub) {
    const pushHub = resolveHubClient(opts);
    pushConn = requireReportToHubConnection(
      pushHub && { hub: pushHub, project: resolveProject({ project: opts.project, cwd }) },
    );
  }

  let results: SpecResult[];
  let promptCtx: AuditPromptContext;
  // Opened before the sweep so each spec can be sent the moment it lands. A
  // sweep of every spec runs well past a CI job's timeout, and the audit's
  // only output is the hub — batching the push to the end means an interrupt
  // throws away everything the sweep already paid for.
  let push: HubRunPush | null = null;
  try {
    promptCtx = await resolveAuditPromptContext(opts, cwd);
    if (pushConn) {
      push = await openHubRun("drift", pushConn, cwd, opts.hubProfile);
      if (format === "text") log.info(`hub: incremental drift run opened (${push.runId})`);
    }
    results = await analyzeDrift({
      targets,
      cwd,
      blocks,
      concurrency,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      guidance: promptCtx.guidance,
      onSpecStart: (t) => {
        if (format === "text") log.info(`checking ${t.featureName}/${t.specName}`);
      },
      onSpecDone: async (r) => {
        if (push) await sendDriftRow(push, r, threshold);
      },
    });
  } finally {
    // The claim's only job is keeping a second cycle from re-auditing these
    // specs while this sweep is in flight; that ends here, whether the sweep
    // succeeded or threw. Released before any `process.exit` below — a plain
    // `finally` wrapping those calls would not run, since `process.exit`
    // never unwinds.
    if (holder) await releaseSpecs(hub!, hubProject!, opts.hubProfile!, holder);
  }

  process.stdout.write(renderDrift(results, format, cwd));

  if (push) await sealDriftPush(push, { results, threshold, opts, format, baseRef, promptCtx });

  process.exit(determineExitCode(results, threshold));
}

/** Longer than the audit's own timeout, so a sweep cannot outlive its claim. */
const AUDIT_LOCK_TTL_SECONDS = 90 * 60;

/**
 * Take the specs this sweep is about to audit. Best-effort against the hub:
 * one too old to serve claims must not stop an audit that would otherwise run.
 */
async function claimSpecs(
  hub: HubClient,
  project: string,
  profile: string,
  targets: readonly SpecTarget[],
  holder: string,
): Promise<SpecTarget[]> {
  try {
    const res = await hub.acquireLocks(project, { profile }, {
      specs: targets.map((t) => `${t.featureName}/${t.specName}`),
      kind: "audit",
      holder,
      ttlSeconds: AUDIT_LOCK_TTL_SECONDS,
    });
    const granted = new Set(res.granted);
    return targets.filter((t) => granted.has(`${t.featureName}/${t.specName}`));
  } catch (err) {
    log.warn(`could not claim specs on the hub, auditing without exclusion: ${errMessage(err)}`);
    return [...targets];
  }
}

async function releaseSpecs(
  hub: HubClient,
  project: string,
  profile: string,
  holder: string,
): Promise<void> {
  try {
    await hub.releaseLocks(project, { profile }, holder);
  } catch (err) {
    log.warn(`could not release the spec claims: ${errMessage(err)}`);
  }
}

/**
 * Send one finished spec. A failure is warned and swallowed rather than
 * thrown: the seal resends every row, so a dropped patch costs freshness for
 * the rest of the sweep, not the record.
 */
export async function sendDriftRow(push: HubRunPush, result: SpecResult, threshold: Threshold): Promise<void> {
  try {
    await push.hub.patchRun(push.runId, {
      rows: [driftResultToRow(result, threshold)],
      // Rides along per row so a sweep still in flight shows what it has spent.
      reportMeta: { cost: currentReportCost() },
    });
  } catch (err) {
    log.warn(`hub: could not push ${result.target.featureName}/${result.target.specName}: ${errMessage(err)}`);
  }
}

/**
 * Close the run with every row and the envelope metadata. Resends all rows
 * rather than only the unsent ones, so this one call also repairs any row
 * whose mid-sweep patch failed. Status is left to the hub, which derives it
 * from the rows.
 */
export async function sealDriftPush(
  push: HubRunPush,
  args: {
    results: SpecResult[];
    threshold: Threshold;
    opts: AuditOptions;
    format: Format;
    baseRef?: string | null;
    /** Absent only in tests that call this directly without the guidance phase. */
    promptCtx?: AuditPromptContext;
  },
): Promise<void> {
  const { results, threshold, opts, format, baseRef, promptCtx } = args;
  // Branch and head come from the open, not from git again: the sealed
  // envelope then names the same commit the run was attributed to.
  const report = driftResultsToReport(results, {
    threshold,
    git: { head: push.gitHead, base: baseRef ?? null },
    customPromptVersion: promptCtx?.customPromptVersion ?? null,
    triageUserPromptHash: promptCtx?.triageUserPromptHash ?? null,
  });

  const sealed = await sealHubRun(push, {
    rows: report.results,
    reportMeta: {
      git: report.git,
      promptVersion: report.promptVersion,
      customPromptVersion: report.customPromptVersion,
      ...(report.triageUserPromptHash ? { triageUserPromptHash: report.triageUserPromptHash } : {}),
      cost: report.cost,
    },
  });
  // A run left `running` holds a wrong record, not a missing one: the sweep
  // must not report success. Nothing is queued behind this call, so the audit
  // takes the exit here rather than carrying the failure back up.
  if (!sealed) process.exit(2);

  if (format === "text") {
    // Derived here rather than through `resolveBaseUrl`, which exits when no
    // URL is set — by this point the push has landed, so an unset URL should
    // cost a link, not the run.
    const baseUrl = (opts.hubUrl ?? process.env.CCQA_HUB_URL ?? "").replace(/\/+$/, "");
    log.info(`pushed drift result to hub: ${baseUrl}/#/runs/${push.runId}`);
  }
}

/** The audit's hub-stored guidance, plus what a `--report-to-hub` push records as its provenance. */
export interface AuditPromptContext {
  guidance: DriftGuidance;
  customPromptVersion: string | null;
  triageUserPromptHash: string | null;
}

/**
 * Adapts `AuditOptions` to `resolveHubContext`'s flat option shape. Unlike
 * `resolveHubContextOrNull`, this only swallows the two errors that mean "no
 * usable hub for guidance" (no connection configured; hub configured but the
 * project name can't be resolved, warned so it isn't silent) — anything else
 * (e.g. a malformed --hub-header/CCQA_HUB_HEADER) propagates instead of being
 * discovered only after the sweep has already spent its budget.
 */
export function resolveAuditHubContext(opts: AuditOptions, cwd: string): HubContext | null {
  try {
    return resolveHubContext({
      hubUrl: opts.hubUrl,
      hubToken: opts.hubToken,
      hubHeader: opts.hubHeader,
      project: opts.project,
      cwd,
    });
  } catch (err) {
    if (err instanceof HubConnectionError) return null;
    if (err instanceof ProjectNameError) {
      log.warn(`hub is configured but its project name could not be resolved, so audit guidance will not be applied: ${err.message}`);
      return null;
    }
    throw err;
  }
}

/**
 * Resolve this sweep's hub-stored guidance (`audit.user` + `audit.agent`)
 * once. Unlike the "no hub configured" case above, an unreachable hub stops
 * the audit (`asHubReadError`) rather than degrading. No per-spec target
 * exists to scope `audit.agent` by, so its top-level note is used as-is.
 */
export async function resolveAuditPromptContext(
  opts: AuditOptions,
  cwd: string,
  resolveCtx: (opts: AuditOptions, cwd: string) => HubContext | null = resolveAuditHubContext,
): Promise<AuditPromptContext> {
  const hubCtx = resolveCtx(opts, cwd);
  const [triageUserPrompt, customPrompt] = await Promise.all([
    fetchTriageUserPrompt(hubCtx, "audit.user"),
    fetchCustomPrompt(hubCtx, "audit.agent"),
  ]).catch(asHubReadError);
  return {
    guidance: {
      userPromptBlock: buildTriageUserPromptBlock(triageUserPrompt, "audit.user"),
      customPromptBlock: buildCustomPromptBlock(customPrompt, "audit.agent"),
    },
    customPromptVersion: customPrompt?.customPromptVersion ?? null,
    triageUserPromptHash: triageUserPrompt ? hashTriageUserPrompt(triageUserPrompt) : null,
  };
}

/**
 * Turn a hub transport failure into a usage error (exit 2 via `withUsageErrors`)
 * instead of an unhandled rejection — same contract as the run pipeline's
 * identically-named helper.
 */
function asHubReadError(err: unknown): never {
  throw new RunUsageError(`could not read from the hub: ${errMessage(err)}`);
}

/**
 * Nothing to audit. The reason rides in the payload because the four are not
 * interchangeable to a CI job reading the JSON: "every spec is current" is the
 * happy path, while "no specs found" usually means a wrong --cwd or a checkout
 * that did not include the spec tree, and both looked identical before.
 */
type NoSpecsReason = "noSpecsFound" | "allCurrent" | "allHeld" | "noDiffIntersection";

function exitWithNoSpecs(format: Format, reason: NoSpecsReason, message: string): never {
  if (format === "json") {
    const payload: AuditJsonPayload = { specs: [], skipped: reason };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (format === "text") {
    log.info(message);
  } else if (format === "github" && reason === "noSpecsFound") {
    // The one that is usually a mistake, in the one format that otherwise
    // leaves no trace at all.
    process.stdout.write(`::warning::${message}\n`);
  }
  process.exit(0);
}

async function collectTargets(specPath: string | undefined, cwd: string): Promise<SpecTarget[]> {
  const tree = await listFeatureTree(cwd);
  if (specPath) {
    const { featureName, specName } = parseSpecPath(specPath);
    const spec = tree.find((f) => f.featureName === featureName)?.specs.find((s) => s.specName === specName);
    if (!spec?.hasSpecFile) {
      log.error(`spec not found: ${featureName}/${specName} (under ${cwd})`);
      process.exit(1);
    }
    return [{ featureName, specName }];
  }

  const out: SpecTarget[] = [];
  for (const feature of tree) {
    for (const spec of feature.specs) {
      if (!spec.hasSpecFile) continue;
      out.push({ featureName: feature.featureName, specName: spec.specName });
    }
  }
  return out;
}

function parseFormat(raw: string | undefined): Format {
  const v = raw ?? "text";
  if (v === "text" || v === "json" || v === "github") return v;
  log.error(`invalid --format: ${v} (expected text|json|github)`);
  process.exit(2);
}

function parseSeverity(raw: string | undefined): Threshold {
  const v = raw ?? "error";
  if (v === "warn" || v === "error") return v;
  log.error(`invalid --exit-on: ${v} (expected warn|error)`);
  process.exit(2);
}

function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    log.error(`invalid --concurrency: ${raw} (expected positive integer)`);
    process.exit(2);
  }
  return n;
}

export type { SpecResult, SpecTarget } from "../drift/types.ts";
export { determineExitCode } from "../drift/exit-code.ts";
