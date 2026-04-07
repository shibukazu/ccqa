import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureVeriqDir,
  parseSpecPath,
  getTraceActions,
  getSetupDir,
  readSpecFile,
  saveTestScript,
} from "../store/index.ts";
import { actionsToScript } from "../codegen/actions-to-script.ts";
import type { SetupScript } from "../codegen/actions-to-script.ts";
import { buildCleanupPrompt, buildAutoFixPrompt } from "../prompts/codegen.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { parseTestSpec } from "../spec/parser.ts";
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

  // Load setup actions if test-spec references setups
  const specContent = await readSpecFile(featureName, specName);
  const spec = parseTestSpec(specContent);
  const setupScripts = await loadSetupScripts(
    spec.setups as Array<{ name: string; params?: Record<string, string> }> | undefined,
  );
  if (setupScripts.length > 0) {
    log.meta("setups", setupScripts.map((s) => s.name).join(", "));
  }
  log.blank();

  const cleanedActions = await cleanupActions(actions);
  if (cleanedActions.length !== actions.length) {
    log.meta("cleaned", cleanedActions.length);
  }

  const script = actionsToScript(cleanedActions, spec.title, setupScripts.length > 0 ? setupScripts : undefined);
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

    const fixed = await autoFixWithLLM(currentScript, output);
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
 * Load setup test scripts, extract test body, and replace {{placeholders}} with params values.
 */
async function loadSetupScripts(
  setups?: Array<{ name: string; params?: Record<string, string> }>,
): Promise<SetupScript[]> {
  if (!setups?.length) return [];

  const result: SetupScript[] = [];
  for (const ref of setups) {
    const scriptPath = join(getSetupDir(ref.name), "test.spec.ts");
    const script = await readFile(scriptPath, "utf-8").catch(() => {
      throw new Error(`Setup test script not found: ${scriptPath}. Run \`veriq generate-setup ${ref.name}\` first.`);
    });
    const body = extractTestBody(script);
    const resolved = replacePlaceholders(body, ref.params ?? {});
    result.push({ name: ref.name, body: resolved });
  }
  return result;
}

/**
 * Extract the test body (lines inside the first test() block) from a setup test script.
 */
function extractTestBody(script: string): string {
  const lines = script.split("\n");
  const startIdx = lines.findIndex((l) => /^\s*test\(/.test(l));
  if (startIdx === -1) return "";
  // Find the closing });
  let depth = 0;
  const bodyLines: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (i === startIdx) { depth = 1; continue; }
    if (lines[i]!.includes("});") && depth === 1) break;
    bodyLines.push(lines[i]!);
  }
  return bodyLines.join("\n");
}

function replacePlaceholders(body: string, params: Record<string, string>): string {
  let result = body;
  for (const [key, value] of Object.entries(params)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// --- Auto-fix ---

interface SleepInsert { line: number; seconds: number; reason: string }
interface SleepIncrease { line: number; increase_to: number; reason: string }
type AutoFixAction = SleepInsert | SleepIncrease;

async function autoFixWithLLM(script: string, failureLog: string): Promise<string | null> {
  try {
    const prompt = buildAutoFixPrompt(script, failureLog);
    const { result, isError } = await invokeClaudeStreaming(
      { prompt, disableBuiltinTools: true, maxTurns: 1 },
      () => {},
    );
    if (isError || !result) return null;

    const json = result.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/, "$1").trim();
    const fixes = JSON.parse(json) as AutoFixAction[];
    if (!Array.isArray(fixes) || fixes.length === 0) return null;

    return applySleepFixes(script, fixes);
  } catch {
    return null;
  }
}

function applySleepFixes(script: string, fixes: AutoFixAction[]): string {
  const lines = script.split("\n");

  for (const fix of fixes) {
    if ("increase_to" in fix) {
      const idx = fix.line - 1;
      if (idx >= 0 && idx < lines.length) {
        lines[idx] = lines[idx]!.replace(
          /spawnSync\("sleep",\s*\["\d+"\]/,
          `spawnSync("sleep", ["${fix.increase_to}"]`,
        );
      }
    }
  }

  const inserts = fixes
    .filter((f): f is SleepInsert => "seconds" in f && !("increase_to" in f))
    .sort((a, b) => b.line - a.line);

  for (const fix of inserts) {
    const idx = fix.line - 1;
    if (idx >= 0 && idx <= lines.length) {
      lines.splice(idx, 0, `  spawnSync("sleep", ["${fix.seconds}"], { stdio: "inherit" });`);
    }
  }

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
    const json = result.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/, "$1").trim();
    const parsed = JSON.parse(json) as TraceAction[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Fall through
  }
  return actions;
}
