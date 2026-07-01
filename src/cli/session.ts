import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";

import { DEFAULT_SESSION_PROFILE, sessionFilePath, sessionsDir } from "../runtime/session-state.ts";
import { SessionNameSchema } from "../spec/yaml-schema.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import * as log from "./logger.ts";

const require = createRequire(import.meta.url);
const AB = require.resolve("agent-browser/bin/agent-browser.js");

/**
 * Run agent-browser attached to the user's terminal (no timeout, inherited
 * stdio) so a human can complete an interactive login during `bootstrap`.
 * Distinct from runtime/spawn-ab.ts, which pipes stdio and hard-times-out for
 * non-interactive automation.
 */
function runAbInteractive(args: string[]): number {
  const r = spawnSync(AB, args, { stdio: "inherit" });
  return r.status ?? 1;
}

function validateName(name: string): string {
  const parsed = SessionNameSchema.safeParse(name);
  if (!parsed.success) {
    log.error(`invalid session name "${name}": ${parsed.error.issues[0]?.message ?? "bad name"}`);
    process.exit(2);
  }
  return parsed.data;
}

const profileOption = [
  "--profile <name>",
  "Sessions bucket to read/write (.ccqa/sessions/<profile>/). Defaults to 'default'.",
] as const;

const bootstrapCommand = new Command("bootstrap")
  .description(
    "Open a headed browser so you can log in by hand, then save the resulting " +
      "session (cookies + localStorage) for `session:` specs to restore. The saved " +
      "file holds live auth cookies — keep .ccqa/sessions/ gitignored.",
  )
  .argument("<name>", "Session name to save (a slug; resolves to .ccqa/sessions/<profile>/<name>.json)")
  .option("--url <url>", "URL to open first (e.g. the login page). Omit to start with a blank tab.")
  .option(...profileOption)
  .option("--cwd <path>", "Project root containing .ccqa/ (defaults to the current directory).")
  .action(async (rawName: string, opts: { url?: string; profile?: string; cwd?: string }) => {
    const name = validateName(rawName);
    const cwd = resolveCwd(opts.cwd);
    const dest = sessionFilePath(name, opts.profile, cwd);
    log.header("session bootstrap", name);
    log.meta("profile", opts.profile ?? DEFAULT_SESSION_PROFILE);
    log.meta("save to", dest);
    log.blank();

    const openArgs = ["--headed", "open", ...(opts.url ? [opts.url] : ["about:blank"])];
    log.info("opening a browser — log in by hand, then return here.");
    const openStatus = runAbInteractive(openArgs);
    if (openStatus !== 0) {
      log.error(`agent-browser open exited ${openStatus}`);
      process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\nPress Enter once you are fully logged in to save the session… ");
    rl.close();

    await mkdir(dirname(dest), { recursive: true });
    const saveStatus = runAbInteractive(["state", "save", dest]);
    runAbInteractive(["close"]);
    if (saveStatus !== 0) {
      log.error(`agent-browser state save exited ${saveStatus}`);
      process.exit(1);
    }
    log.blank();
    log.info(`saved session "${name}" → ${dest}`);
    log.hint("reference it from a spec with:  session: " + name);
  });

const lsCommand = new Command("ls")
  .description("List saved sessions for a profile (names + last-saved times). No secret values are shown.")
  .option(...profileOption)
  .option("--cwd <path>", "Project root containing .ccqa/ (defaults to the current directory).")
  .action(async (opts: { profile?: string; cwd?: string }) => {
    const cwd = resolveCwd(opts.cwd);
    const profile = opts.profile ?? DEFAULT_SESSION_PROFILE;
    const dir = sessionsDir(profile, cwd);
    log.header("sessions", profile);
    let entries: string[];
    try {
      entries = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      log.info(`no saved sessions in ${dir}`);
      log.hint("create one with:  ccqa session bootstrap <name>");
      return;
    }
    for (const file of entries.sort()) {
      const info = await stat(join(dir, file));
      log.meta(file.replace(/\.json$/, ""), `saved ${info.mtime.toISOString()}`);
    }
  });

export const sessionCommand = new Command("session")
  .description("Manage saved browser sessions (cookies + localStorage) for `session:` specs.")
  .addCommand(bootstrapCommand)
  .addCommand(lsCommand);
