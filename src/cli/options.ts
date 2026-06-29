import type { Command } from "commander";
import { DEFAULT_LANGUAGE } from "../prompts/language.ts";
import {
  applyProfileEnv,
  defaultEnvPath,
  InvalidProfileNameError,
  loadDefaultEnv,
  loadProfileEnv,
  ProfileNotFoundError,
} from "../runtime/profile-env.ts";
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
    "Load .ccqa/profiles/<name>.env into the environment before resolving spec ${VAR} references (URLs, credentials), so one spec can target dev/stg/prd without per-environment copies. Profile values override the inherited environment.",
  );
}

/**
 * Merge the environment for a `run` / `record` invocation into `process.env`
 * before any spec work. With `--profile <name>`, load that profile (missing /
 * invalid → exit 2). Without it, auto-load `<cwd>/.env` if present (a missing
 * `.env` is fine). Checking `!== undefined` rejects `--profile ""` rather than
 * skipping it.
 */
export async function applyProfileFromOption(
  profile: string | undefined,
  cwd: string,
): Promise<void> {
  if (profile !== undefined) {
    await applyNamedProfile(profile, cwd);
  } else {
    await applyDefaultEnv(cwd);
  }
}

/** "1 var" / "2 vars" — the count summary shared by both load paths' meta line. */
function varCount(n: number): string {
  return `${n} var${n === 1 ? "" : "s"}`;
}

async function applyNamedProfile(profile: string, cwd: string): Promise<void> {
  try {
    const vars = await loadProfileEnv(profile, cwd);
    const applied = applyProfileEnv(vars);
    log.meta("profile", `${profile} (${varCount(applied.length)})`);
    // An explicitly named but empty profile is almost certainly a mistake, so
    // warn. The implicit `.env` path doesn't — an empty/absent `.env` is a
    // normal, expected case there.
    if (applied.length === 0) {
      log.warn(`profile "${profile}" defined no variables — spec $\{VAR} references will resolve to empty`);
    }
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      log.error(err.message);
      log.hint(`create ${err.path} with the environment's $\{VAR} values`);
    } else if (err instanceof InvalidProfileNameError) {
      log.error(err.message);
    } else {
      log.error(`failed to load profile "${profile}": ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(2);
  }
}

async function applyDefaultEnv(cwd: string): Promise<void> {
  let vars: Record<string, string> | null;
  try {
    vars = await loadDefaultEnv(cwd);
  } catch (err) {
    // `.env` exists but can't be read (EACCES / EISDIR / …). Unlike a missing
    // file this is a real misconfiguration, so surface it rather than running
    // with a half-loaded environment.
    log.error(`failed to load ${defaultEnvPath(cwd)}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (vars === null) return; // no .env — keep the inherited process.env as-is
  // The implicit `.env` does NOT override an already-set shell var — that's the
  // conventional dotenv precedence (an explicit `export` for one run wins). An
  // explicit `--profile` is the opposite (see applyNamedProfile): naming it is
  // a deliberate choice, so it overrides.
  const applied = applyProfileEnv(vars, { override: false });
  log.meta("env", `.env (${varCount(applied.length)})`);
}
