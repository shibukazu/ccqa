import { Command } from "commander";
import { traceCommand } from "./trace.ts";
import { generateCommand } from "./generate.ts";
import { runCommand } from "./run.ts";
import { traceSetupCommand } from "./trace-setup.ts";
import { generateSetupCommand } from "./generate-setup.ts";

const program = new Command();

program
  .name("veriq")
  .description("E2E test CLI using Claude Code + agent-browser")
  .version("0.1.0");

program.addCommand(traceCommand);
program.addCommand(generateCommand);
program.addCommand(runCommand);
program.addCommand(traceSetupCommand);
program.addCommand(generateSetupCommand);

program.parse();
