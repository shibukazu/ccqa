import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run.ts";
import { recordCommand } from "./record.ts";
import { draftCommand } from "./draft.ts";
import { driftCommand } from "./drift.ts";
import { perspectivesCommand } from "./perspectives.ts";

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
  .description("E2E test CLI using Claude Code + agent-browser")
  .version(version);

// Lifecycle order: draft → perspectives → record → run → drift
program.addCommand(draftCommand);
program.addCommand(perspectivesCommand);
program.addCommand(recordCommand);
program.addCommand(runCommand);
program.addCommand(driftCommand);

program.parse();
