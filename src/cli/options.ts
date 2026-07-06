import type { Command } from "commander";
import { DEFAULT_LANGUAGE } from "../prompts/language.ts";
import { applyProfileEnv, defaultEnvPath, loadDefaultEnv } from "../runtime/profile-env.ts";
import { HubApiError } from "../hub-client/index.ts";
import { HubConnectionError, requireHubClient, type HubConnOptions } from "./hub-conn.ts";
import { hubHeaderOption, hubTokenOption, hubUrlOption } from "./hub-conn.ts";
import * as log from "./logger.ts";

export { DEFAULT_LANGUAGE, languageDirective, useJapanesePrompts } from "../prompts/language.ts";

/**
 * Shared `--language` flag. Every Claude-driven command writes some
 * human-readable text, so language is a cross-cutting concern handled the same
 * way everywhere — much like `--model`. The value is a BCP-47 tag (e.g. "ja",
 * "en") or "auto" (default), which follows the language of the material.
 */
export function addLanguageOption(command: Command): Command {
  return command.option(
    "--language <bcp47>",
    "Language for human-readable output (e.g. 'en', 'ja'). Default 'auto' follows the language of the spec/codebase.",
    DEFAULT_LANGUAGE,
  );
}

/**
 * Shared `--profile <name>` flag for the browser-driving commands (`run`,
 * `record`), registered identically so help text and behaviour don't drift.
 */
export function addProfileOption(command: Command): Command {
  return command.option(
    "--profile <name>",
    "Load this profile's variables from the hub into the environment before resolving spec ${VAR} references (URLs, credentials), so one spec can target dev/stg/prd without per-environment copies. Profile values override the inherited environment. Requires --hub-url/--hub-token (or CCQA_HUB_URL/CCQA_HUB_TOKEN).",
  );
}

/**
 * Shared `--hub-url` / `--hub-token` flags for commands that optionally talk
 * to a hub (`run`, `record`), registered identically to `ccqa hub`'s own
 * options so help text and behaviour don't drift.
 */
export function addHubOptions(command: Command): Command {
  return command.option(...hubUrlOption).option(...hubTokenOption).option(...hubHeaderOption);
}

export interface ResolveProfileEnvOptions extends HubConnOptions {
  profile?: string;
  project: string;
  cwd: string;
}

/**
 * CLI wrapper around `resolveProfileEnv`: on failure, print the error and
 * `process.exit(2)`. Commands that own the process (`record`) use this;
 * library entry points (`executeRun`, the hub runner) call
 * `resolveProfileEnv` directly and map the thrown error themselves.
 */
export async function applyProfileFromOption(opts: ResolveProfileEnvOptions): Promise<void> {
  try {
    await resolveProfileEnv(opts);
  } catch (err) {
    if (err instanceof HubConnectionError) {
      log.error(err.message);
    } else if (err instanceof HubApiError) {
      log.error(`hub error (${err.status} ${err.code}): ${err.message}`);
    } else if (opts.profile !== undefined) {
      log.error(`failed to load profile "${opts.profile}": ${err instanceof Error ? err.message : String(err)}`);
    } else {
      // `.env` exists but can't be read (EACCES / EISDIR / …). Unlike a missing
      // file this is a real misconfiguration, so surface it rather than running
      // with a half-loaded environment.
      log.error(`failed to load ${defaultEnvPath(opts.cwd)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(2);
  }
}

/**
 * Merge the environment for a `run` / `record` invocation into `process.env`
 * before any spec work. With `--profile <name>`, fetch that profile's
 * variables from the hub (missing connection → `HubConnectionError`; hub-side
 * failure → `HubApiError`). Without it, auto-load `<cwd>/.env` if present (a
 * missing `.env` is fine). Checking `!== undefined` rejects `--profile ""`
 * rather than skipping it.
 */
export async function resolveProfileEnv(opts: ResolveProfileEnvOptions): Promise<void> {
  if (opts.profile !== undefined) {
    await applyNamedProfile(opts.profile, opts.project, opts.cwd, opts);
  } else {
    await applyDefaultEnv(opts.cwd);
  }
}

/** "1 var" / "2 vars" — the count summary shared by both load paths' meta line. */
function varCount(n: number): string {
  return `${n} var${n === 1 ? "" : "s"}`;
}

async function applyNamedProfile(
  profile: string,
  project: string,
  cwd: string,
  hubConn: HubConnOptions,
): Promise<void> {
  const hub = requireHubClient(hubConn);
  const variables = await hub.listVariables(project, profile, { includeValues: true });
  const vars: Record<string, string> = {};
  for (const v of variables) {
    if (v.value !== undefined) vars[v.name] = v.value;
  }
  const applied = applyProfileEnv(vars);
  log.meta("profile", `${profile} (${varCount(applied.length)})`);
  // An explicitly named but empty profile is almost certainly a mistake, so
  // warn. The implicit `.env` path doesn't — an empty/absent `.env` is a
  // normal, expected case there.
  if (applied.length === 0) {
    log.warn(`profile "${profile}" defined no variables — spec $\{VAR} references will resolve to empty`);
  }
}

async function applyDefaultEnv(cwd: string): Promise<void> {
  const vars = await loadDefaultEnv(cwd);
  if (vars === null) return; // no .env — keep the inherited process.env as-is
  // The implicit `.env` does NOT override an already-set shell var — that's the
  // conventional dotenv precedence (an explicit `export` for one run wins). An
  // explicit `--profile` is the opposite (see applyNamedProfile): naming it is
  // a deliberate choice, so it overrides.
  const applied = applyProfileEnv(vars, { override: false });
  log.meta("env", `.env (${varCount(applied.length)})`);
}
