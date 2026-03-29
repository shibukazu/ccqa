import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  ensureVeriqDir,
  parseSpecPath,
  getTraceActions,
  saveTestScript,
} from "../store/index.ts";
import { actionsToScript } from "../codegen/actions-to-script.ts";
import { buildCleanupPrompt } from "../prompts/codegen.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { TraceAction } from "../types.ts";
import * as log from "./logger.ts";

export const generateCommand = new Command("generate")
  .argument("<feature/spec>", "Spec to generate test for (e.g. tasks/create-and-complete)")
  .description("Generate agent-browser test script from recorded trace actions")
  .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
  .action(async (specPath: string, opts: { maxRetries: string }) => {
    const { featureName, specName } = parseSpecPath(specPath);
    await runGenerate(featureName, specName, parseInt(opts.maxRetries, 10));
  });

async function runGenerate(featureName: string, specName: string, maxRetries: number): Promise<void> {
  log.header("generate", `${featureName}/${specName}`);

  await ensureVeriqDir();

  const { path: actionsPath, actions } = await getTraceActions(featureName, specName);

  log.meta("trace", actionsPath);
  log.meta("actions", actions.length);
  log.blank();

  const cleanedActions = await cleanupActions(actions);
  if (cleanedActions.length !== actions.length) {
    log.meta("cleaned", cleanedActions.length);
  }

  const script = actionsToScript(cleanedActions);
  const scriptPath = await saveTestScript(featureName, specName, script);
  log.meta("saved", scriptPath);
  log.blank();

  let { exitCode, output, currentScript } = await runVitest(scriptPath);
  if (exitCode === 0) {
    log.hint(`run 'veriq run ${featureName}/${specName}' to execute the test`);
    return;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log.info(`auto-fix attempt ${attempt}/${maxRetries}...`);
    log.blank();

    const fixed = insertWaitBeforeFailure(currentScript, output);
    if (!fixed) {
      log.warn("could not determine fix from failure log");
      break;
    }

    await writeFile(scriptPath, fixed, "utf-8");
    log.meta("saved", scriptPath);
    log.blank();

    ({ exitCode, output, currentScript } = await runVitest(scriptPath));
    if (exitCode === 0) {
      log.hint(`run 'veriq run ${featureName}/${specName}' to execute the test`);
      return;
    }
  }

  log.warn("auto-fix exhausted — test still failing");
  process.exit(1);
}

/**
 * Inserts a 1-second sleep before the failing line identified in the vitest stack trace.
 * If a sleep already exists before that line, its duration is incremented instead.
 */
function insertWaitBeforeFailure(script: string, failureLog: string): string | null {
  const lines = script.split("\n");

  const testBodyStart = lines.findIndex((l) => l.includes('test("full flow"')) + 1;
  if (testBodyStart === 0) return null;

  // Stack trace order: helper line first → caller in test body last.
  // Take the last occurrence with line > testBodyStart to get the actual call site.
  const matches = [...failureLog.matchAll(/test\.spec\.ts:(\d+):\d+/g)];
  const failLine = matches
    .map((m) => parseInt(m[1]!, 10))
    .filter((n) => n > testBodyStart)
    .at(-1);

  if (!failLine) return null;

  const insertAt = failLine - 1;
  if (insertAt < 0 || insertAt >= lines.length) return null;

  const prevLine = lines[insertAt - 1]?.trim() ?? "";
  const existingSleep = prevLine.match(/^spawnSync\("sleep",\s*\["(\d+)"\]/);
  if (existingSleep) {
    const newSec = parseInt(existingSleep[1]!, 10) + 1;
    lines[insertAt - 1] = lines[insertAt - 1]!.replace(`["${existingSleep[1]}"]`, `["${newSec}"]`);
    return lines.join("\n");
  }

  lines.splice(insertAt, 0, `  spawnSync("sleep", ["1"], { stdio: "inherit" });`);
  return lines.join("\n");
}

async function runVitest(scriptPath: string): Promise<{ exitCode: number; output: string; currentScript: string }> {
  const proc = Bun.spawn(["bunx", "vitest", "run", scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Read the script after the process exits to avoid TOCTOU with insertWaitBeforeFailure
  const currentScript = await Bun.file(scriptPath).text();

  process.stdout.write(stdoutText);
  if (stderrText) process.stderr.write(stderrText);
  return { exitCode, output: stdoutText + stderrText, currentScript };
}

async function cleanupActions(actions: TraceAction[]): Promise<TraceAction[]> {
  try {
    const prompt = buildCleanupPrompt(actions);
    const { result, isError } = await invokeClaudeStreaming(
      { prompt, disableBuiltinTools: true, maxTurns: 1 },
      () => {},
    );
    if (isError || !result) return actions;
    // Strip markdown code fences that the LLM may wrap the JSON in
    const json = result.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/, "$1").trim();
    const parsed = JSON.parse(json) as TraceAction[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Fall through and return original actions on any error (JSON parse failure, API error, etc.)
  }
  return actions;
}
