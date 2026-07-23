import { Command } from "commander";
import { ensureCcqaDir } from "../store/index.ts";
import * as log from "./logger.ts";
import { resolveCwd } from "./resolve-cwd.ts";

interface InitOptions {
  cwd?: string;
}

export const initCommand = new Command("init")
  .description("Create the .ccqa/ spec skeleton (features/, blocks/) in the current directory.")
  .option("--cwd <path>", "Working directory (default: cwd)")
  .action(async (opts: InitOptions) => {
    const cwd = resolveCwd(opts.cwd);
    log.header("init", cwd);

    await ensureCcqaDir(cwd);
    log.info("created  .ccqa/features/, .ccqa/blocks/");

    log.blank();
    log.hint("set CCQA_HUB_URL / CCQA_HUB_TOKEN to connect to a ccqa hub");
    log.hint("edit guidance prompts in the hub UI's Prompts tab");
    log.hint("recording-backed targets: `ccqa record <feature>/<spec>` to trace + generate");
    log.hint("spec-input targets (e.g. runn): `ccqa generate <feature>/<spec>` — no recording step");
  });
