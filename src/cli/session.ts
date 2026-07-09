import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";

import { DEFAULT_SESSION_PROFILE, loadStorageState, verifySessionRestores } from "../runtime/session-state.ts";
import { SessionNameSchema } from "../spec/yaml-schema.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { HubConnectionError, hubTokenOption, hubUrlOption, requireHubClient, type HubConnOptions } from "./hub-conn.ts";
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
  "Sessions bucket to read/write on the hub. Defaults to 'default'.",
] as const;
const projectOption = [
  "--project <name>",
  "Project the session belongs to on the hub. Defaults to the current directory's name.",
] as const;

interface BootstrapOptions extends HubConnOptions {
  url?: string;
  profile?: string;
  project?: string;
  cwd?: string;
}

const bootstrapCommand = new Command("bootstrap")
  .description(
    "Open a headed browser so you can log in by hand, then upload the resulting " +
      "session (cookies + localStorage) to the hub for `session:` specs to restore.",
  )
  .argument("<name>", "Session name to save")
  .option("--url <url>", "URL to open first (e.g. the login page). Omit to start with a blank tab.")
  .option(...profileOption)
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...projectOption)
  .option("--cwd <path>", "Directory the default --project name is derived from (defaults to the current directory).")
  .action(async (rawName: string, opts: BootstrapOptions) => {
    const name = validateName(rawName);
    const cwd = resolveCwd(opts.cwd);
    const project = resolveProject(opts);
    let hub;
    try {
      hub = requireHubClient(opts);
    } catch (err) {
      if (!(err instanceof HubConnectionError)) throw err;
      log.error(err.message);
      process.exit(2);
    }

    log.header("session bootstrap", name);
    log.meta("project", project);
    log.meta("profile", opts.profile ?? DEFAULT_SESSION_PROFILE);
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

    const tmpDir = await mkdtemp(join(tmpdir(), "ccqa-session-bootstrap-"));
    try {
      const tmpPath = join(tmpDir, "state.json");
      const saveStatus = runAbInteractive(["state", "save", tmpPath]);
      runAbInteractive(["close"]);
      if (saveStatus !== 0) {
        log.error(`agent-browser state save exited ${saveStatus}`);
        process.exit(1);
      }

      const state = await loadStorageState(tmpPath);

      // Prove the saved state actually restores to a signed-in page before
      // uploading it. Catches the common failure where the login wasn't fully
      // complete at save time (cookies restore, but the app still shows a
      // sign-in form) — which would otherwise only surface later in CI. Needs
      // a URL to navigate; when `--url` was omitted we can't verify, so we
      // skip the gate rather than block the save.
      if (opts.url) {
        log.info("verifying the saved session restores to a signed-in page…");
        const check = verifySessionRestores(tmpPath, opts.url);
        if (!check.restored) {
          log.error(`session did not restore cleanly: ${check.reason}`);
          log.hint(
            "fully load the application (sign in, open the target workspace/page, wait for it " +
              "to settle) before pressing Enter, then run bootstrap again. Nothing was uploaded.",
          );
          process.exit(1);
        }
        log.info("restore verified — the session starts signed in.");
      }

      await hub.putSession(project, opts.profile ?? DEFAULT_SESSION_PROFILE, name, state);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    log.blank();
    log.info(`uploaded session "${name}" to the hub (encrypted at rest)`);
    log.hint("reference it from a spec with:  session: " + name);
  });

export const sessionCommand = new Command("session")
  .description(
    "Manage saved browser sessions (cookies + localStorage) for `session:` specs. " +
      "Use `ccqa hub session ls` to list sessions stored on the hub.",
  )
  .addCommand(bootstrapCommand);
