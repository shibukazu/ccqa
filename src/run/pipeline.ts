import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  getTestScript,
  listAllSpecsWithSpecFile,
  loadAllBlocks,
  projectAvailableBlocks,
  resolveSpecTargets,
  specKey,
  tryReadSpecFile,
  type SpecRef,
} from "../store/index.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import { AGENT_BROWSER_TARGET, type TestSpec } from "../spec/yaml-schema.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestStreaming } from "../runtime/spawn-vitest.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { runPool } from "../runtime/pool.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import {
  analyzeExternalRows,
  beginFailureAnalysis,
  needsAnalysis,
  type FailureAnalysisDeps,
  type FailureAnalysisRun,
} from "./failure-analysis.ts";
import {
  rerunExplainedFailures,
  type ExplainRerunMode,
  type RerunOutcome,
} from "./explain-rerun.ts";
import { createDiffProvider, type DiffProvider } from "./diff-provider.ts";
import { LAST_GREEN, resolveAnalysisBase, type GitContext } from "./git-context.ts";
import { createLastGreenResolver, fetchLastGreenLedger } from "./last-green.ts";
import { tryDeployHeadSha } from "./deploy-head.ts";
import { formatDryRunLines } from "./dry-run.ts";
import { mergeGroups, resolveSerialGroups, type GroupLookup } from "./serial-groups.ts";
import { actorGroups, resolveActors, NO_ACTORS, type ActorPlan } from "../coverage/actors.ts";
import {
  fetchRerunReport,
  requireRerunProfile,
  selectSpecsNeedingRerun,
} from "./rerun-selection.ts";
import { emitGithubAnnotations } from "../report/github-format.ts";
import { ANALYSIS_PROMPT_VERSION } from "../report/prompt.ts";
import { fetchCustomPrompt, fetchTriageUserPrompt, hashTriageUserPrompt } from "../prompts/custom-prompt.ts";
import { buildStepDescriptions, loadEvidenceForSpec, specEvidenceDir } from "../report/evidence.ts";
import { EVIDENCE_DIR_ENV } from "../runtime/evidence-constants.ts";
import type { LiveReportStep, ReportSpecResult, RunReportData } from "../report/schema.ts";
import { currentReportCost } from "../report/run-cost.ts";
import { resolveProfileEnv } from "../cli/options.ts";
import {
  resolveHubContextOrNull,
  resolveHubTransport,
  HubConnectionError,
  type HubContext,
} from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import { resolveProjectOrThrow, ProjectNameError } from "../cli/resolve-project.ts";
import {
  readSpecs,
  resolveSpecsModes,
  type SpecCatalog,
  type SpecWithMode,
} from "./spec-catalog.ts";
import { runLiveSpecs, type RunLiveOptions } from "../cli/run-live.ts";
import { loadProjectConfig, type CoverageConfig } from "../config/project-config.ts";
import { CoverageSession } from "../coverage/session.ts";
import { CoverageInbox, type CoverageInboxMode } from "../coverage/inbox.ts";
import { groupSpecsByTarget, runExternalSpecs, type TargetDispatch } from "./target-dispatch.ts";
import { createIncrementalReport, type ReportEnvelope, type ReportSink } from "./incremental-report.ts";
import { detectBranch, getGitHead } from "../cli/git-branch.ts";
import { needsHubConnection, REPORT_TO_HUB_NEEDS_CONNECTION } from "../cli/open-hub-run.ts";
import { ciProvenance, githubRunId, githubRunUrl } from "./github-run.ts";
import { updateAgentPrompt } from "../cli/update-agent-prompt.ts";
import { collectChangedSpecs } from "../cli/changed-specs.ts";
import { C } from "../cli/colors.ts";
import * as log from "../cli/logger.ts";
import { errMessage, RunUsageError } from "./errors.ts";
import type { RunTeardown } from "../cli/run-teardown.ts";

export { RunUsageError } from "./errors.ts";

// Imported from a dependency-free module so `hub.ts` / `run.ts` can pull these
// constants without importing the whole pipeline (which imports hub-conn and
// would form a startup init-order cycle). Re-exported here for existing
// consumers that still import them from pipeline. See report-constants.ts.
import {
  REPORT_FORMATS,
  DEFAULT_REPORT_DIR,
  EVIDENCE_SUBDIR,
  type ReportFormat,
} from "./report-constants.ts";
export { REPORT_FORMATS, DEFAULT_REPORT_DIR, EVIDENCE_SUBDIR, type ReportFormat };
import { OUTPUT_TAIL_CAP, TailBuffer } from "./output-tail.ts";
export { TailBuffer };

// Passing --config to vitest prevents it from discovering the host's
// vitest.config.ts and inheriting setupFiles/environment/aliases that were
// never meant to apply to ccqa's browser-driving specs.
async function resolveVitestConfig(cwd: string): Promise<string> {
  const userConfig = resolve(cwd, ".ccqa/vitest.config.ts");
  try {
    await access(userConfig);
    return userConfig;
  } catch {
    return bundledVitestConfigPath();
  }
}

type VitestAssertionResult = {
  status: "passed" | "failed" | "skipped" | "pending" | "todo";
  title: string;
  fullName: string;
  duration?: number;
  failureMessages?: string[];
};

type VitestTestResult = {
  name: string;
  status: "passed" | "failed";
  assertionResults: VitestAssertionResult[];
};

type VitestJsonReport = {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  startTime: number;
  success: boolean;
  testResults: VitestTestResult[];
};

export type SpecRunSummary = {
  featureName: string;
  specName: string;
  scriptFile: string;
  report: VitestJsonReport | null;
  exitCode: number;
  /** Tail of the spec's combined vitest output; feeds the drift-report failure analysis. */
  outputTail: string | null;
  /** Directory the spec's step-boundary evidence (PNG + JSON) was written to. */
  evidenceDir: string | null;
};

export interface RunOptions {
  reportDir?: string;
  cwd?: string;
  hubProfile?: string;
  model?: string;
  language?: string;
  reportFormat?: ReportFormat;
  /** Opt-in failure classification. See `--on-fail-explain`. */
  onFailExplain?: boolean;
  /** Diff base for the classification; without it, each spec's own last green. */
  onFailExplainBase?: string;
  /** Which classified failures get a second attempt. See `--on-fail-explain-rerun`. */
  onFailExplainRerun?: ExplainRerunMode;
  /** Cap on how many specs one run may rerun; unset is uncapped. */
  onFailExplainRerunMaxSpecs?: number;
  replaySkipEvidence?: boolean;
  liveStepRetry?: number;
  liveArtifactsDir?: string;
  /** Take only the specs a diff against this ref reaches. */
  onlyAffectedBy?: string;
  /** Take only the specs the hub answers `rerunNeeded` for. */
  onlyHubRerunNeeded?: boolean;
  /** Print the selected specs and stop — no execution, no report, no hub writes. */
  dryRun?: boolean;
  learnHubLivePrompt?: boolean;
  concurrency?: number;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
  /** Opt-in for incremental hub push during the run (see run.ts --report-to-hub help). */
  reportToHub?: boolean;
  /** Measure what each spec actually reached. See `--coverage`. */
  coverage?: boolean;
  /** Where the measurement's events meet: a run-local sink (default) or the hub's inbox. See `--coverage-inbox`. */
  coverageInbox?: CoverageInboxMode;
  project?: string;
  /** Reap agent-browser sessions / flush the report on SIGINT/SIGTERM. See run-teardown.ts. */
  teardown?: RunTeardown;
}

export interface RunPipelineResult {
  /** 0 when every spec passed, 1 when at least one spec failed. Usage errors throw `RunUsageError` instead. */
  exitCode: 0 | 1;
  /** The written report; null only when there were no specs to run. */
  report: RunReportData | null;
  /** Where the report was written; null only when there were no specs to run. */
  reportDir: string | null;
}

/**
 * Resolve the report directory. A report (report.json + evidence) is always
 * written, so `--report-dir` only picks *where* it lands.
 */
function resolveReportDir(reportDir: string | undefined, cwd: string): string {
  return resolve(cwd, reportDir ?? DEFAULT_REPORT_DIR);
}

/**
 * Turn a hub transport failure into a usage error, as a `.catch` so the
 * tuple types of the `Promise.all` it guards survive.
 *
 * Without it the raw `fetch failed` escapes as an unhandled rejection: a stack
 * trace and exit 1, where the user needs "the hub is unreachable" and exit 2.
 * Errors the callers already shaped pass through — they say more than this
 * wrapper could.
 */
function asHubReadError(err: unknown): never {
  if (err instanceof RunUsageError) throw err;
  throw new RunUsageError(`could not read from the hub: ${errMessage(err)}`);
}

/** De-dupe by `featureName/specName`, keeping first-seen order. */
function dedupeSpecs(
  specs: Array<{ featureName: string; specName: string }>,
): Array<{ featureName: string; specName: string }> {
  const seen = new Set<string>();
  const out: Array<{ featureName: string; specName: string }> = [];
  for (const s of specs) {
    const key = `${s.featureName}/${s.specName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * How long a claim lasts before it lapses. Longer than this command's own
 * timeout, so a live run cannot outlive its claim. A job that dies without
 * releasing blocks its specs for this long, which is the price of expiring on
 * read rather than running a reaper.
 */
const LOCK_TTL_SECONDS = 3 * 60 * 60;

/**
 * A serial group's name as a lock key. The `:` keeps it out of reach of spec
 * keys, which are always `feature/spec`.
 */
function resourceKey(name: string): string {
  return `resource:${name}`;
}

/**
 * What the hub let this run take. `deniedResources` is reported separately
 * from the specs because the two denials mean opposite things: a denied spec
 * is one another job is covering, a denied resource is one nobody is.
 */
export interface SpecHold {
  specs: SpecRef[];
  deniedResources: string[];
}

/**
 * Claim what this run is about to execute, and arrange for the claim to be
 * dropped. Resources first, then only the specs that survived them: a spec
 * held but not run reads to every other job as covered when it is not.
 *
 * Best-effort against a hub too old to serve claims — but only when nothing
 * declares a resource. Running a declared spec unprotected trades a wrong
 * verdict for a completed run, which is the wrong way round.
 */
export async function holdSpecs(
  hubCtx: HubContext,
  profile: string,
  specs: SpecRef[],
  needed: GroupLookup,
  teardown: RunTeardown | undefined,
): Promise<SpecHold> {
  const holder = randomUUID();
  const resources = [...new Set(specs.flatMap(needed))];
  const take = async (keys: string[]): Promise<Set<string>> => {
    const res = await hubCtx.hub.acquireLocks(hubCtx.project, { profile }, {
      specs: keys,
      kind: "run",
      holder,
      ttlSeconds: LOCK_TTL_SECONDS,
    });
    return new Set(res.granted);
  };
  const release = async () => {
    try {
      await hubCtx.hub.releaseLocks(hubCtx.project, { profile }, holder);
    } catch (err) {
      log.warn(
        `could not release this run's claims: ${errMessage(err)} — they stay held for up to ` +
          `${LOCK_TTL_SECONDS / 3600}h, so other jobs will skip these specs until then`,
      );
    }
  };

  // Registered before the first call: whatever it takes has to come back even
  // if this run stops between the two.
  teardown?.onFinalize(release);

  let runnable = specs;
  let deniedResources: string[] = [];
  try {
    if (resources.length > 0) {
      const granted = await take(resources.map(resourceKey));
      deniedResources = resources.filter((name) => !granted.has(resourceKey(name)));
      runnable = specs.filter((spec) => needed(spec).every((n) => !deniedResources.includes(n)));
    }
    if (runnable.length > 0) {
      const granted = await take(runnable.map(specKey));
      runnable = runnable.filter((spec) => granted.has(specKey(spec)));
    }
  } catch (err) {
    if (resources.length > 0) {
      throw new RunUsageError(
        `could not claim ${resources.join(", ")} on the hub: ${errMessage(err)} — these specs ` +
          `are in a \`serialGroups\` entry, so running without the claim risks two jobs writing ` +
          `to the same thing. Upgrade the hub, or drop the group to run them unprotected`,
      );
    }
    log.warn(`could not claim specs on the hub, running without exclusion: ${errMessage(err)}`);
    return { specs, deniedResources: [] };
  }

  if (deniedResources.length > 0) {
    // Named, because "held by another job" reads as a spec-level clash.
    log.warn(`another job holds ${deniedResources.join(", ")}; the specs needing them wait`);
  }
  return { specs: runnable, deniedResources };
}

/**
 * Run specs and (optionally) write a unified report. This is the library
 * core behind `ccqa run` — it never calls `process.exit`. Usage errors
 * (bad flag combinations, a broken profile, a failed `git diff`) throw
 * `RunUsageError`; the caller decides what to do with it (the CLI action
 * maps it to `process.exit(2)`).
 */
export async function executeRun(
  targets: string[],
  opts: RunOptions,
): Promise<RunPipelineResult> {
  const filtering = Boolean(opts.onlyAffectedBy || opts.onlyHubRerunNeeded);
  if (filtering && targets.length > 0) {
    throw new RunUsageError("a --only-* filter and an explicit spec target cannot be combined");
  }
  // `--only-hub-rerun-needed` reads per-profile verdicts off the hub instead of a git
  // diff, so its two inputs (a profile, and further down a hub connection)
  // are checked before anything else runs.
  const rerunProfile = opts.onlyHubRerunNeeded === true ? requireRerunProfile(opts.hubProfile) : null;
  // A dry run answers "which specs would run?" and stops. It never resolves a
  // `${VAR}`, classifies a failure or writes a report, so every input that
  // exists only to serve execution — the profile environment, the analysis
  // baseline and its prompts — is skipped, leaving the selection read as the
  // one hub round trip it makes.
  const forExecution = opts.dryRun !== true;

  const cwd = opts.cwd ?? process.cwd();

  // Resolve git coordinates before anything else runs: `head` is recorded in
  // the report unconditionally, and an unresolvable --on-fail-explain-base
  // must fail here — a fast usage error — not after minutes of spec
  // execution. `base` stays null when analysis wasn't requested, which is
  // what downstream reads as "classification off". Without an explicit base
  // each spec diffs against its own last green, which needs the hub
  // connection, so that ledger fetch happens below once hubCtx exists.
  const wantsLastGreen = opts.onFailExplain === true && opts.onFailExplainBase === undefined;
  // A rerun revises a label, so it needs one to revise: without
  // --on-fail-explain nothing is classified and a second attempt would settle
  // nothing. Warned about below, with the other flags this run cannot honour.
  const rerunMode: ExplainRerunMode =
    opts.onFailExplain === true ? (opts.onFailExplainRerun ?? "never") : "never";
  const [head, fixedBase] = await Promise.all([
    getGitHead(cwd),
    forExecution && opts.onFailExplain && opts.onFailExplainBase !== undefined
      ? resolveAnalysisBase(opts.onFailExplainBase, "--on-fail-explain-base", cwd)
      : null,
  ]);
  const git: GitContext = {
    head,
    base: wantsLastGreen ? { ref: LAST_GREEN, sha: null, source: "last-green" } : fixedBase,
  };
  let diffProvider: DiffProvider | null = null;
  if (fixedBase) {
    diffProvider = createDiffProvider({ resolveBase: async () => ({ ok: true, base: fixedBase }), cwd });
    log.meta("analysis-base", `${fixedBase.ref} (${fixedBase.sha.slice(0, 12)}, ${fixedBase.source})`);
  }

  // Merge the profile (fetched from the hub) or the default .env (when no
  // --profile) into process.env before any spec work — every `${VAR}` path
  // (vitest replay, live agent-browser) bottoms out at process.env, so this
  // single injection covers both modes. A broken profile is a usage error
  // (bad flag / hub misconfiguration), not a run failure, so it maps to
  // RunUsageError like the other early-exit checks. Project resolution is
  // only needed to scope the hub lookup, so it's skipped entirely when no
  // --profile is given, and the whole block is skipped on a dry run, which
  // executes nothing and so resolves no `${VAR}`.
  if (forExecution) {
    try {
      if (opts.hubProfile !== undefined) {
        await resolveProfileEnv({
          profile: opts.hubProfile,
          project: resolveProjectOrThrow(opts.project, cwd),
          cwd,
          hubUrl: opts.hubUrl,
          hubToken: opts.hubToken,
          hubHeader: opts.hubHeader,
        });
      } else {
        await resolveProfileEnv({ profile: undefined, project: "", cwd });
      }
    } catch (err) {
      if (err instanceof RunUsageError) throw err;
      if (err instanceof ProjectNameError) throw new RunUsageError(err.message);
      if (err instanceof HubConnectionError || err instanceof HubApiError) {
        throw new RunUsageError(err.message);
      }
      throw new RunUsageError(`failed to load profile "${opts.hubProfile}": ${errMessage(err)}`);
    }
  }

  // Resolve the hub context for the failure-analysis prompts (best-effort: an
  // unresolvable project or missing hub connection just means no custom
  // prompt, never a run-stopping error — unlike the profile resolution
  // above, which does throw RunUsageError). The project is resolved again here
  // rather than being threaded down from the profile block — that block is
  // skipped entirely without --profile, and on a dry run.
  const hubCtx: HubContext | null = resolveHubContextOrNull({
    hubUrl: opts.hubUrl,
    hubToken: opts.hubToken,
    hubHeader: opts.hubHeader,
    project: opts.project,
    cwd,
  });

  // last-green baselines live on the hub, so the ledger fetch has to wait for
  // hubCtx — but it still happens before any spec executes, keeping the
  // fail-fast contract of the fixed-ref modes above. Requiring a hub here is
  // deliberate: the flag opted into hub-backed baselines, so a missing
  // connection is a usage error, not a degrade-to-no-analysis.
  if (wantsLastGreen && hubCtx == null) {
    throw new RunUsageError(
      "--on-fail-explain needs a hub connection for the per-spec last-green baselines (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN), or an explicit --on-fail-explain-base <ref>",
    );
  }
  const ledgerHub = wantsLastGreen ? hubCtx : null;
  // Same contract as last-green: the flag opted into a hub-held baseline, so a
  // missing connection is a usage error, not a degrade-to-run-everything.
  // A real run reaches this having already required a hub for `--profile`;
  // a dry run skips that, so this is where it finds out.
  if (rerunProfile !== null && hubCtx == null) {
    throw new RunUsageError(needsHubConnection("--only-hub-rerun-needed"));
  }
  // Checked here rather than where the push happens: a run that cannot publish
  // its result should not spend the run first. Same for the prompt refresh.
  if (opts.reportToHub && hubCtx == null) {
    throw new RunUsageError(REPORT_TO_HUB_NEEDS_CONNECTION);
  }
  if (opts.learnHubLivePrompt && hubCtx == null) {
    throw new RunUsageError(needsHubConnection("--learn-hub-live-prompt"));
  }
  // Same contract as --report-to-hub: the flag opted into delivering the
  // measurement to the hub, so a missing connection is a usage error checked
  // before anything is spent. The client is built here for the same reason.
  let coverageInbox: CoverageInbox | undefined;
  if (opts.coverageInbox === "hub") {
    if (opts.coverage !== true) {
      throw new RunUsageError(
        "--coverage-inbox hub does nothing without --coverage — there is no measurement to stream",
      );
    }
    const transport = resolveHubTransport(opts);
    if (transport === null) {
      throw new RunUsageError(needsHubConnection("--coverage-inbox hub"));
    }
    let project: string;
    try {
      project = resolveProjectOrThrow(opts.project, cwd);
    } catch (err) {
      throw new RunUsageError(errMessage(err));
    }
    coverageInbox = new CoverageInbox({ ...transport, project });
  }

  // Everything this run needs from the hub, in one batch of independent round
  // trips: the two failure-analysis prompt layers (`triage.user` guidance and
  // the learned custom prompt), the last-green ledger, the re-run verdicts,
  // the deploy head and the drift ledger.
  //
  // A prompt that was never stored resolves to null; a hub that cannot be
  // reached throws. Those are different answers, and the second one stops the
  // run — guidance the project configured but ccqa could not read would change
  // what Claude does with nobody told.
  const [customPrompt, triageUserPrompt, ledgerEntries, rerunReport, fetchedDeployHead] = await Promise.all([
    forExecution ? fetchCustomPrompt(hubCtx) : null,
    forExecution ? fetchTriageUserPrompt(hubCtx) : null,
    forExecution && ledgerHub ? fetchLastGreenLedger(ledgerHub, opts.hubProfile, cwd) : null,
    rerunProfile !== null && hubCtx ? fetchRerunReport(hubCtx, rerunProfile) : null,
    // Only reached with no checkout to assert from. Skipped when the re-run
    // report is being fetched too: that response already carries the profile's
    // deploy head, so asking twice would be a second round trip for one value
    // — and two reads that a deploy between them could make disagree.
    forExecution && hubCtx && opts.hubProfile && rerunProfile === null
      ? tryDeployHeadSha(hubCtx, opts.hubProfile)
      : null,
  ]).catch(asHubReadError);
  // Asserted, so the hub pins it instead of re-reading its log head when the
  // run finishes — which is what a deploy landing mid-run would otherwise make
  // ambiguous. It is the log head rather than `git.head` on purpose: a
  // checkout that is not a recorded deploy has no position, so asserting it
  // would leave the run permanently unplaceable instead of merely imprecise.
  const deployedSha = rerunReport?.deployHead.sha ?? fetchedDeployHead;
  if (ledgerEntries) {
    diffProvider = createDiffProvider({
      resolveBase: createLastGreenResolver(ledgerEntries, cwd),
      cwd,
    });
  }
  const triageUserPromptHash = triageUserPrompt ? hashTriageUserPrompt(triageUserPrompt) : null;

  // Resolve report dir against `cwd` (not process.cwd()) so JSON and evidence
  // PNGs share a directory even when --cwd points at a subpackage. A report is
  // always written now; --report only picks where. Resolved up front so the
  // analysis deps below can carry it (they locate a spec's run artifacts).
  const reportDir = resolveReportDir(opts.reportDir, cwd);

  // Everything the failure analysis needs, resolved once and shared by every
  // execution path that classifies (deterministic + external targets; the live
  // path builds its own from RunLiveOptions). The Claude-credential probe can
  // hit the macOS Keychain, so it happens here rather than per phase — and only
  // when a baseline was requested, since that is what turns analysis on.
  //
  // Blocks are read once for the whole run: the analysis pass, its prompt
  // projection and the deterministic evidence captions all consume this map.
  const parsedBlocks = await loadAllBlocks(cwd);
  const analysisDeps: FailureAnalysisDeps = {
    diffProvider,
    auth: diffProvider ? driftAuthAvailable() : { ok: false, reason: "skipped by flags" },
    cwd,
    reportDir,
    // So the prompt can check an `include:` step's target still exists —
    // mirrors what the audit is given (src/prompts/drift.ts).
    blocks: projectAvailableBlocks(parsedBlocks),
    parsedBlocks,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    customPrompt,
    triageUserPrompt,
  };

  // No targets means "all specs"; resolveSpecTargets(undefined) enumerates them.
  // Multiple targets may overlap (e.g. a feature plus one of its specs), so dedupe.
  const enumerateAll = () => listAllSpecsWithSpecFile(cwd);
  const resolved = await Promise.all(
    (targets.length ? targets : [undefined]).map((t) => resolveSpecTargets(t, enumerateAll, cwd)),
  );
  let specs = dedupeSpecs(resolved.flat());

  if (filtering) {
    const before = specs.length;
    let inProgress = 0;
    let unknownToHub = 0;
    let assumedReached = 0;
    let assumedReachedReasons: string[] = [];
    // Each filter narrows what the previous one left, so passing both means
    // "stale AND affected". The hub verdicts run first because they are
    // already fetched: whatever they drop is one less spec for the selector
    // below to hold against the diff.
    if (rerunReport) {
      const selection = selectSpecsNeedingRerun(specs, rerunReport);
      specs = selection.selected;
      inProgress = selection.excludedInProgress;
      unknownToHub = selection.excludedUnknownToHub;
      assumedReached = selection.excludedAssumedReached;
      assumedReachedReasons = selection.excludedAssumedReachedReasons;
      log.meta(
        "stale-base",
        `deploy ${rerunReport.deployHead.sha.slice(0, 12)} (profile ${rerunReport.profile})`,
      );
      log.meta("stale-states", selection.summary);
    }
    if (opts.onlyAffectedBy) {
      specs = (
        await collectChangedSpecs(specs, {
          cwd,
          base: opts.onlyAffectedBy,
          // Selection intersects the diff with measured coverage from the
          // hub; without a connection undecided specs degrade to unknown
          // and run.
          hub: hubCtx,
        })
      ).specs;
    }
    log.meta(
      "selected",
      `${specs.length} of ${before} spec${before === 1 ? "" : "s"}`,
    );
    // Selecting nothing is a real answer only when every spec was answered.
    // Otherwise "0 to run, exit 0" reads as "all good", which is the one
    // outcome this whole selection path exists to prevent.
    if (specs.length === 0 && inProgress > 0) {
      // The two named causes get a hint that closes the actual hole; the
      // generic hint below only applies to what neither one explains — a
      // held spec, or an ordinary "never audited yet".
      if (unknownToHub > 0) {
        log.hint(
          `${unknownToHub} spec(s) were excluded because the hub's perspectives document has ` +
            `never heard of them; run \`ccqa perspectives\` to register them`,
        );
      }
      if (assumedReached > 0) {
        log.hint(
          `${assumedReached} spec(s) were excluded because the audit ran at a commit the deploy ` +
            `log cannot place (${assumedReachedReasons.join(", ")}); re-running ` +
            `\`ccqa audit --only-hub-audit-needed\` at the same commit will not clear it — record ` +
            `the deploy (\`ccqa hub deploy record\`) so the log can place it, or select with ` +
            `--only-affected-by <ref> to make progress meanwhile`,
        );
      }
      const explained = unknownToHub + assumedReached;
      if (explained < inProgress) {
        log.hint(
          `${inProgress - explained} spec(s) were excluded because the audit has not answered ` +
            `for the deployed commit yet; run \`ccqa audit --only-hub-audit-needed --report-to-hub\` ` +
            `first`,
        );
      }
      throw new RunUsageError(
        "nothing was selected and no spec was cleared to run: exiting non-zero rather than " +
          "reporting a green run that verified nothing",
      );
    }
  }

  if (specs.length === 0) {
    log.warn("no specs to run");
    return { exitCode: 0, report: null, reportDir: null };
  }

  // Take the specs before executing them, so a second cycle starting while
  // this one is still going skips what is already being run rather than
  // driving the same browser flow twice. Released on the way out, including on
  // SIGINT/SIGTERM; a hard kill is covered by the hold's own expiry.
  const catalog = await readSpecs(specs, cwd);
  const projectConfig = await loadProjectConfig(cwd);
  // Only under --coverage: an identity's turn has to be exclusive for the
  // attribution to mean anything, but that is a cost the measurement asks for
  // and an ordinary run must not pay.
  const actors =
    opts.coverage === true && forExecution
      ? await resolveActors(projectConfig.coverage?.actors ?? {}, cwd)
      : NO_ACTORS;
  const resources = mergeGroups(
    await resolveSerialGroups(projectConfig.serialGroups, cwd),
    actorGroups(actors),
  );

  const declared = [...new Set(specs.flatMap(resources))];
  if (declared.length > 0) log.meta("serial groups", declared.join(", "));

  // Specs dropped because another job holds their serial group. They still get
  // a report row: this run was asked to cover them and did not, and a silent
  // drop reports a green run that verified less than it selected.
  let waitingOnGroup: Array<{ spec: SpecRef; groups: string[] }> = [];

  if (hubCtx && rerunProfile !== null) {
    const held = await holdSpecs(hubCtx, rerunProfile, specs, resources, opts.teardown);
    // Two different facts, and holdSpecs already named the resources — so
    // count only the specs another job is actually running.
    waitingOnGroup = specs.flatMap((spec) => {
      const groups = resources(spec).filter((n) => held.deniedResources.includes(n));
      return groups.length > 0 ? [{ spec, groups }] : [];
    });
    const claimed = specs.length - held.specs.length - waitingOnGroup.length;
    if (claimed > 0) log.warn(`${claimed} spec(s) another job is already running`);
    specs = held.specs;
    if (specs.length === 0) {
      // A spec another job holds is one that job is covering; a resource it
      // holds leaves these specs uncovered this cycle, so the two cannot share
      // an exit code.
      if (held.deniedResources.length > 0) {
        throw new RunUsageError(
          `every selected spec waits on a shared resource another job holds ` +
            `(${held.deniedResources.join(", ")}): exiting non-zero rather than reporting a ` +
            `green run that verified nothing`,
        );
      }
      log.warn("every selected spec is claimed by another job");
      return { exitCode: 0, report: null, reportDir: null };
    }
  }

  // Split specs by generation target: agent-browser specs keep the det/live
  // paths below; external-target specs run through their plugin runner; specs
  // that can't run at all become report rows (skipped / failed) instead of
  // silently dropping out of the run.
  let dispatch: TargetDispatch;
  try {
    dispatch = groupSpecsByTarget(specs, catalog, projectConfig);
    for (const { spec, groups } of waitingOnGroup) {
      dispatch.skipped.push({
        ...spec,
        title: catalog.get(specKey(spec))?.spec?.title ?? null,
        reason: `waiting on ${groups.join(", ")}, held by another job`,
        targetId: null,
      });
    }
  } catch (err) {
    // A present-but-broken .ccqa/config.yaml is a usage error, like a bad flag.
    throw new RunUsageError(errMessage(err));
  }

  // Agent-browser det specs run first under vitest, then external targets,
  // then live ones via Claude; results merge into a single report.json.
  const withMode = resolveSpecsModes(dispatch.agentBrowser, catalog);
  const detSpecs = withMode.filter((s) => s.mode === "deterministic");
  const liveSpecs = withMode.filter((s) => s.mode === "live");
  log.meta(
    "modes",
    `${detSpecs.length} deterministic / ${liveSpecs.length} live`,
  );
  if (dispatch.external.length > 0) {
    log.meta(
      "external",
      dispatch.external.map((g) => `${g.targetId} ${g.specs.length}`).join(" / "),
    );
  }

  // Not on a dry run: it resolves no `${VAR}`, so every value coverage reads —
  // the origins, the identities — would be empty and fail validation on a run
  // that was never going to measure anything.
  const coverage =
    opts.coverage && forExecution
      ? await startCoverage(cwd, projectConfig.coverage, actors, dispatch, opts.teardown, coverageInbox)
      : undefined;

  // Warn when a mode-scoped flag can't apply, rather than silently ignoring
  // it. These flags only affect agent-browser specs of the given mode —
  // external-target specs run via their own runCommand and never honor them.
  if (liveSpecs.length === 0) {
    const why = "it only applies to agent-browser 'mode: live' specs, and this run has none";
    if (typeof opts.liveStepRetry === "number" && opts.liveStepRetry > 0) log.warn(`--live-step-retry is ignored: ${why}`);
    if (opts.liveArtifactsDir) log.warn(`--live-artifacts-dir is ignored: ${why}`);
    if (opts.learnHubLivePrompt) log.warn(`--learn-live-prompt is ignored: ${why}`);
  } else if (opts.liveArtifactsDir && liveSpecs.length > 1) {
    // A single --out dir can't hold multiple specs' artifacts without them
    // overwriting each other (worse under --concurrency), so it only applies
    // to single-spec runs, matching the flag's help text.
    log.warn("--out is ignored when running multiple live specs");
  }
  if (opts.onFailExplainRerun !== undefined && rerunMode === "never" && opts.onFailExplainRerun !== "never") {
    log.warn(
      "--on-fail-explain-rerun is ignored: without --on-fail-explain nothing is classified, so a second attempt would settle nothing",
    );
  }
  if (detSpecs.length === 0 && opts.replaySkipEvidence === true) {
    log.warn(
      "--no-evidence is ignored: it only applies to agent-browser 'mode: deterministic' specs, and this run has none",
    );
  }
  log.blank();

  // Everything above this point is selection and local inspection; nothing has
  // been executed and nothing has been written yet, which is exactly where a
  // dry run stops.
  if (opts.dryRun) {
    for (const line of formatDryRunLines(withMode, dispatch, resources)) log.emitRaw(line + "\n");
    log.blank();
    log.info("dry run: nothing was executed and no report was written");
    return { exitCode: 0, report: null, reportDir: null };
  }

  const det = await runDeterministicSpecs(detSpecs, opts, cwd, reportDir, resources);

  // Incremental hub push: when --report-to-hub is set and a hub is configured,
  // open a "running" run up front so each finished spec can be PATCHed to the
  // hub as it lands (real-time reflection of a long run). The report dir always
  // exists, so the only thing that can still block the push is a missing hub
  // connection. Best-effort throughout — a hub failure never fails the local
  // run (test execution is the point). The open is not retried: a dropped
  // response could leave a second orphan running run, so on failure we degrade
  // to local-report-only.
  let hubRunId: string | null = null;
  let hubSink: ReportSink | undefined;
  // Flips the process exit code below (see overallExitCode) when this run's
  // hub publish is known broken: the first PATCH ever failed, or the closing
  // seal PATCH failed. Either leaves the hub's record of this run wrong (not
  // merely missing), which must not exit clean just because the local tests
  // passed. A successful seal PATCH clears it — it resends every row, so it
  // heals an earlier mid-run failure into a complete, correct, terminal run.
  let hubPublishBroken = false;
  if (hubCtx != null && opts.reportToHub) {
    try {
      const branch = await detectBranch(cwd);
      const opened = await hubCtx.hub.openRun({
        project: hubCtx.project,
        ...(branch ? { branch } : {}),
        ...(opts.hubProfile ? { profile: opts.hubProfile } : {}),
        ...(git.head ? { gitHead: git.head } : {}),
        // Captured before the first spec. Left to itself the hub stamps its
        // deploy-log head when this call lands — after the deterministic
        // phase — so a deploy during that phase would become the baseline.
        ...(deployedSha ? { deployedSha } : {}),
        ...ciProvenance(),
        kind: "run",
      });
      hubRunId = opened.id;
      log.info(`hub: incremental run opened (${opened.id})`);
      // The coverage stream and the hub's run records are separate id spaces;
      // the link is what lets a resolved measurement point at its run page.
      await coverage?.linkHubRun(opened.id);
      const runId = opened.id;
      // `openRun` above carries no row/label data, so an old hub accepts it
      // even when it can't accept this release's report shape — there is no
      // hub-side release number to probe for that ahead of time (the health
      // endpoint reports an API shape number, not a ccqa version; see hub-conn
      // and health.ts, which this doesn't edit). The first PATCH is therefore
      // the earliest available signal: version skew (an older hub rejecting
      // this release's row shape) fails identically on every row, so failing
      // loud on the first one — rather than warning it away — is what
      // surfaces it.
      let hubPatchEverSucceeded = false;
      hubSink = {
        onUpsert: async (row) => {
          try {
            const evidence = await readRowFilesBase64(row, reportDir);
            // Cost rides along per row so a run still in flight shows what it
            // has spent so far, not just what it cost once it ended.
            await hubCtx.hub.patchRun(runId, { rows: [row], evidence, reportMeta: { cost: currentReportCost() } });
            hubPatchEverSucceeded = true;
          } catch (err) {
            if (!hubPatchEverSucceeded) {
              hubPublishBroken = true;
              log.error(
                `hub: incremental push failed for ${row.feature}/${row.spec}, and no patch to this run has succeeded yet ` +
                  `(likely hub/CLI version skew — upgrade the hub): ${errMessage(err)}`,
              );
            } else {
              log.warn(`hub: incremental push failed for ${row.feature}/${row.spec}: ${errMessage(err)}`);
            }
          }
        },
      };
    } catch (err) {
      // Before any spec runs, so nothing is wasted. A job that asked to publish
      // and cannot reach the hub has not done what it was told — going green
      // with a local-only report is the failure this refuses to hide.
      throw new RunUsageError(
        `--report-to-hub: could not open a run on the hub (${errMessage(err)})`,
      );
    }
  }

  // Incremental report: external-target and live specs upsert their rows and
  // flush report.json as they finish, so an interrupt leaves a valid partial
  // report instead of nothing. The git coordinates were resolved up front, so
  // even an interrupted partial report carries the real head/base — the final
  // writeUnifiedReport rewrites the whole file with the same envelope.
  //
  // Scope note: only the external and live phases upsert incrementally.
  // Deterministic rows are built later (analyzeDeterministicSummaries) and only
  // reach the report / hub via the final write + seal patch, so an interrupt
  // before that point omits already-finished det specs from the partial report.
  // Det specs are fast and run first, so this window is small; full det
  // incrementalism is deferred.
  const incrementalReport = createIncrementalReport(
    reportDir,
    buildReportEnvelope({
      git,
      customPromptVersion: customPrompt?.customPromptVersion ?? null,
      triageUserPromptHash,
      deployedSha,
      opts,
      coverage,
    }),
    hubSink,
    currentReportCost,
  );
  // On SIGINT/SIGTERM, flush whatever rows finished so an interrupt leaves a
  // valid partial report. Skipped once the run completes normally: the final
  // writeUnifiedReport below is authoritative (it holds the deterministic
  // rows the incremental writer never sees), so re-flushing the incremental
  // writer afterwards would clobber it — the teardown finalizer also runs on
  // the normal exit path (run.ts).
  let completedNormally = false;
  opts.teardown?.onFinalize(async () => {
    // On the normal exit path the final writeUnifiedReport (below) is
    // authoritative and already closed the hub run, so skip both.
    if (completedNormally) return;
    await incrementalReport.flush();
    // Flip the hub's still-"running" run to a terminal state so an interrupt
    // doesn't leave it dangling (the startup GC would otherwise have to reap
    // it). The rows already patched stay; we just finalize. finalStatus is
    // "failed" — the run was interrupted, not a clean pass. Best-effort.
    if (hubRunId && hubCtx) {
      try {
        await hubCtx.hub.patchRun(hubRunId, {
          rows: incrementalReport.rows(),
          done: true,
          finalStatus: "failed",
          // The per-row sink above already refreshed cost as each spec landed,
          // so this is not that. It is the spend of the spec that was killed
          // mid-flight, which no completed row carries and which nothing else
          // would ever send.
          reportMeta: { cost: currentReportCost() },
        });
      } catch (err) {
        log.warn(`hub: could not finalize interrupted run ${hubRunId}: ${errMessage(err)}`);
      }
    }
  });

  // External-target specs run between the det and live phases. Rows (including
  // the skipped / target-resolution-failure stubs) are upserted into the
  // incremental report as each spec finishes, so an interrupt and
  // --report-to-hub treat them like live rows. Their failure analysis happens
  // in the tail phase below, with the deterministic one.
  const externalRows = await runExternalSpecs(dispatch, {
    cwd,
    reportDir,
    concurrency: opts.concurrency ?? 1,
    resources,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    report: incrementalReport,
    ...(coverage ? { coverage } : {}),
    ...(opts.teardown ? { teardown: opts.teardown } : {}),
  });


  const liveOpts: RunLiveOptions = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.liveArtifactsDir && liveSpecs.length === 1 ? { out: opts.liveArtifactsDir } : {}),
    cwd,
    reportDir,
    ...(typeof opts.liveStepRetry === "number" ? { retry: opts.liveStepRetry } : {}),
    concurrency: opts.concurrency ?? 1,
    resources,
    ...(opts.hubProfile ? { profile: opts.hubProfile } : {}),
    ...(coverage ? { coverage } : {}),
    diffProvider,
    hubContext: hubCtx,
    customPrompt,
    triageUserPrompt,
    ...(opts.teardown ? { teardown: opts.teardown } : {}),
    report: incrementalReport,
  };
  const live = await runLiveSpecs(liveSpecs, liveOpts);

  // After every phase, not after the external one: live specs are measured too,
  // and reporting between the two would call the server half missing on a run
  // whose only measured specs had not started yet. In hub-inbox mode nothing
  // on this side saw the stream, so the hub's resolve is fetched and read out
  // instead — otherwise an empty measurement is invisible until selection
  // degrades to unknown days later.
  if (coverage && !coverage.streamsToHub) {
    reportCoverageHealth(coverage, [...externalRows, ...live.reportResults]);
  } else if (coverage && hubCtx != null) {
    await reportStreamedCoverageHealth(coverage, hubCtx);
  }

  let overallExitCode: 0 | 1 = det.exitCode !== 0 ? 1 : 0;
  if (live.failedCount > 0) overallExitCode = 1;
  // Failed external rows (command exit != 0, missing manifest, unresolved
  // target) fail the run; skipped rows don't.
  if (externalRows.some((r) => r.status === "failed")) overallExitCode = 1;

  const customPromptVersion = customPrompt?.customPromptVersion ?? null;
  let report: RunReportData;
  {
    // One analysis phase for the whole run, opened once every spec has
    // executed, so the classifier's banner is printed once, in one place. The
    // live path classifies inline (its evidence is the transcript it just
    // produced), so its rows arrive analyzed and only det + external rows
    // pass through here.
    const detFailed = det.summaries.filter(failedSpec);
    const analysisRun = beginFailureAnalysis(
      [
        ...detFailed.map((s) => ({ featureName: s.featureName, specName: s.specName })),
        ...externalRows
          .filter(needsAnalysis)
          .map((r) => ({ featureName: r.feature, specName: r.spec })),
      ],
      analysisDeps,
    );
    const detResults = await analyzeDeterministicSummaries(
      det.summaries,
      cwd,
      reportDir,
      analysisRun,
    );
    const analyzedExternalRows = await analyzeExternalRows(externalRows, analysisRun);
    // Second attempts, after the classification they revise. `overallExitCode`
    // is already fixed above and the rows keep their status, so a spec whose
    // rerun passed stays a failure — the rerun explains it, it does not undo it.
    const results = await rerunExplainedFailures(
      [...detResults, ...analyzedExternalRows, ...live.reportResults],
      {
        mode: rerunMode,
        maxSpecs: opts.onFailExplainRerunMaxSpecs ?? null,
        execute: createRerunExecutor({ detSpecs, liveSpecs, dispatch, liveOpts, opts, cwd, resources }),
      },
    );
    report = await writeUnifiedReport({
      reportDir,
      // In hub-inbox mode every row carries no coverage on purpose — the
      // stream is the record — so the missing-coverage explanations would all
      // be untrue.
      results: coverage && !coverage.streamsToHub ? results.map(explainMissingCoverage) : results,
      git,
      customPromptVersion,
      triageUserPromptHash,
      deployedSha,
      opts,
      coverage,
    });
    // The authoritative report is on disk; a later teardown flush (normal exit
    // or a signal arriving now) must not overwrite it with the provisional one.
    completedNormally = true;

    // Reconcile the hub run: re-send every final row (upsert is idempotent, so
    // this heals any mid-run patch that failed), stamp the real git metadata
    // the provisional per-spec patches lacked, and flip running → terminal.
    // The local report is complete either way, but a failure here is NOT a
    // warning: it leaves the hub's run permanently "running", which
    // misrepresents this run's outcome rather than merely omitting it — see
    // hubPublishBroken below, which turns this into a non-zero exit.
    if (hubRunId) {
      const finalStatus = overallExitCode === 0 ? "passed" : "failed";
      const reportMeta = buildReportEnvelope({
        git,
        customPromptVersion,
        triageUserPromptHash,
        deployedSha,
        opts,
        coverage,
      });
      // Deterministic rows are the only ones that never passed through the
      // mid-run sink (external/live rows already pushed their files with their
      // own patches), so their evidence PNGs must ride along on this seal PATCH
      // or the hub UI's det step frames 404. Collect files only for rows that
      // weren't streamed, under one shared byte budget.
      //
      // Note: "streamed" here means "the local report attempted an upsert",
      // not "the hub accepted the PATCH" — incrementalReport.rows() doesn't
      // know which mid-run patches failed. A row whose mid-run PATCH failed is
      // still excluded here, so this seal PATCH heals its JSON (rows: below
      // resends everything) but not its evidence PNGs. Pre-existing gap, not
      // fixed here.
      const streamedKeys = new Set(incrementalReport.rows().map((r) => `${r.feature}/${r.spec}`));
      const sealRows = report.results.filter((r) => !streamedKeys.has(`${r.feature}/${r.spec}`));
      const evidence = await readRowsFilesBase64(sealRows, reportDir);
      try {
        await hubCtx!.hub.patchRun(hubRunId, {
          rows: report.results,
          evidence,
          done: true,
          finalStatus,
          reportMeta,
        });
        // Clears any earlier mid-run PATCH failure: this seal PATCH resends
        // EVERY row (`report.results`), so once it lands the hub holds a
        // complete, correct, terminal run — a run that healed must not fail CI.
        hubPublishBroken = false;
        log.info(`hub: incremental run finalized (${hubRunId}, ${finalStatus})`);
      } catch (err) {
        hubPublishBroken = true;
        log.error(`hub: could not finalize incremental run ${hubRunId}, which is left "running" on the hub: ${errMessage(err)}`);
      }
    }
  }

  // A run whose hub publish is known broken must not exit clean: the local
  // tests may have passed, but --report-to-hub asked for a published result
  // and the hub does not have a correct one (see hubPublishBroken above).
  if (hubPublishBroken) overallExitCode = 1;

  // "ignored without any 'mode: live' spec" already warned upfront alongside
  // the other live-only flags.
  if (opts.learnHubLivePrompt && liveSpecs.length > 0) {
    log.blank();
    await updateAgentPrompt({
      kind: "live",
      flag: "--learn-live-prompt",
      runSummary: buildLiveRunSummary(live.reportResults),
      hubContext: hubCtx,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.language ? { language: opts.language } : {}),
    });
  }

  return { exitCode: overallExitCode, report, reportDir };
}

/**
 * Starts the run's coverage measurement before any spec runs: the sink has to
 * be listening before the first request reaches the application, and the set
 * of spec ids it will accept is only known once dispatch has resolved. With
 * an `inbox`, nothing binds — the run streams its events to the hub instead.
 */
async function startCoverage(
  cwd: string,
  config: CoverageConfig | undefined,
  actors: ActorPlan,
  dispatch: TargetDispatch,
  teardown: RunTeardown | undefined,
  inbox: CoverageInbox | undefined,
): Promise<CoverageSession> {
  if (config === undefined) {
    throw new RunUsageError(
      "--coverage needs a `coverage:` block in .ccqa/config.yaml whose " +
        "`instrumentedOrigins` names the origins the spec cookie may be attached to",
    );
  }
  let session: CoverageSession;
  try {
    session = await CoverageSession.start({
      runId: buildRunId(),
      cwd,
      config,
      actors,
      specs: dispatch.external.flatMap((g) => g.specs),
      ...(inbox ? { inbox } : {}),
    });
  } catch (err) {
    throw new RunUsageError(`could not start coverage collection: ${errMessage(err)}`);
  }
  if (inbox !== undefined) {
    // No sink URL to print: nothing listens on this machine (ADR-0022).
    log.meta("coverage", `streaming to hub inbox → ${session.origins.join(", ")}`);
  } else {
    log.meta("coverage", `sink ${session.sinkUrl} → ${session.origins.join(", ")}`);
  }
  const unmeasured = dispatch.external.filter((g) => g.browserCoverage.browser === "none").length;
  if (unmeasured > 0) {
    log.warn(
      `${unmeasured} target(s) declare no browser to measure; their specs are reported ` +
        `as unmeasured rather than as reaching nothing`,
    );
  }
  teardown?.onFinalize(() => session.close());
  return session;
}

/**
 * A run that measured coverage still leaves rows without any — a spec on a
 * target that declares no browser, or one that never executed. Saying why keeps
 * the reader from reading a blank as "this spec reached nothing".
 */
function explainMissingCoverage(row: ReportSpecResult): ReportSpecResult {
  if (row.coverage !== undefined || row.coverageUnavailable !== undefined) return row;
  return {
    ...row,
    // Failure is not the discriminator: a spec that ran and failed an assertion
    // still ran, and telling its reader it never executed is a plain untruth.
    // What is left here is a target the measurement does not cover.
    coverageUnavailable:
      row.status === "skipped"
        ? "the spec did not execute"
        : "this target is not measured by --coverage yet",
  };
}

/**
 * The hub-inbox counterpart of `reportCoverageHealth`: ask the hub to resolve
 * this run's slice of the stream and read the answer out into the run log.
 * Best-effort — the measurement already left as events, so a failed read-out
 * loses visibility, never data. Application pushes may still land for
 * `GRACE_MS` after the last window closed, so the counts here are a floor.
 */
async function reportStreamedCoverageHealth(
  coverage: CoverageSession,
  hubCtx: HubContext,
): Promise<void> {
  let resolved;
  try {
    resolved = (await hubCtx.hub.getCoverage(hubCtx.project, { runId: coverage.streamRunId }))
      .resolved;
  } catch (error) {
    log.warn(`coverage: could not read this run's resolve from the hub (${errMessage(error)})`);
    return;
  }
  if (resolved == null) {
    log.warn(
      "coverage: the hub resolved nothing for this run — its events never reached the stream, " +
        "so every spec's measured reach is absent",
    );
    return;
  }
  const measured = resolved.specs.filter((spec) => spec.files.length > 0);
  const empty = resolved.specs.filter((spec) => spec.files.length === 0);
  log.meta(
    "coverage",
    `stream resolve: ${measured.length}/${resolved.specs.length} spec(s) measured files` +
      (resolved.boot.length > 0 ? `; ${resolved.boot.length} file(s) reached only at boot` : ""),
  );
  for (const spec of measured) {
    const actors = Object.entries(spec.actorEvents)
      .map(([key, count]) => `${key}: ${count} event(s)`)
      .join(", ");
    log.meta("coverage", `  ${spec.specId}: ${spec.files.length} file(s)${actors ? ` (${actors})` : ""}`);
  }
  if (empty.length > 0) {
    log.warn(
      `coverage: ${empty.length} spec(s) measured no files — their reach stays unknown to ` +
        `selection: ${empty.map((spec) => spec.specId).join(", ")}`,
    );
  }
  const h = resolved.health;
  if (!h.heardFromApplication) {
    log.warn(
      "coverage: no instrumented application process pushed to the stream — only the browser " +
        "half was measured. The server needs ccqa-tools and CCQA_COVERAGE_ENDPOINT pointed at " +
        "the hub's inbox",
    );
  } else if (h.pushesDuringRun === 0) {
    log.warn(
      "coverage: the stream holds application pushes, but none arrived while this run was " +
        "measuring — check CCQA_COVERAGE_ENDPOINT on the application",
    );
  } else if (h.attributedSpecs === 0) {
    log.warn(
      `coverage: ${h.pushesDuringRun} application push(es) arrived during the run, but none was ` +
        "attributed to a spec — the spec cookie is not reaching the application, so every " +
        "spec's server-side reach is zero for that reason rather than because the server ran " +
        "nothing",
    );
  }
  const trouble: string[] = [];
  if (h.rejectedPushes > 0) trouble.push(`rejected=${h.rejectedPushes}`);
  if (h.droppedPushes > 0) trouble.push(`dropped=${h.droppedPushes}`);
  if (h.unmappedActorEvents > 0) trouble.push(`unmapped-actor-events=${h.unmappedActorEvents}`);
  if (h.uninstrumentedProcesses > 0) trouble.push(`uninstrumented-processes=${h.uninstrumentedProcesses}`);
  const outside = Object.entries(h.outsideWindowEvents);
  if (outside.length > 0) {
    trouble.push(`outside-window=${outside.map(([key, count]) => `${key}:${count}`).join(",")}`);
  }
  if (trouble.length > 0) log.warn(`coverage: stream health flags — ${trouble.join(" ")}`);
}

/** Everything the measurement could not place; silence here reads as "never reached". */
function reportCoverageHealth(coverage: CoverageSession, rows: readonly ReportSpecResult[]): void {
  if (!coverage.heardFromApplication()) {
    log.warn(
      "no instrumented application process reported — only the browser half was measured. The " +
        "server needs ccqa-tools and CCQA_COVERAGE_ENDPOINT pointed at this run's sink",
    );
  }
  // An application reports its boot set whether or not a spec cookie ever
  // arrives, so the check above passes while every spec is credited with
  // reaching no server code at all — and no gap counter moves, because the
  // requests were never attributed to a spec in the first place.
  const measured = rows.filter((row) => row.coverage !== undefined).length;
  if (measured > 0 && coverage.heardFromApplication() && coverage.attributedSpecs() === 0) {
    log.warn(
      "instrumented application processes reported, but no spec was attributed to them — the " +
        "spec cookie is not reaching the application, so every spec's server-side reach is zero " +
        "for that reason rather than because the server ran nothing. Check coverage.instrumentedOrigins " +
        "covers every origin the spec's requests go to, and that a server which is not " +
        "node:http-based installs the middleware itself",
    );
  }
  const boot = coverage.boot();
  if (boot.length > 0) {
    log.meta("coverage", `${boot.length} file(s) reached only at module load, attributed to no spec`);
  }
  // Loud on its own, and never expressed as a file count: one of these hides
  // every file its process ran, and "1 file" reads as a rounding error.
  const blind = coverage.uninstrumentedProcesses();
  if (blind > 0) {
    log.warn(
      `${blind} application process(es) instrumented nothing at all — every file they ran is ` +
        `missing from this run, not just some. Load hooks need node 22.15+ (23.5+ on 23.x); ` +
        `bundled code needs the build plugin instead`,
    );
  }
  // Something other than this run drove an identity the run had claimed, so
  // what it reached is missing from a spec whose row reads as complete.
  for (const [key, count] of coverage.outsideWindowEvents()) {
    log.warn(
      `${count} event(s) from ${key} arrived outside this run's turns — another job or a person ` +
        `used that identity while it was being measured, and what they triggered is attributed to nobody`,
    );
  }
  const unmapped = coverage.unmappedActorEvents();
  if (unmapped > 0) {
    log.meta(
      "coverage",
      `${unmapped} event(s) from identities this project does not declare, attributed to no spec`,
    );
  }
  const rejected = coverage.rejectedPushes();
  if (rejected > 0) {
    log.warn(`${rejected} coverage push(es) named a spec id this run never issued — dropped`);
  }
  const malformed = coverage.malformedPushes();
  if (malformed > 0) {
    log.warn(
      `${malformed} coverage push(es) could not be read — the application's ccqa-tools and ` +
        `this CLI disagree on the wire format`,
    );
  }
}

export function buildLiveRunSummary(results: readonly ReportSpecResult[]): string {
  const sections: string[] = [];
  for (const r of results) {
    if (!r.liveRun) continue;
    const head = `## ${r.feature}/${r.spec} — ${r.status}`;
    const steps = r.liveRun.steps.map(liveStepSummaryLine).join("\n");
    sections.push(`${head}\n${steps}`);
  }
  return sections.length === 0 ? "(no live runs executed)" : sections.join("\n\n");
}

/**
 * One step's line for the learning summary. Leads with the step's
 * `instruction` (its intent) so the learner can abstract "this was a login" /
 * "this was a static-banner check" and turn the shortcut into a rule keyed on
 * the *kind* of screen/operation rather than this spec's step id. The step id
 * is demoted to a trailing tag — it has no cross-spec meaning, so it must not
 * be the thing the learner anchors on. Churned steps additionally carry their
 * `expected` and the commands that worked (with per-run snapshot refs masked).
 */
function liveStepSummaryLine(s: LiveReportStep): string {
  const turns = s.cost.numTurns;
  const cost = s.cost.totalCostUsd;
  const metrics = [
    turns !== null ? `${turns} turns` : null,
    `${(s.durationMs / 1000).toFixed(1)}s`,
    cost !== null ? `$${cost.toFixed(3)}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(", ");
  const head = `- [${s.status}] ${oneLineSummary(s.instruction)} (${metrics}, ${s.stepId}): ${oneLineSummary(s.reasoning)}`;
  // Only surface commands for steps that took real exploration — a step that
  // passed in 1-2 turns has no shortcut worth learning.
  const worthShortcut = (turns ?? 0) >= LIVE_SHORTCUT_TURN_THRESHOLD;
  const commands = s.commands ?? [];
  if (!worthShortcut || commands.length === 0) return head;
  const cmdList = commands.map((c) => oneLineSummary(maskRunLocalTokens(c))).join(" ; ");
  return `${head}\n  expected: ${oneLineSummary(s.expected)}\n  commands (snapshot refs masked — re-derive from each element's role/label/text): ${cmdList}`;
}

/**
 * Strip run-local tokens from a command string before it enters the learning
 * input. Two kinds are noise a cross-spec rule must never carry forward:
 *   - snapshot refs (`@e4`, `@e12`) — renumbered every run, so a copied ref
 *     points nowhere or misclicks next run; masked to `@ref` to force the
 *     learner to describe the element by its stable identity instead.
 *   - the per-run `--session <id>` flag — a fresh timestamped id each run, pure
 *     noise that only tempts the learner to paste a dead session name.
 */
function maskRunLocalTokens(command: string): string {
  return command.replace(/@e\d+/g, "@ref").replace(/\s--session\s+\S+/g, "");
}

/**
 * A step at or above this many turns did enough exploring that its command
 * trail is worth learning a shortcut from. Below it, the step is already fast.
 */
const LIVE_SHORTCUT_TURN_THRESHOLD = 3;

function oneLineSummary(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? flat.slice(0, 240) + "…" : flat || "(no reason given)";
}

type RunDeterministicResult = {
  summaries: SpecRunSummary[];
  exitCode: number;
};

/**
 * Run pre-filtered deterministic specs under vitest. Empty input is a no-op.
 * Captures step-boundary evidence under `<reportDir>/evidence/<feature>/<spec>/`
 * when enabled.
 */
async function runDeterministicSpecs(
  specs: readonly SpecWithMode[],
  opts: RunOptions,
  cwd: string,
  reportDirAbs: string,
  resources: GroupLookup,
): Promise<RunDeterministicResult> {
  if (specs.length === 0) return { summaries: [], exitCode: 0 };

  const tmpDir = await mkdtemp(join(tmpdir(), "ccqa-run-"));
  const vitestConfig = await resolveVitestConfig(cwd);
  // The report's failure excerpts come from this tail, and a report is always
  // written, so it is kept whether or not classification runs.
  const captureOutput = true;
  // Evidence lives under the report dir for the standalone CI artifact; the
  // per-spec dir is composed via specEvidenceDir at capture time.
  const captureEvidence = opts.replaySkipEvidence !== true;
  // Parallel vitest streams interleave illegibly, so above 1 worker each spec
  // buffers its narration + vitest output (via log.withBuffer) and flushes one
  // labelled block on completion. At 1 worker output streams live, as before.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const ctx: DeterministicSpecContext = {
    cwd,
    tmpDir,
    vitestConfig,
    captureOutput,
    reportDir: reportDirAbs,
    captureEvidence,
  };

  try {
    const settled = await runPool(
      specs,
      concurrency,
      (spec, i) =>
        log.withBuffer(`${spec.featureName}/${spec.specName}`, concurrency > 1, () =>
          runOneDeterministicSpec(spec, i, ctx),
        ),
      { resources },
    );
    // runPool preserves input order, so summaries stay stable for the report.
    const summaries = settled.filter((s): s is SpecRunSummary => s !== null);
    printSummary(summaries);
    const exitCode = summaries.reduce((acc, s) => (s.exitCode !== 0 ? s.exitCode : acc), 0);
    return { summaries, exitCode };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

interface DeterministicSpecContext {
  cwd: string;
  tmpDir: string;
  vitestConfig: string;
  captureOutput: boolean;
  reportDir: string;
  captureEvidence: boolean;
}

/**
 * Run one spec under vitest. Returns null when the spec has no recorded
 * test.spec.ts (skipped). All output goes through the logger, so under a
 * `log.withBuffer` scope it's captured and flushed as one labelled block.
 */
async function runOneDeterministicSpec(
  spec: { featureName: string; specName: string },
  index: number,
  ctx: DeterministicSpecContext,
): Promise<SpecRunSummary | null> {
  const { featureName, specName } = spec;
  const scriptFile = await getTestScript(featureName, specName, ctx.cwd);
  if (!scriptFile) {
    log.warn(`${featureName}/${specName}: no test.spec.ts found`);
    log.hint("run 'ccqa record <feature>/<spec>' to record it, or set 'mode: live' in spec.yaml");
    return null;
  }

  log.run(`${featureName}/${specName}`);
  log.meta("test", scriptFile);
  // Unique-per-spec run id, mirroring the live path (run-live.ts): generated
  // once, logged, and handed to the spec as CCQA_RUN_ID. A spec that embeds
  // `${CCQA_RUN_ID}` (e.g. in created-content names) needs this set; otherwise
  // the ref resolves to "" and the run collides with a prior one.
  const runId = buildRunId();
  log.meta("runId", runId);
  log.blank();

  const reportFile = join(ctx.tmpDir, `report-${index}.json`);
  const evidenceDir = ctx.captureEvidence ? specEvidenceDir(ctx.reportDir, featureName, specName) : null;
  if (evidenceDir) {
    await rm(evidenceDir, { recursive: true, force: true });
    await mkdir(evidenceDir, { recursive: true });
  }
  const specEnv: NodeJS.ProcessEnv = { ...process.env, CCQA_RUN_ID: runId };
  if (evidenceDir) specEnv[EVIDENCE_DIR_ENV] = evidenceDir;
  const proc = spawnVitestStreaming(
    [
      "run",
      "--config",
      ctx.vitestConfig,
      scriptFile,
      "--reporter=json",
      `--outputFile.json=${reportFile}`,
    ],
    {
      cwd: ctx.cwd,
      env: specEnv,
    },
  );

  // vitest's stdout/stderr aren't logger lines; route them through emitRaw so
  // they land in the same buffer as the narration above under a buffered scope.
  const sink = { write: log.emitRaw };
  const tail = ctx.captureOutput ? new TailBuffer(OUTPUT_TAIL_CAP) : null;
  await Promise.all([
    streamFiltered(proc.stdout, sink, tail),
    streamFiltered(proc.stderr, sink, tail),
  ]);
  const specExitCode = await proc.exited;
  log.blank();

  const report = await readReport(reportFile);
  return {
    featureName,
    specName,
    scriptFile,
    report,
    exitCode: specExitCode,
    outputTail: tail ? tail.toString() : null,
    evidenceDir,
  };
}

export function failedSpec(s: SpecRunSummary): boolean {
  if (s.exitCode !== 0) return true;
  return (s.report?.numFailedTests ?? 0) > 0;
}

/**
 * Build ReportSpecResult[] for a set of vitest summaries, running the failure
 * analysis for the failed ones (see failure-analysis.ts, which external-target
 * specs share). Degrades — never throws — when Claude auth or the git diff
 * aren't available. Caller writes report.json.
 */
async function analyzeDeterministicSummaries(
  summaries: readonly SpecRunSummary[],
  cwd: string,
  reportDir: string,
  { pass, deps }: FailureAnalysisRun,
): Promise<ReportSpecResult[]> {
  const results: ReportSpecResult[] = [];
  for (const s of summaries) {
    const assertions = collectAssertions(s);
    // Read spec.yaml once and reuse for both evidence captions and the
    // failure-analysis prompt.
    const specYaml = await tryReadSpecFile(s.featureName, s.specName, cwd);
    const parsedSpec = tryParseTestSpec(specYaml);
    const stepDescriptions = buildStepDescriptions(parsedSpec, deps.parsedBlocks);
    const evidence = await loadEvidenceForSpec(s.evidenceDir, reportDir, stepDescriptions);
    const base = {
      feature: s.featureName,
      spec: s.specName,
      title: parsedSpec?.title ?? null,
      target: AGENT_BROWSER_TARGET,
      testCounts: s.report
        ? {
            total: s.report.numTotalTests,
            passed: s.report.numPassedTests,
            failed: s.report.numFailedTests,
          }
        : null,
      durationMs: assertions
        ? assertions.reduce((sum, a) => sum + (a.durationMs ?? 0), 0)
        : null,
      assertions,
      evidence,
    };

    if (!failedSpec(s)) {
      results.push({
        ...base,
        status: "passed",
        analysis: null,
        analysisSkipped: null,
        failureLogExcerpt: null,
        diffExcerpt: null,
        specYaml: null,
        liveRun: null,
      });
      continue;
    }

    const failureLog = buildFailureLog(s);
    const fields = await pass.analyze({
      featureName: s.featureName,
      specName: s.specName,
      readScript: () => readScriptSafe(s.scriptFile),
      failureLog,
      specYaml,
      parsedSpec,
      target: AGENT_BROWSER_TARGET,
    });

    // Spell out the failed-row keys in the historical order (analysis,
    // analysisSkipped, analysisBase?, failureLogExcerpt,
    // diffExcerpt, specYaml, liveRun) rather than spreading `fields` — a
    // spread would reorder `diffExcerpt` and change report.json byte-for-byte,
    // which the e2e goldens and cross-version diffs care about.
    results.push({
      ...base,
      status: "failed",
      analysis: fields.analysis,
      analysisSkipped: fields.analysisSkipped,
      ...(fields.analysisBase ? { analysisBase: fields.analysisBase } : {}),
      ...(fields.customPromptVersion ? { customPromptVersion: fields.customPromptVersion } : {}),
      failureLogExcerpt: failureLog.length > 0 ? failureLog : null,
      diffExcerpt: fields.diffExcerpt,
      specYaml,
      liveRun: null,
    });
  }

  return results;
}

/**
 * How `--on-fail-explain-rerun` re-executes one spec: on the same path that
 * just ran it, with the same inputs, so the second attempt answers the same
 * question the first did.
 *
 * Everything it writes goes to a throwaway report directory. The failed run's
 * screenshots and artifacts are the record of what happened, and a rerun that
 * shares their paths would overwrite them with a different attempt's — the
 * external runner and the live adapter both recreate a spec's directories.
 * Nothing here upserts a row or classifies: the attempt is evidence about the
 * run's row, not a row of its own.
 */
function createRerunExecutor(ctx: {
  detSpecs: readonly SpecWithMode[];
  liveSpecs: readonly SpecWithMode[];
  dispatch: TargetDispatch;
  liveOpts: RunLiveOptions;
  opts: RunOptions;
  cwd: string;
  resources: GroupLookup;
}): (ref: SpecRef) => Promise<RerunOutcome> {
  const detKeys = new Set(ctx.detSpecs.map(specKey));
  const liveKeys = new Set(ctx.liveSpecs.map(specKey));
  return async (ref) => {
    const key = specKey(ref);
    const scratch = await mkdtemp(join(tmpdir(), "ccqa-rerun-"));
    try {
      if (detKeys.has(key)) {
        const summary = await runOneDeterministicSpec(ref, 0, {
          cwd: ctx.cwd,
          tmpDir: scratch,
          vitestConfig: await resolveVitestConfig(ctx.cwd),
          captureOutput: false,
          reportDir: scratch,
          captureEvidence: false,
        });
        return summary !== null && !failedSpec(summary) ? "passed" : "failed";
      }
      if (liveKeys.has(key)) {
        // Dropping the incremental writer keeps the attempt out of report.json
        // and the hub; dropping the diff provider keeps it out of the
        // classifier, which has already said what it has to say about this spec.
        const { report: _streamed, ...liveOpts } = ctx.liveOpts;
        const run = await runLiveSpecs([ref], {
          ...liveOpts,
          reportDir: scratch,
          diffProvider: null,
          concurrency: 1,
        });
        return run.failedCount > 0 ? "failed" : "passed";
      }
      const group = ctx.dispatch.external.find((g) => g.specs.some((s) => specKey(s) === key));
      if (group === undefined) throw new Error(`${key} has no execution path to re-run`);
      const [row] = await group.runner.run([ref], {
        cwd: ctx.cwd,
        reportDir: scratch,
        concurrency: 1,
        resources: ctx.resources,
        ...(ctx.opts.model ? { model: ctx.opts.model } : {}),
        ...(ctx.opts.language ? { language: ctx.opts.language } : {}),
        targetId: group.targetId,
        targetConfig: group.targetConfig,
        stepEvidence: group.stepEvidence,
        browserCoverage: group.browserCoverage,
        onSpecComplete: async () => {},
      });
      return row?.status === "passed" ? "passed" : "failed";
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

/**
 * Build the report envelope — every `RunReportData` field except `results`.
 * Extracted so the incremental writer (which flushes report.json after each
 * spec) and the final batch write share one source of truth for these fields.
 * Key order matches the historical `writeUnifiedReport` object literal so the
 * final report.json stays byte-identical (existing e2e goldens compare it).
 */
function buildReportEnvelope(args: {
  git: GitContext;
  customPromptVersion: string | null;
  triageUserPromptHash: string | null;
  deployedSha: string | null;
  opts: RunOptions;
  /** The run's coverage session; carries the enumerated universe when set. */
  coverage?: CoverageSession | null;
}): ReportEnvelope {
  const { git, customPromptVersion, triageUserPromptHash, deployedSha, opts, coverage } = args;
  const runUrl = githubRunUrl();
  return {
    schemaVersion: 1,
    kind: "run",
    createdAt: new Date().toISOString(),
    runId: githubRunId(),
    // Omitted (not null) outside CI so report.json stays byte-identical to
    // before this field — same convention as triageUserPromptHash below.
    ...(runUrl !== null ? { runUrl } : {}),
    git: {
      head: git.head,
      base: git.base?.ref ?? null,
      // Omitted (not null) when analysis is off, so the envelope keeps its
      // historical shape — same contract as triageUserPromptHash below. In
      // last-green mode `sha` is null (per-spec, see analysisBase) but the
      // keys are present: analysis WAS requested.
      ...(git.base ? { baseSha: git.base.sha, baseSource: git.base.source } : {}),
    },
    model: opts.model ?? null,
    language: opts.language ?? null,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    customPromptVersion,
    // Omitted (not null) when inactive, so the envelope keeps its historical
    // shape — see the schema comment on triageUserPromptHash.
    ...(triageUserPromptHash !== null ? { triageUserPromptHash } : {}),
    // Same omission rule. Read back by `ccqa hub push` to assert the baseline
    // the run actually exercised — see tryDeployHeadSha.
    ...(deployedSha !== null ? { deployedSha } : {}),
    // Always present (unlike the fields above), so the incremental writer can
    // refresh it on each flush without moving the key ahead of `results`.
    cost: currentReportCost(),
    // The denominator the hub's file tree is drawn from. Omitted (not null)
    // without --coverage or without coverage.include — see the schema comment.
    ...(coverage?.universe ? { coverageUniverse: coverage.universe } : {}),
  };
}

/** Write the unified JSON (+ optional GitHub-annotation) report for one run. Returns the report data. */
async function writeUnifiedReport(args: {
  reportDir: string;
  results: ReportSpecResult[];
  git: GitContext;
  customPromptVersion: string | null;
  triageUserPromptHash: string | null;
  deployedSha: string | null;
  opts: RunOptions;
  coverage?: CoverageSession | null;
}): Promise<RunReportData> {
  const { reportDir, results, git, customPromptVersion, triageUserPromptHash, deployedSha, opts, coverage } = args;
  const data: RunReportData = {
    ...buildReportEnvelope({ git, customPromptVersion, triageUserPromptHash, deployedSha, opts, coverage }),
    results,
  };

  await mkdir(reportDir, { recursive: true });

  // report.json is the report: the machine-readable form `ccqa hub push`
  // uploads and any CI tooling consumes. There is no standalone HTML report —
  // the hub UI renders results from report.json + the evidence PNGs. `--format
  // github` additionally streams GitHub Actions annotations to stdout.
  const jsonPath = join(reportDir, "report.json");
  await writeFile(jsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  log.info(`run report (json) written to ${jsonPath}`);
  if (opts.reportFormat === "github") {
    for (const line of emitGithubAnnotations(data)) log.emitRaw(line + "\n");
  }

  return data;
}

/**
 * Raw-byte budget for the files inlined in one incremental `PATCH`. Base64
 * inflates by ~4/3 and the rows ride in the same body, so this keeps the
 * request under the hub's default push cap (`serve --max-push-mb`, 32 MB).
 * Artifacts over the budget are omitted from the *hub* push only (named in a
 * warning); they stay in the local report dir and in `ccqa hub push` bundles.
 */
const PATCH_FILES_RAW_BUDGET = 20 * 1024 * 1024;

/** Accumulator threaded across rows so a multi-row push shares one byte budget. */
interface RowFilesAcc {
  out: Record<string, string>;
  totalBytes: number;
  omitted: string[];
}

/**
 * Add one row's file assets to `acc` as `{ reportDir-relative posix path →
 * base64 }`. Every kind of screenshot a row can carry has to be collected here,
 * or `--report-to-hub` — the way CI publishes — silently ships a report whose
 * images 404 on the hub: a live row's per-step PNGs
 * (`liveRun.steps[].beforePng/afterPng`), a script-driven row's step evidence
 * (`evidence[].pngPath` / `beforePngPath`, written by agent-browser replays and
 * by external targets' `ccqa/step-evidence` calls alike), and an external row's
 * `artifacts`. A file that can't be read (capture miss) is skipped, not fatal.
 *
 * Order matters under the byte budget: step evidence is the report's primary
 * visual, so it is offered before the generic artifacts — a multi-megabyte
 * Playwright trace must not crowd out the screenshots.
 */
async function accumulateRowFiles(
  row: ReportSpecResult,
  reportDir: string,
  acc: RowFilesAcc,
): Promise<void> {
  const add = async (relPath: string, sizeGuard: boolean): Promise<void> => {
    if (acc.out[relPath] !== undefined) return;
    let bytes: Buffer;
    try {
      bytes = await readFile(join(reportDir, relPath));
    } catch {
      return; // best-effort: a missing file just isn't pushed with this patch.
    }
    if (sizeGuard && acc.totalBytes + bytes.length > PATCH_FILES_RAW_BUDGET) {
      acc.omitted.push(relPath);
      return;
    }
    acc.out[relPath] = bytes.toString("base64");
    acc.totalBytes += bytes.length;
  };
  for (const step of row.liveRun?.steps ?? []) {
    for (const relPath of [step.beforePng, step.afterPng]) {
      if (relPath) await add(relPath, false);
    }
  }
  for (const e of row.evidence ?? []) {
    for (const relPath of [e.beforePngPath, e.pngPath]) {
      if (relPath) await add(relPath, true);
    }
  }
  for (const artifact of row.artifacts ?? []) await add(artifact.path, true);
}

/** One row's file assets for a mid-run per-row `PATCH` (the incremental sink). */
export async function readRowFilesBase64(
  row: ReportSpecResult,
  reportDir: string,
): Promise<Record<string, string>> {
  const acc: RowFilesAcc = { out: {}, totalBytes: 0, omitted: [] };
  await accumulateRowFiles(row, reportDir, acc);
  if (acc.omitted.length > 0) {
    log.warn(
      `hub: ${acc.omitted.length} file(s) of ${row.feature}/${row.spec} omitted from the ` +
        `incremental push (over the push size budget); they remain in the local report dir: ` +
        acc.omitted.join(", "),
    );
  }
  return acc.out;
}

/**
 * File assets for several rows under one shared byte budget, for the finalizing
 * seal `PATCH`. Deterministic rows never go through the mid-run sink (they are
 * built only at the end), so this is the ONLY chance to upload their evidence
 * PNGs — without it the hub UI's det step frames 404.
 */
export async function readRowsFilesBase64(
  rows: readonly ReportSpecResult[],
  reportDir: string,
): Promise<Record<string, string>> {
  const acc: RowFilesAcc = { out: {}, totalBytes: 0, omitted: [] };
  for (const row of rows) await accumulateRowFiles(row, reportDir, acc);
  if (acc.omitted.length > 0) {
    log.warn(
      `hub: ${acc.omitted.length} file(s) omitted from the finalizing push (over the push size ` +
        `budget); they remain in the local report dir: ${acc.omitted.join(", ")}`,
    );
  }
  return acc.out;
}

function collectAssertions(s: SpecRunSummary): ReportSpecResult["assertions"] {
  if (!s.report) return null;
  const out: NonNullable<ReportSpecResult["assertions"]> = [];
  for (const file of s.report.testResults) {
    for (const a of file.assertionResults) {
      out.push({
        name: a.fullName,
        status: a.status === "passed" || a.status === "failed" ? a.status : "skipped",
        durationMs: a.duration ?? null,
      });
    }
  }
  return out;
}

/**
 * Compose the failure log for the analysis prompt + report. JSON-reporter
 * vitest writes almost nothing to stdout, so structured failureMessages
 * come first and the raw output tail is appended as secondary context.
 */
export function buildFailureLog(s: SpecRunSummary): string {
  const parts: string[] = [];
  if (s.report) {
    for (const file of s.report.testResults) {
      for (const a of file.assertionResults) {
        if (a.status !== "failed") continue;
        parts.push(`✖ ${a.fullName}`);
        for (const m of a.failureMessages ?? []) parts.push(m);
      }
    }
  }
  const tail = s.outputTail?.trim();
  if (tail) {
    parts.push("--- vitest output (tail) ---");
    parts.push(tail);
  }
  return parts.join("\n");
}

async function readScriptSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readReport(path: string): Promise<VitestJsonReport | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as VitestJsonReport;
  } catch {
    return null;
  }
}

function printSummary(summaries: SpecRunSummary[]): void {
  log.emitRaw(
    `\n${C.cyan}${C.bold}──────── ccqa summary ────────${C.reset}\n\n`,
  );

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const s of summaries) {
    const header = `${C.bold}${s.featureName}/${s.specName}${C.reset}`;
    if (!s.report) {
      const ok = s.exitCode === 0;
      const icon = ok ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
      log.emitRaw(`${icon} ${header} ${C.dim}(no report)${C.reset}\n`);
      continue;
    }

    totalTests += s.report.numTotalTests;
    totalPassed += s.report.numPassedTests;
    totalFailed += s.report.numFailedTests;
    totalSkipped += s.report.numPendingTests;

    const ok = s.report.success;
    const icon = ok ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
    const countColor = ok ? C.green : C.red;
    log.emitRaw(
      `${icon} ${header}  ${countColor}${s.report.numPassedTests}/${s.report.numTotalTests}${C.reset} ${C.dim}passed${C.reset}\n`,
    );

    for (const file of s.report.testResults) {
      for (const a of file.assertionResults) {
        const aIcon = assertionIcon(a.status);
        const dur = a.duration != null ? ` ${C.gray}${formatDuration(a.duration)}${C.reset}` : "";
        log.emitRaw(`    ${aIcon} ${a.fullName}${dur}\n`);
        if (a.status === "failed" && a.failureMessages?.length) {
          for (const msg of a.failureMessages) {
            const firstLine = msg.split("\n")[0] ?? msg;
            log.emitRaw(`        ${C.red}${firstLine}${C.reset}\n`);
          }
        }
      }
    }
  }

  const specsPassed = summaries.filter((s) => s.exitCode === 0).length;
  const specsFailed = summaries.filter((s) => s.exitCode !== 0).length;
  log.emitRaw("\n");
  log.emitRaw(
    `  ${C.bold}Specs${C.reset}   ${summaries.length}  ` +
      `(${C.green}${specsPassed} passed${C.reset}, ${specsFailed > 0 ? C.red : C.dim}${specsFailed} failed${C.reset})\n`,
  );
  log.emitRaw(
    `  ${C.bold}Tests${C.reset}   ${totalTests}  ` +
      `(${C.green}${totalPassed} passed${C.reset}, ${totalFailed > 0 ? C.red : C.dim}${totalFailed} failed${C.reset}, ${C.yellow}${totalSkipped} skipped${C.reset})\n`,
  );
  log.emitRaw("\n");
}

function assertionIcon(status: VitestAssertionResult["status"]): string {
  switch (status) {
    case "passed":
      return `${C.green}✔${C.reset}`;
    case "failed":
      return `${C.red}✖${C.reset}`;
    case "skipped":
    case "pending":
    case "todo":
      return `${C.yellow}◌${C.reset}`;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const NOISE_LINE_PATTERNS = [/^JSON report written to /];

async function streamFiltered(
  source: Readable,
  sink: { write(chunk: string): void },
  capture?: TailBuffer | null,
): Promise<void> {
  source.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of source) {
    buffer += chunk as string;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!NOISE_LINE_PATTERNS.some((p) => p.test(line))) {
        sink.write(line + "\n");
        capture?.append(line + "\n");
      }
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0 && !NOISE_LINE_PATTERNS.some((p) => p.test(buffer))) {
    sink.write(buffer);
    capture?.append(buffer);
  }
}
