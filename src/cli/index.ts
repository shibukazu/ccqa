import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run.ts";
import { recordCommand } from "./record.ts";
import { generateCommand } from "./generate.ts";
import { draftCommand } from "./draft.ts";
import { auditCommand } from "./audit.ts";
import { initCommand } from "./init.ts";
import { perspectivesCommand } from "./perspectives.ts";
import { selectSpecsCommand } from "./select-specs.ts";
import { serveCommand } from "./serve.ts";
import { hubCommand } from "./hub.ts";

// dist build copies package.json next to the bundle (../package.json);
// source-tree dev still needs the repo-root copy (../../package.json).
function resolvePackageJson(): string {
  const distCandidate = fileURLToPath(new URL("../package.json", import.meta.url));
  const srcCandidate = fileURLToPath(new URL("../../package.json", import.meta.url));
  try {
    readFileSync(distCandidate);
    return distCandidate;
  } catch {
    return srcCandidate;
  }
}

const { version } = JSON.parse(readFileSync(resolvePackageJson(), "utf8")) as { version: string };

const program = new Command();

program
  .name("ccqa")
  .description("E2E test CLI powered by Claude Code — agent-browser by default, or Playwright / runn targets")
  .version(version);

// Grouped so `ccqa --help` reads as what the tool does rather than an
// alphabet of verbs. Within each group the order is the lifecycle order.
program.commandsGroup("Write specs:");
program.addCommand(initCommand);
program.addCommand(draftCommand);
program.addCommand(perspectivesCommand);

program.commandsGroup("Build tests from them:");
program.addCommand(recordCommand);
program.addCommand(generateCommand);

program.commandsGroup("Check them:");
program.addCommand(runCommand);
program.addCommand(auditCommand);

program.commandsGroup("Hub:");
program.addCommand(hubCommand);
program.addCommand(serveCommand);

program.commandsGroup("Building blocks:");
program.addCommand(selectSpecsCommand);

program.parse();
