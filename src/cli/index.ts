import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run.ts";
import { recordCommand } from "./record.ts";
import { generateCommand } from "./generate.ts";
import { draftCommand } from "./draft.ts";
import { driftCommand } from "./drift.ts";
import { initCommand } from "./init.ts";
import { perspectivesCommand } from "./perspectives.ts";
import { sessionCommand } from "./session.ts";
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

// `init` is a one-shot bootstrap, listed first so it's discoverable.
// Lifecycle order for the rest: draft → perspectives → record → generate → run → drift
program.addCommand(initCommand);
program.addCommand(draftCommand);
program.addCommand(perspectivesCommand);
program.addCommand(recordCommand);
program.addCommand(generateCommand);
program.addCommand(runCommand);
program.addCommand(driftCommand);
program.addCommand(sessionCommand);
program.addCommand(serveCommand);
program.addCommand(hubCommand);

program.parse();
