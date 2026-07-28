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
import { githubRunUrl } from "../run/github-run.ts";
import { deployHeadSha } from "../run/deploy-head.ts";
import { errMessage } from "../run/errors.ts";
import { capDeployPaths } from "./deploy-paths.ts";
import { getChangedFilesBetween, type ChangedFile } from "../drift/affected.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadSpecInventory } from "../select/inventory.ts";
import type { DeploySelection } from "../hub/contract/schema.ts";
import { specKey } from "../store/index.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { sessionCaptureCommand } from "./session.ts";
import { resolveProject } from "./resolve-project.ts";
import { hubTokenOption, hubUrlOption, resolveHubClient, withHubErrors, type HubConnOptions } from "./hub-conn.ts";
import { detectBranch } from "./git-branch.ts";
import * as log from "./logger.ts";

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
  .description("Manage prompt assets (per-flow user/agent guidance, triage user guidance, analysis custom prompt) stored on the hub (fetched automatically by `ccqa run` at run time).")
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
  select?: boolean;
  model?: string;
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
    "Commit this deploy replaced. Defaults to the profile's current deploy-log head on the hub. With neither, there's nothing to diff against: changedPaths is unset and --select is skipped.",
  )
  .option("--ref <ref>", "Ref that was deployed (branch or tag). Recorded for display only.")
  .option(
    "--select",
    "Also decide which specs this deploy reaches (`ccqa select-specs`) and send the verdict with it. " +
      "Without it the deploy is a hole in the range: specs behind it report 'unknown' rather than 'not needed'.",
  )
  .option(
    "-m, --model <name>",
    "Model for --select. Claude alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option("--project <name>", "Project whose deploy log this entry joins. Defaults to the current directory's name.")
  .option("--cwd <path>", "Directory the git diff and the default --project name are resolved against.")
  .action(withHubErrors(async (opts: DeployRecordOptions) => {
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
    // `--select` — they used to each run their own git diff over it.
    const diff = previous === null ? null : await diffOrNull(previous, opts.sha, cwd);
    const changedPaths = diff ? capDeployPaths(diff.map((f) => f.path)) : null;
    const selection = opts.select && previous !== null && diff !== null
      ? await selectionForDeploy(diff, previous, opts.sha, cwd, opts.model)
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
    if (opts.select) log.meta("selection", describeSelection(selection, diff !== null));
    if (entry.gapBefore) {
      log.warn(
        "this deploy does not chain onto the log head, so a gap is recorded — specs whose baseline sits behind it report 'unknown' rather than 'not needed'",
      );
    }
    log.info(`recorded deploy #${entry.index}`);
  }));

/**
 * Decide which specs this deploy reaches, in the shape the hub stores.
 *
 * Takes the diff `deployRecord` already fetched for `changedPaths`, rather
 * than diffing again — the decision needs the diff and the spec tree, and the
 * hub has neither, but there's no reason to ask git for the same range twice.
 * `undefined` on failure rather than a half-answer: the deploy is then
 * recorded without a selection, and specs behind it read `unknown` instead of
 * being cleared by a selection that isn't there.
 */
async function selectionForDeploy(
  changed: readonly ChangedFile[],
  previous: string,
  sha: string,
  cwd: string,
  model: string | undefined,
): Promise<DeploySelection | undefined> {
  try {
    const specs = await loadSpecInventory(cwd);
    if (specs.length === 0) return undefined;
    const report = await selectSpecs({
      changed,
      specs,
      cwd,
      base: previous,
      head: sha,
      ...(model ? { model } : {}),
    });
    return Object.fromEntries(
      report.specs.map((s) => [
        specKey(s),
        {
          verdict: s.verdict,
          reason: s.reason,
          ...(s.touchedBy?.length ? { touchedBy: s.touchedBy } : {}),
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
 * that isn't local). Shared by `changedPaths` and `--select`'s input, so a
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

/** The `--select` summary line: verdict counts, or why there isn't one. */
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

export const hubCommand = new Command("hub")
  .description(
    "Client for a ccqa hub: push run results and manage sessions/variables/prompts used by `ccqa run`. " +
      "See docs/hub.md.",
  )
  .addCommand(pushCommand)
  .addCommand(deployCommand)
  .addCommand(sessionCommand)
  .addCommand(varCommand)
  .addCommand(promptCommand);

/** Loose check that a fetched session is agent-browser storage-state, mirroring loadStorageState. */
export function isStorageStateShape(state: unknown): state is { cookies: unknown[]; origins: unknown[] } {
  return (
    typeof state === "object" &&
    state !== null &&
    Array.isArray((state as { cookies?: unknown }).cookies) &&
    Array.isArray((state as { origins?: unknown }).origins)
  );
}
