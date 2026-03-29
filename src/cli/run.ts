import { Command } from "commander";
import {
  parseSpecPath,
  getTestScript,
  listAllSpecs,
  listSpecsForFeature,
} from "../store/index.ts";
import * as log from "./logger.ts";

export const runCommand = new Command("run")
  .argument("[target]", "Spec to run: '<feature>/<spec>', '<feature>', or omit for all")
  .description("Run generated agent-browser test scripts")
  .action(async (target?: string) => {
    await runTests(target);
  });

async function runTests(target?: string): Promise<void> {
  log.header("run", target);

  const specs = await resolveSpecs(target);

  if (specs.length === 0) {
    log.error("no test scripts found");
    log.hint("run 'veriq generate <feature>/<spec>' first to generate tests");
    process.exit(1);
  }

  let overallExitCode = 0;

  for (const { featureName, specName } of specs) {
    const scriptFile = await getTestScript(featureName, specName);
    if (!scriptFile) {
      log.warn(`${featureName}/${specName}: no test.spec.ts found`);
      continue;
    }

    log.info(`${featureName}/${specName}`);
    log.meta("test", scriptFile);
    log.blank();

    const proc = Bun.spawn(["bunx", "vitest", "run", scriptFile], {
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) overallExitCode = exitCode;
  }

  process.exit(overallExitCode);
}

async function resolveSpecs(target?: string): Promise<Array<{ featureName: string; specName: string }>> {
  if (!target) {
    return listAllSpecs();
  }

  if (target.includes("/")) {
    const { featureName, specName } = parseSpecPath(target);
    return [{ featureName, specName }];
  }

  const specNames = await listSpecsForFeature(target);
  return specNames.map((specName) => ({ featureName: target, specName }));
}
