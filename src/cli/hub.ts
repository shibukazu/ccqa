import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HubClient } from "../hub-client/index.ts";
import { RunReportDataSchema } from "../report/schema.ts";
import { packDirToTarGz } from "../hub/core/tar.ts";
import {
  DEFAULT_SESSION_PROFILE,
  loadStorageState,
  sessionFilePath,
} from "../runtime/session-state.ts";
import { SessionNameSchema } from "../spec/yaml-schema.ts";
import { isPromptName, PROMPT_NAMES, type PromptName, resolvePromptLocalPath } from "../prompts/prompt-names.ts";
import { DEFAULT_REPORT_DIR } from "../run/report-constants.ts";
import { ciProvenance, githubRunUrl } from "../run/github-run.ts";
import { deployHeadSha } from "../run/deploy-head.ts";
import { errMessage } from "../run/errors.ts";
import { capDeployPaths } from "./deploy-paths.ts";
import { getChangedFilesBetween, type ChangedFile } from "../drift/affected.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadCoverageEdges } from "../select/coverage-edges.ts";
import { loadSpecInventory } from "../select/inventory.ts";
import type { DeploySelection } from "../hub/contract/schema.ts";
import { MAX_TOUCHED_BY } from "../hub/core/deploy-log.ts";
import { parseSpecPath, specKey } from "../store/index.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { sessionCaptureCommand } from "./session.ts";
import { resolveProject } from "./resolve-project.ts";
import { hubTokenOption, hubUrlOption, resolveHubClient, withHubErrors, type HubConnOptions } from "./hub-conn.ts";
import { detectBranch } from "./git-branch.ts";
import * as log from "./logger.ts";
import { readCostFileTotal } from "./cost-line.ts";

/**
 * `ccqa hub` — the client side of the ccqa hub (a results/secret control
 * plane; see docs/hub.md). `push` uploads a finished `ccqa run` report;
 * `session`/`var`/`prompt` manage what's stored on the hub, which `ccqa run`
 * and `ccqa record` fetch directly at run time with a single
 * `CCQA_HUB_TOKEN` secret — there is no local restore step. All subcommands
 * talk to the hub over the same public REST API (docs/hub-api.md) via
 * `ccqa/hub-client`.
 */

const profileOption = [
  "--profile <name>",
  "Profile bucket the session/variable belongs to. Defaults to 'default'.",
] as const;
const projectOption = [
  "--project <name>",
  "Project the session/variable belongs to on the hub. Defaults to the current directory's name.",
] as const;
const cwdOption = [
  "--cwd <path>",
  "Directory the default --project name is derived from (defaults to the current directory).",
] as const;

interface ScopeOptions extends HubConnOptions {
  project?: string;
  profile?: string;
  cwd?: string;
}

/**
 * The hub base URL from flags / env (trailing slashes trimmed), or exit 2.
 * Kept as a thin wrapper around `resolveHubClient` so the URL-only lookup
 * (used standalone in `pushCommand`) preserves its exact error message.
 */
function resolveBaseUrl(opts: HubConnOptions): string {
  const baseUrl = opts.hubUrl ?? process.env.CCQA_HUB_URL;
  if (!baseUrl) {
    log.error("hub URL is required (--hub-url or CCQA_HUB_URL)");
    process.exit(2);
  }
  return baseUrl.replace(/\/+$/, "");
}

/** Resolve the hub client from flags / env, or exit 2 with a clear message. */
function connect(opts: HubConnOptions): HubClient {
  const client = resolveHubClient(opts);
  if (client) return client;
  // Reproduce the exact URL-then-token error precedence/messages the old
  // inline implementation had.
  resolveBaseUrl(opts);
  log.error("hub token is required (--hub-token or CCQA_HUB_TOKEN)");
  process.exit(2);
}

/**
 * The canonical "feature/spec" key for a CLI argument. Hub records are stored
 * and looked up under exactly this form, so an alias accepted here but kept
 * verbatim would silently never match.
 */
function requireSpecId(rawSpecId: string): string {
  try {
    const parsed = parseSpecPath(rawSpecId);
    return `${parsed.featureName}/${parsed.specName}`;
  } catch (err) {
    log.error(errMessage(err));
    process.exit(2);
  }
}

function validateSessionName(name: string): string {
  const parsed = SessionNameSchema.safeParse(name);
  if (!parsed.success) {
    log.error(`invalid session name "${name}": ${parsed.error.issues[0]?.message ?? "bad name"}`);
    process.exit(2);
  }
  return parsed.data;
}

/** Read all of stdin as a string. Used for `var set` when --value is omitted (better for secrets). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ── sessions ────────────────────────────────────────────────────────────

const sessionPush = new Command("push")
  .description(
    "Upload a locally-saved browser session (.ccqa/sessions/<profile>/<name>.json) to the hub, " +
      "so it's available for `ccqa run` to fetch at run time. Encrypted at rest on the hub.",
  )
  .argument("<name>", "Session name to upload (resolves to .ccqa/sessions/<profile>/<name>.json)")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...profileOption)
  .option("--cwd <path>", "Project root containing .ccqa/ (defaults to the current directory).")
  .action(withHubErrors(async (rawName: string, opts: ScopeOptions) => {
    const name = validateSessionName(rawName);
    const cwd = resolveCwd(opts.cwd);
    const project = resolveProject(opts);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const path = sessionFilePath(name, opts.profile, cwd);

    let state: unknown;
    try {
      state = await loadStorageState(path);
    } catch (err) {
      log.error(`could not read session "${name}" at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      log.hint(`create it first with:  ccqa hub session capture ${name}${opts.profile ? ` --profile ${opts.profile}` : ""}`);
      process.exit(2);
    }

    const hub = connect(opts);
    await hub.putSession(project, profile, name, state);
    log.header("hub session push", name);
    log.meta("project", project);
    log.meta("profile", profile);
    log.info(`uploaded session "${name}" to the hub (encrypted at rest)`);
  }));

const sessionLs = new Command("ls")
  .description("List sessions stored on the hub for a project/profile (names + last-updated times). `ls` shows metadata only.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...profileOption)
  .option(...cwdOption)
  .action(withHubErrors(async (opts: ScopeOptions) => {
    const project = resolveProject(opts);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const hub = connect(opts);
    const sessions = await hub.listSessions(project, profile);
    log.header("hub sessions", `${project}/${profile}`);
    if (sessions.length === 0) {
      log.info("no sessions stored on the hub for this project/profile");
      return;
    }
    for (const s of sessions) log.meta(s.name, `updated ${s.updatedAt}`);
  }));

const sessionRm = new Command("rm")
  .description("Delete a session from the hub.")
  .argument("<name>", "Session name to delete")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...profileOption)
  .option(...cwdOption)
  .action(withHubErrors(async (rawName: string, opts: ScopeOptions) => {
    const name = validateSessionName(rawName);
    const project = resolveProject(opts);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const hub = connect(opts);
    await hub.deleteSession(project, profile, name);
    log.header("hub session rm", name);
    log.info(`deleted session "${name}" from the hub`);
  }));

const sessionCommand = new Command("session")
  .description("Manage browser sessions stored on the hub (fetched automatically by `ccqa run` / `ccqa record` at run time).")
  .addCommand(sessionCaptureCommand)
  .addCommand(sessionPush)
  .addCommand(sessionLs)
  .addCommand(sessionRm);

// ── variables ───────────────────────────────────────────────────────────

const varSet = new Command("set")
  .description(
    "Store an environment variable on the hub, fetched at run time by `ccqa run` / `ccqa record`. " +
      "Use --sensitive to hide the value from `ls` output (it is still returned in full to the run).",
  )
  .argument("<name>", "Variable name (e.g. BASE_URL)")
  .option("--value <value>", "Variable value. Omit to read the value from stdin (better for secrets).")
  .option("--sensitive", "Hide the value in `ls` output. Any token holder can still read it via the run-time fetch.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...profileOption)
  .option(...cwdOption)
  .action(withHubErrors(async (name: string, opts: ScopeOptions & { value?: string; sensitive?: boolean }) => {
    const project = resolveProject(opts);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const value = opts.value ?? (await readStdin()).trim();
    if (value.length === 0) {
      log.error("no value provided (pass --value <value> or pipe it on stdin)");
      process.exit(2);
    }
    const hub = connect(opts);
    await hub.putVariable(project, profile, name, { value, sensitive: opts.sensitive ?? false });
    log.header("hub var set", name);
    log.meta("project", project);
    log.meta("profile", profile);
    log.meta("sensitive", String(opts.sensitive ?? false));
    log.info(`stored variable "${name}" on the hub`);
  }));

const varLs = new Command("ls")
  .description("List variables stored on the hub for a project/profile. Non-sensitive values are shown inline; sensitive ones are hidden here but still fetched at run time by `ccqa run` / `ccqa record`.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...profileOption)
  .option(...cwdOption)
  .action(withHubErrors(async (opts: ScopeOptions) => {
    const project = resolveProject(opts);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const hub = connect(opts);
    const variables = await hub.listVariables(project, profile);
    log.header("hub variables", `${project}/${profile}`);
    if (variables.length === 0) {
      log.info("no variables stored on the hub for this project/profile");
      return;
    }
    for (const v of variables) {
      const shown = v.sensitive ? "(sensitive)" : (v.value ?? "");
      log.meta(v.name, shown);
    }
  }));

const varRm = new Command("rm")
  .description("Delete a variable from the hub.")
  .argument("<name>", "Variable name to delete")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...profileOption)
  .option(...cwdOption)
  .action(withHubErrors(async (name: string, opts: ScopeOptions) => {
    const project = resolveProject(opts);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const hub = connect(opts);
    await hub.deleteVariable(project, profile, name);
    log.header("hub var rm", name);
    log.info(`deleted variable "${name}" from the hub`);
  }));

const varCommand = new Command("var")
  .description("Manage environment variables stored on the hub (fetched at run time by `ccqa run` / `ccqa record`).")
  .addCommand(varSet)
  .addCommand(varLs)
  .addCommand(varRm);

// ── prompts ─────────────────────────────────────────────────────────────

function validatePromptName(rawName: string): PromptName {
  if (!isPromptName(rawName)) {
    log.error(`invalid prompt name "${rawName}"`);
    log.hint(`must be one of: ${PROMPT_NAMES.join(", ")}`);
    process.exit(2);
  }
  return rawName;
}

const promptPush = new Command("push")
  .description(
    "Upload a locally-generated prompt asset to the hub, so it's available to other environments running against this project.",
  )
  .argument("<name>", `Prompt name (${PROMPT_NAMES.join(", ")})`)
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...cwdOption)
  .action(withHubErrors(async (rawName: string, opts: ScopeOptions) => {
    const name = validatePromptName(rawName);
    const cwd = resolveCwd(opts.cwd);
    const project = resolveProject(opts);
    const path = resolvePromptLocalPath(name, cwd);

    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch (err) {
      log.error(`could not read prompt "${name}" at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      log.hint("nothing to push; generate it first (e.g. ccqa run --learn-hub-live-prompt)");
      process.exit(2);
    }
    if (body.trim().length === 0) {
      log.error(`prompt "${name}" at ${path} is empty`);
      log.hint("nothing to push; generate it first (e.g. ccqa run --learn-hub-live-prompt)");
      process.exit(2);
    }

    const hub = connect(opts);
    await hub.putPrompt(project, name, body);
    log.header("hub prompt push", name);
    log.meta("project", project);
    log.info(`uploaded prompt "${name}" to the hub`);
  }));

const promptLs = new Command("ls")
  .description(
    "List prompts stored on the hub for a project (name, kind, last-updated). " +
      "Prompts are project-wide (not per-profile). `ls` shows metadata only.",
  )
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...cwdOption)
  .action(withHubErrors(async (opts: ScopeOptions) => {
    const project = resolveProject(opts);
    const hub = connect(opts);
    const prompts = await hub.listPrompts(project);
    log.header("hub prompts", project);
    if (prompts.length === 0) {
      log.info("no prompts stored on the hub for this project");
      return;
    }
    for (const p of prompts) log.meta(p.name, `${p.kind}, updated ${p.updatedAt}`);
  }));

const promptRm = new Command("rm")
  .description("Delete a prompt from the hub.")
  .argument("<name>", "Prompt name to delete")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option(...cwdOption)
  .action(withHubErrors(async (rawName: string, opts: ScopeOptions) => {
    const name = validatePromptName(rawName);
    const project = resolveProject(opts);
    const hub = connect(opts);
    await hub.deletePrompt(project, name);
    log.header("hub prompt rm", name);
    log.info(`deleted prompt "${name}" from the hub`);
  }));

const promptCommand = new Command("prompt")
  .description("Manage prompt assets (per-flow user/agent guidance, triage/audit user guidance, learned calibration prompts) stored on the hub (fetched automatically by `ccqa run` / `ccqa audit` at run time).")
  .addCommand(promptPush)
  .addCommand(promptLs)
  .addCommand(promptRm);

// ── deploys ─────────────────────────────────────────────────────────────

interface DeployRecordOptions extends HubConnOptions {
  project?: string;
  profile: string;
  cwd?: string;
  sha: string;
  previous?: string;
  ref?: string;
  /** Commander sets this from `--no-select-specs`: true unless the flag is passed. */
  selectSpecs?: boolean;
}

const deployRecord = new Command("record")
  .description(
    "Tell the hub what a deploy shipped, so it can answer which specs need a re-run " +
      "(`ccqa run --only-hub-rerun-needed`). Run this from the deploy job, after the deploy succeeds. " +
      "The changed paths are computed locally with a two-dot `git diff <previous> <sha>`; " +
      "a job that has only curl and git can POST the same body directly (see docs/hub.md).",
  )
  .requiredOption(
    "--profile <name>",
    "Environment this deploy landed in (e.g. 'stg'). Required: dev and stg sit at different commits, so the deploy log is per-profile.",
  )
  .requiredOption("--sha <sha>", "Commit that was deployed.")
  .option(
    "--previous <sha>",
    "Commit this deploy replaced. Omit it and the hub's current log head is used — the normal case, " +
      "recording no discontinuity. Pass a sha that differs from the head and the hub records one " +
      "(gapBefore) in the chain: use this for a first record with a real baseline, or to re-anchor a " +
      "head that no longer matches reality. With no head and nothing passed, there's nothing to diff " +
      "against: changedPaths is unset and the spec selection is skipped.",
  )
  .option("--ref <ref>", "Ref that was deployed (branch or tag). Recorded for display only.")
  .option(
    "--no-select-specs",
    "Record the deploy without deciding which specs it reaches. The entry then becomes a hole in the " +
      "range — every spec behind it is assumed reached rather than being cleared, and nothing can " +
      "fill it in later, since the hub has no checkout to diff. The decision intersects the diff " +
      "with measured coverage from the hub and calls no model, so there is rarely a reason to skip it.",
  )
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option("--project <name>", "Project whose deploy log this entry joins. Defaults to the current directory's name.")
  .option("--cwd <path>", "Directory the git diff and the default --project name are resolved against.")
  .action(withHubErrors(async (opts: DeployRecordOptions) => {
    await runDeployRecord(opts);
  }));

async function runDeployRecord(opts: DeployRecordOptions): Promise<void> {
  const cwd = resolveCwd(opts.cwd);
  const project = resolveProject(opts);
  const hub = connect(opts);

  // Without an explicit predecessor, the hub's own head is the only honest
  // answer to "what did this replace" — ccqa never guesses a baseline. When
  // there is no head yet (the first ever deploy), there is nothing to diff
  // against: changedPaths stays null (record-only; re-run verdicts are
  // decided from `hasSelection`, not from it) rather than an empty change set.
  const previous = opts.previous ?? (await deployHeadSha(hub, project, opts.profile));
  const runUrl = githubRunUrl();
  // One diff for the whole range, shared below by `changedPaths` and
  // the selection — they used to each run their own git diff over it.
  const diff = previous === null ? null : await diffOrNull(previous, opts.sha, cwd);
  const changedPaths = diff ? capDeployPaths(diff.map((f) => f.path)) : null;
  const selection = opts.selectSpecs !== false && previous !== null && diff !== null
    ? await selectionForDeploy(hub, project, diff, previous, opts.sha, cwd)
    : undefined;

  const entry = await hub.recordDeploy(project, opts.profile, {
    sha: opts.sha,
    previousSha: previous,
    changedPaths,
    ...(selection ? { selection } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}),
    // Same source `ccqa run` uses, so a deploy recorded from Actions links
    // back to its job with no extra flag.
    ...(runUrl ? { runUrl } : {}),
  });

  log.header("hub deploy record", entry.sha.slice(0, 12));
  log.meta("project", project);
  log.meta("profile", opts.profile);
  log.meta("previous", previous ? previous.slice(0, 12) : "(none)");
  log.meta("changed paths", changedPaths === null ? "(not reported)" : String(changedPaths.length));
  if (opts.selectSpecs !== false) log.meta("selection", describeSelection(selection, diff !== null));
  if (entry.gapBefore) {
    log.warn(
      "this deploy does not chain onto the log head, so a gap is recorded — specs whose baseline sits behind it are assumed reached rather than cleared to 'verified'",
    );
  }
  // The hub only marks the entry once the selection has actually landed. If
  // we sent one and it did not, that range is a hole nothing fills later,
  // which the job must not exit quietly on.
  if (selection && !entry.hasSelection) {
    log.error(
      "the hub recorded this deploy but could not store its spec selection — every spec behind it " +
        "is assumed reached from here on, and nothing fills it in later. Re-record this deploy.",
    );
    process.exit(1);
  }
  log.info(`recorded deploy #${entry.index}`);
}

/**
 * Decide which specs this deploy reaches, in the shape the hub stores.
 *
 * Takes the diff `deployRecord` already fetched for `changedPaths`, rather
 * than diffing again — the decision needs the diff and the spec tree, and the
 * hub has neither, but there's no reason to ask git for the same range twice.
 * The hub does hold the coverage measurements the verdicts rest on, so those
 * are read back through the same connection the entry is posted over.
 * `undefined` on failure rather than a half-answer: the deploy is then
 * recorded without a selection, and specs behind it read `unknown` instead of
 * being cleared by a selection that isn't there.
 */
async function selectionForDeploy(
  hub: HubClient,
  project: string,
  changed: readonly ChangedFile[],
  previous: string,
  sha: string,
  cwd: string,
): Promise<DeploySelection | undefined> {
  try {
    const specs = await loadSpecInventory(cwd);
    if (specs.length === 0) return undefined;
    const edges = await loadCoverageEdges({ hub, project });
    const report = await selectSpecs({
      changed,
      specs,
      cwd,
      base: previous,
      head: sha,
      edges,
    });
    return Object.fromEntries(
      report.specs.map((s) => [
        specKey(s),
        {
          verdict: s.verdict,
          reason: s.reason,
          // The hub's touch index keeps at most MAX_TOUCHED_BY paths per spec
          // (`foldTouchIndex`); sending more only grows the request, and a
          // monorepo-wide diff can push it past the hub's body limit.
          ...(s.touchedBy?.length ? { touchedBy: s.touchedBy.slice(0, MAX_TOUCHED_BY) } : {}),
        },
      ]),
    );
  } catch (err) {
    log.warn(
      `could not decide which specs this deploy reaches (${errMessage(err)}); ` +
        "recording the deploy without a selection",
    );
    return undefined;
  }
}

/**
 * The two-dot diff for this deploy's range, or `null` when git can't produce
 * one (a shallow checkout that never fetched `previous`, a rolled-back sha
 * that isn't local). Shared by `changedPaths` and the selection's input, so a
 * diff failure skips both rather than each attempting — and separately
 * failing — its own git call.
 */
async function diffOrNull(previous: string, sha: string, cwd: string): Promise<ChangedFile[] | null> {
  try {
    return await getChangedFilesBetween(previous, sha, cwd, { detectRenames: false });
  } catch (err) {
    log.warn(
      `could not diff ${previous.slice(0, 12)}..${sha.slice(0, 12)} (${errMessage(err)}); ` +
        "recording the deploy without changed paths",
    );
    return null;
  }
}

/** The selection summary line: verdict counts, or why there isn't one. */
function describeSelection(selection: DeploySelection | undefined, diffAvailable: boolean): string {
  if (!selection) {
    return diffAvailable ? "(skipped — see warning above)" : "(skipped — no diff to select against)";
  }
  const values = Object.values(selection);
  const needed = values.filter((s) => s.verdict === "needed").length;
  const unknown = values.filter((s) => s.verdict === "unknown").length;
  return `${needed} needed / ${unknown} unknown / ${values.length} specs`;
}

const deployCommand = new Command("deploy")
  .description("Report deploys to the hub, the input behind `ccqa run --only-hub-rerun-needed`.")
  .addCommand(deployRecord);

// ── cost ────────────────────────────────────────────────────────────────

interface CostPushOptions extends HubConnOptions {
  project?: string;
  cwd?: string;
  label: string;
  from?: string;
}

const costPush = new Command("push")
  .description(
    "Record what this job spent on Claude: sum the cost file every ccqa invocation appended to " +
      "($CCQA_COST_FILE) and push the total to the hub as one spend entry. Run it last, once. " +
      "A budget reads these totals INSTEAD OF summing the hub's runs: most commands that call Claude " +
      "leave no run behind, and a batch already includes the ones that do, so adding both double-counts.",
  )
  .requiredOption(
    "--label <name>",
    "What this batch was — typically the CI job's name. Required: an unlabelled entry tells a reader " +
      "nothing about where the money went.",
  )
  .option("--from <path>", "Cost file to read. Defaults to $CCQA_COST_FILE.")
  .option("--project <name>", "Project the spend is recorded against. Defaults to the current directory's name.")
  .option(...cwdOption)
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .action(withHubErrors(runCostPush));

async function runCostPush(opts: CostPushOptions): Promise<void> {
  const path = opts.from ?? process.env.CCQA_COST_FILE;
  if (!path) {
    log.error("no cost file to read (--from <path> or CCQA_COST_FILE)");
    process.exit(2);
  }
  const project = resolveProject(opts);
  const hub = connect(opts);

  log.header("hub cost push", opts.label);
  log.meta("project", project);
  const total = await readCostFileTotal(path);
  if (total === null) {
    log.warn(`no cost file at ${path}; recorded nothing — ccqa never ran here, which is not a spend of zero`);
    return;
  }
  if (total.invocations === 0) {
    log.warn(`${path} holds no invocations; recorded nothing`);
    return;
  }
  await hub.recordSpend(project, { costUsd: total.totalUsd, label: opts.label, ...ciProvenance() });
  log.meta("invocations", String(total.invocations));
  if (total.unreadable > 0) {
    log.warn(
      `${total.unreadable} line(s) of ${path} could not be read, so the total below is a floor: ` +
        "what they cost is not in it, and the hub now holds the short number",
    );
  }
  log.info(`recorded $${total.totalUsd.toFixed(4)} of spend on the hub`);
}

const costCommand = new Command("cost")
  .description("Report what a CI job spent on Claude to the hub — the number a budget reads.")
  .addCommand(costPush);

// ── push ──────────────────────────────────────────────────────────────────

const pushCommand = new Command("push")
  .description(
    "Upload the report directory of a finished `ccqa run --report` to the hub as a run. " +
      "Run this after `ccqa run` (use `if: always()` in CI so failing runs are pushed too).",
  )
  .option("--report-dir <dir>", `Report directory to push. Default: ${DEFAULT_REPORT_DIR}/`)
  .option("--project <name>", "Logical project name for the run. Defaults to the current directory's name.")
  .option("--branch <name>", "Branch label. Defaults to $GITHUB_HEAD_REF / $GITHUB_REF_NAME / current git branch.")
  .option("--profile <name>", "Profile (environment) the run executed against. Recorded for display; runs are not scoped by profile.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option("--cwd <path>", "Directory the report dir is resolved against (defaults to the current directory).")
  .action(withHubErrors(async (opts: HubConnOptions & { reportDir?: string; project?: string; branch?: string; profile?: string; cwd?: string }) => {
    const cwd = resolveCwd(opts.cwd);
    const reportDir = join(cwd, opts.reportDir ?? DEFAULT_REPORT_DIR);
    const project = resolveProject(opts);

    let report: unknown;
    try {
      report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8"));
    } catch {
      log.error(`no readable report.json in ${reportDir}`);
      log.hint("run `ccqa run --report` first, then push its report directory");
      process.exit(2);
    }
    const parsed = RunReportDataSchema.safeParse(report);
    if (!parsed.success) {
      log.error(`report.json in ${reportDir} is not a valid ccqa report`);
      process.exit(2);
    }
    // The commit the environment was running when the run *started*, captured
    // by `ccqa run`. Asserting it closes the window where a deploy landing
    // mid-run would otherwise be recorded as this run's baseline — the hub's
    // own fallback is its deploy-log head at push time, which is after the run.
    const deployedSha = parsed.data.deployedSha;

    // The pushed tarball carries report.json + the evidence PNGs + the run
    // artifacts dir; the hub UI fetches each file through the artifacts API
    // (no inlined HTML report).
    const branch = opts.branch ?? (await detectBranch(cwd));
    const archive = await packDirToTarGz(reportDir);

    const hub = connect(opts);
    const run = await hub.pushRun(archive, {
      project,
      ...(branch ? { branch } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(deployedSha ? { deployedSha } : {}),
    });

    log.header("hub push", run.id);
    log.meta("project", run.project);
    if (run.profile) log.meta("profile", run.profile);
    if (run.branch) log.meta("branch", run.branch);
    log.meta("status", run.status);
    log.meta("specs", `${run.specs.passed}/${run.specs.total} passed`);
    log.info(`${resolveBaseUrl(opts)}/#/runs/${run.id}`);
  }));

// ── attestations ────────────────────────────────────────────────────────

interface AttestOptions extends HubConnOptions {
  project?: string;
  profile: string;
  by?: string;
  note?: string;
  revoke?: boolean;
}

const attestCommand = new Command("attest")
  .argument("<feature/spec>", "Spec id, e.g. checkout/happy-path")
  .description(
    "Record that a person checked a spec's behaviour by hand against the deployed environment. " +
      "The verdict answers manuallyVerified instead of asking a person for what a person already " +
      "did — the drift ledger is untouched, so the repair loop keeps its reason to fix the test. " +
      "The attestation lapses on its own when a deploy reaches the spec or the spec is edited.",
  )
  .requiredOption("--profile <name>", "Environment that was checked (e.g. 'stg'). The attestation is anchored to its current deploy head.")
  .option("--by <name>", "Who checked. Required unless --revoke.")
  .option("--note <text>", "What was checked and how — the reader deciding whether to trust it sees this.")
  .option("--revoke", "Withdraw the spec's attestation instead of recording one.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option("--project <name>", "Hub project. Defaults to the current directory's name.")
  .option("--cwd <path>", "Directory the default --project name is resolved against.")
  .action(withHubErrors(async (rawSpecId: string, opts: AttestOptions) => {
    const project = resolveProject(opts);
    const hub = connect(opts);
    const specId = requireSpecId(rawSpecId);

    if (opts.revoke) {
      await hub.deleteAttestation(project, { profile: opts.profile }, specId);
      log.header("hub attest", `${specId} revoked`);
      return;
    }
    if (!opts.by) {
      log.error("--by <name> is required: an attestation is a person's word, and it needs the person");
      process.exit(2);
    }
    const res = await hub.putAttestation(project, { profile: opts.profile }, {
      spec: specId,
      by: opts.by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });
    log.header("hub attest", specId);
    log.meta("by", res.attestation.by);
    log.meta("anchored to deploy", res.attestation.deployedSha ?? "(no deploy log)");
    log.info("the verdict answers manuallyVerified until a deploy reaches this spec or the spec is edited");
  }));

// ── audit dismissals ────────────────────────────────────────────────────

interface DismissOptions extends HubConnOptions {
  project?: string;
  cwd?: string;
  by?: string;
  reason?: string;
  revoke?: boolean;
}

const dismissCommand = new Command("dismiss")
  .argument("<feature/spec>", "Spec id, e.g. checkout/happy-path")
  .description(
    "Record that a person judged the spec's current audit finding wrong: the spec describes the " +
      "code fine. This settles the audit axis rather than the verdict — the spec goes back to " +
      "being run like any other, and the next run says whether the person was right. The " +
      "dismissal is pinned to the audit run that raised the finding, so a later audit can raise " +
      "it again. No --profile: a finding is about the repository, not an environment.",
  )
  .option("--by <name>", "Who judged it wrong. Required unless --revoke.")
  .option("--reason <text>", "Why the finding is wrong. Required unless --revoke — this is what a mis-firing audit learns from.")
  .option("--revoke", "Withdraw the dismissal, putting the finding back in force.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option("--project <name>", "Hub project. Defaults to the current directory's name.")
  .option("--cwd <path>", "Directory the default --project name is resolved against.")
  .action(withHubErrors(async (rawSpecId: string, opts: DismissOptions) => {
    const project = resolveProject(opts);
    const hub = connect(opts);
    const specId = requireSpecId(rawSpecId);

    if (opts.revoke) {
      await hub.deleteAuditDismissal(project, specId);
      log.header("hub dismiss", `${specId} revoked`);
      return;
    }
    if (!opts.by || !opts.reason) {
      log.error("--by <name> and --reason <text> are both required: a dismissal is a person's correction, and it needs the person and the correction");
      process.exit(2);
    }
    const res = await hub.putAuditDismissal(project, { spec: specId, by: opts.by, note: opts.reason });
    log.header("hub dismiss", specId);
    log.meta("by", res.dismissal.by);
    log.meta("dismissed", `${res.dismissal.label} — ${res.dismissal.headline || "(no headline)"}`);
    log.info("this finding no longer holds the spec back; a later audit can raise one of its own");
  }));

// ── coverage ──────────────────────────────────────────────────────────────

interface CoverageInspectOptions extends HubConnOptions {
  project?: string;
  runId?: string;
  json?: boolean;
  cwd?: string;
}

const coverageCommand = new Command("coverage")
  .description(
    "Print what the hub's coverage stream resolved for a run: per-spec measured file counts and " +
      "the stream's health counters. This is the read-out measured spec selection consumes — " +
      "use it to see why a spec's reach is empty before blaming the selection.",
  )
  .option("--run-id <id>", "Stream run id to resolve. Defaults to the most recently measured run.")
  .option("--files", "List each spec's measured files, not just their count.")
  .option("--json", "Print the raw resolved answer as JSON (everything, including file lists).")
  .option("--project <name>", "Project whose stream is read. Defaults to the current directory's name.")
  .option(...cwdOption)
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .action(withHubErrors(runCoverageInspect));

async function runCoverageInspect(opts: CoverageInspectOptions & { files?: boolean }): Promise<void> {
  const project = resolveProject(opts);
  const hub = connect(opts);
  const answer = await hub.getCoverage(project, opts.runId ? { runId: opts.runId } : {});
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    return;
  }
  log.header("hub coverage", project);
  if (answer.runIds.length === 0) {
    log.warn("the stream holds no measured runs for this project");
    return;
  }
  log.meta("measured runs", `${answer.runIds.length} (newest first): ${answer.runIds.join(", ")}`);
  const resolved = answer.resolved;
  if (resolved == null) {
    log.warn("nothing resolved — pass --run-id with one of the runs above");
    return;
  }
  log.meta("run", resolved.runId + (resolved.hubRunId ? ` (hub run ${resolved.hubRunId})` : ""));
  log.meta("as of", new Date(resolved.asOf).toISOString());
  if (resolved.universe) {
    log.meta(
      "universe",
      `${resolved.universe.files.length} file(s) (include: ${resolved.universe.include.join(", ")})`,
    );
  }
  log.meta("boot", `${resolved.boot.length} file(s) reached only at module load`);
  const measured = resolved.specs.filter((spec) => spec.files.length > 0);
  log.meta("specs", `${measured.length}/${resolved.specs.length} measured files`);
  for (const spec of resolved.specs) {
    const actors = Object.entries(spec.actorEvents)
      .map(([key, count]) => `${key}: ${count} event(s)`)
      .join(", ");
    log.info(`  ${spec.specId}: ${spec.files.length} file(s)${actors ? ` (${actors})` : ""}`);
    if (opts.files === true) for (const file of spec.files) log.info(`    ${file}`);
  }
  const h = resolved.health;
  log.meta(
    "health",
    `heard-from-application=${h.heardFromApplication} pushes-during-run=${h.pushesDuringRun} ` +
      `attributed-specs=${h.attributedSpecs} specs-measured=${h.specsMeasured} ` +
      `rejected=${h.rejectedPushes} dropped=${h.droppedPushes} ` +
      `uninstrumented-files=${h.uninstrumentedFiles} uninstrumented-processes=${h.uninstrumentedProcesses} ` +
      `unmapped-actor-events=${h.unmappedActorEvents}`,
  );
  const outside = Object.entries(h.outsideWindowEvents);
  if (outside.length > 0) {
    log.warn(
      `outside-window events (identity was driven while unclaimed): ${outside
        .map(([key, count]) => `${key}: ${count}`)
        .join(", ")}`,
    );
  }
}

export const hubCommand = new Command("hub")
  .description(
    "Client for a ccqa hub: push run results and manage sessions/variables/prompts used by `ccqa run`. " +
      "See docs/hub.md.",
  )
  .addCommand(pushCommand)
  .addCommand(deployCommand)
  .addCommand(costCommand)
  .addCommand(coverageCommand)
  .addCommand(sessionCommand)
  .addCommand(varCommand)
  .addCommand(promptCommand)
  .addCommand(attestCommand)
  .addCommand(dismissCommand);

/** Loose check that a fetched session is agent-browser storage-state, mirroring loadStorageState. */
export function isStorageStateShape(state: unknown): state is { cookies: unknown[]; origins: unknown[] } {
  return (
    typeof state === "object" &&
    state !== null &&
    Array.isArray((state as { cookies?: unknown }).cookies) &&
    Array.isArray((state as { origins?: unknown }).origins)
  );
}
