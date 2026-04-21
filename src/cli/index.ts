import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { traceCommand } from "./trace.ts";
import { generateCommand } from "./generate.ts";
import { runCommand } from "./run.ts";
import { traceSetupCommand } from "./trace-setup.ts";
import { generateSetupCommand } from "./generate-setup.ts";

// package.json location differs between source (dev) and dist builds:
//   src/cli/index.ts  → ../../package.json  (repo root)
//   dist/cli/index.js → ../package.json     (dist copy, written by tsdown)
// Probe the dist location first; fall back to the source-tree location
// so `pnpm dev` still works from a fresh clone.
const packageJsonPath = resolvePackageJson();
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

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
