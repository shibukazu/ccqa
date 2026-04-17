import { Command } from "commander";
import { readFileSync } from "node:fs";
import { traceCommand } from "./trace.ts";
import { generateCommand } from "./generate.ts";
import { runCommand } from "./run.ts";
import { traceSetupCommand } from "./trace-setup.ts";
import { generateSetupCommand } from "./generate-setup.ts";

const packageJsonPath = new URL("../../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = new Command();

program
  .name("ccqa")
  .description("E2E test CLI using Claude Code + agent-browser")
  .version(version);

program.addCommand(traceCommand);
program.addCommand(generateCommand);
program.addCommand(runCommand);
program.addCommand(traceSetupCommand);
program.addCommand(generateSetupCommand);

program.parse();
