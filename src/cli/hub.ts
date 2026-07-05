import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import { execFileP } from "../drift/affected.ts";
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
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { hubTokenOption, hubUrlOption, resolveHubClient, type HubConnOptions } from "./hub-conn.ts";
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

/**
 * Wrap a subcommand action so a `HubApiError` (hub request failed, e.g. a
 * 503 when the hub has no encryption key configured) prints a clean message
 * and exits 2, instead of surfacing as an unhandled rejection with a stack
 * trace.
 */
function withHubErrors<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof HubApiError) {
        log.error(`hub request failed (${err.status} ${err.code}): ${err.message}`);
        process.exit(2);
      }
      throw err;
    }
  };
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
      log.hint(`create it first with:  ccqa session bootstrap ${name}${opts.profile ? ` --profile ${opts.profile}` : ""}`);
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
  .argument("<name>", "Prompt name (record.user, record.agent, live.user, live.agent, or analysis-custom-prompt)")
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
      log.hint("nothing to push; generate it first (e.g. ccqa run --update-agent-prompt)");
      process.exit(2);
    }
    if (body.trim().length === 0) {
      log.error(`prompt "${name}" at ${path} is empty`);
      log.hint("nothing to push; generate it first (e.g. ccqa run --update-agent-prompt)");
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
  .description("Manage prompt assets (record/live guidance, analysis custom prompt) stored on the hub (fetched automatically by `ccqa run` at run time).")
  .addCommand(promptPush)
  .addCommand(promptLs)
  .addCommand(promptRm);

// ── push ──────────────────────────────────────────────────────────────────

const pushCommand = new Command("push")
  .description(
    "Upload the report directory of a finished `ccqa run --report` to the hub as a run. " +
      "Run this after `ccqa run` (use `if: always()` in CI so failing runs are pushed too).",
  )
  .option("--report <dir>", `Report directory to push. Default: ${DEFAULT_REPORT_DIR}/`)
  .option("--project <name>", "Logical project name for the run. Defaults to the current directory's name.")
  .option("--branch <name>", "Branch label. Defaults to $GITHUB_HEAD_REF / $GITHUB_REF_NAME / current git branch.")
  .option("--profile <name>", "Profile (environment) the run executed against. Recorded for display; runs are not scoped by profile.")
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option("--cwd <path>", "Directory the report dir is resolved against (defaults to the current directory).")
  .action(withHubErrors(async (opts: HubConnOptions & { report?: string; project?: string; branch?: string; profile?: string; cwd?: string }) => {
    const cwd = resolveCwd(opts.cwd);
    const reportDir = join(cwd, opts.report ?? DEFAULT_REPORT_DIR);
    const project = resolveProject(opts);

    let report: unknown;
    try {
      report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8"));
    } catch {
      log.error(`no readable report.json in ${reportDir}`);
      log.hint("run `ccqa run --report` first, then push its report directory");
      process.exit(2);
    }
    if (!RunReportDataSchema.safeParse(report).success) {
      log.error(`report.json in ${reportDir} is not a valid ccqa report`);
      process.exit(2);
    }

    // The pushed tarball carries report.json + the evidence PNGs; the hub UI
    // fetches each PNG through the artifacts API (no inlined HTML report).
    const branch = opts.branch ?? (await detectBranch(cwd));
    const archive = await packDirToTarGz(reportDir);

    const hub = connect(opts);
    const run = await hub.pushRun(archive, {
      project,
      ...(branch ? { branch } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
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
  .addCommand(sessionCommand)
  .addCommand(varCommand)
  .addCommand(promptCommand);

/** Best-effort current branch: CI env vars first, then git, else null. */
async function detectBranch(cwd: string): Promise<string | null> {
  const fromEnv = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/** Loose check that a fetched session is agent-browser storage-state, mirroring loadStorageState. */
export function isStorageStateShape(state: unknown): state is { cookies: unknown[]; origins: unknown[] } {
  return (
    typeof state === "object" &&
    state !== null &&
    Array.isArray((state as { cookies?: unknown }).cookies) &&
    Array.isArray((state as { origins?: unknown }).origins)
  );
}
