import { readFile, writeFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import {
  ensureCcqaDir,
  readSetupSpecFile,
  getSetupActions,
  getSetupDir,
  saveSetupTestScript,
} from "../store/index.ts";
import { actionsToScript } from "../codegen/actions-to-script.ts";
import { buildCleanupPrompt, buildAutoFixPrompt } from "../prompts/codegen.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { parseSetupSpec } from "../spec/parser.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestCaptured } from "../runtime/spawn-vitest.ts";
import { hasEnvRef, resolveEnvRefs } from "../runtime/env-vars.ts";
import type { TraceAction } from "../types.ts";
import * as log from "./logger.ts";

export const generateSetupCommand = new Command("generate-setup")
  .argument("<name>", "Setup name to generate (e.g. login)")
  .description("Clean up, validate, and templatize setup actions")
  .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
  .option("--from-dummy", "Resume from existing test.dummy.spec.ts (after manual fix)")
  .action(async (name: string, opts: { maxRetries: string; fromDummy?: boolean }) => {
    await runGenerateSetup(name, parseInt(opts.maxRetries, 10), opts.fromDummy ?? false);
  });

async function runGenerateSetup(name: string, maxRetries: number, fromDummy: boolean): Promise<void> {
  log.header("generate-setup", name);

  await ensureCcqaDir();

  const specContent = await readSetupSpecFile(name);
  const spec = parseSetupSpec(specContent);
  const dummyPath = join(getSetupDir(name), "test.dummy.spec.ts");
  const finalPath = join(getSetupDir(name), "test.spec.ts");

  // Phase 1: Generate or reuse test.dummy.spec.ts
  if (fromDummy) {
    // --from-dummy: use existing test.dummy.spec.ts
    const exists = await stat(dummyPath).then(() => true).catch(() => false);
    if (!exists) {
      log.warn(`test.dummy.spec.ts not found. Run without --from-dummy first.`);
      process.exit(1);
    }
    log.info("Resuming from existing test.dummy.spec.ts");
  } else {
    // Normal: generate from actions.json
    const { actions } = await getSetupActions(name);
    log.meta("setup", spec.title);
    log.meta("actions", actions.length);
    log.blank();

    const cleanedActions = await cleanupActions(actions);
    if (cleanedActions.length !== actions.length) {
      log.meta("cleaned", cleanedActions.length);
    }

    const script = actionsToScript(cleanedActions, spec.title);
    await writeFile(dummyPath, script, "utf-8");
    log.meta("saved", dummyPath);
  }
  log.blank();

  // Phase 2: Run vitest on test.dummy.spec.ts with auto-fix.
  //
  // The script generated from actions.json keeps `${VAR}` env refs as
  // literal text (so the recorded artifacts stay free of secrets). To
  // actually validate the script we need a transient resolved copy that
  // hands real credentials to agent-browser.
  let { exitCode, output, currentScript } = await runVitestResolved(dummyPath);

  if (exitCode !== 0) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      log.info(`auto-fix attempt ${attempt}/${maxRetries}...`);
      log.blank();

      const fixed = await autoFixWithLLM(currentScript, output);
      if (!fixed) {
        log.warn("could not determine fix from failure log");
        break;
      }

      await writeFile(dummyPath, fixed, "utf-8");
      log.meta("saved", dummyPath);
      log.blank();

      ({ exitCode, output, currentScript } = await runVitestResolved(dummyPath));
      if (exitCode === 0) break;
    }

    if (exitCode !== 0) {
      log.warn("auto-fix exhausted — setup test still failing");
      log.hint(`edit ${dummyPath} manually, then run: ccqa generate-setup ${name} --from-dummy`);
      process.exit(1);
    }
  }

  // Phase 3: Reverse-replace dummy values → {{placeholders}}, save as test.spec.ts
  const templatizedScript = reversePlaceholdersInScript(
    currentScript,
    spec.placeholders as Record<string, { dummy: string; description?: string }> | undefined,
  );

  await writeFile(finalPath, templatizedScript, "utf-8");
  await unlink(dummyPath).catch(() => {});

  log.blank();
  log.meta("saved", finalPath);
  log.hint(`setup '${name}' is ready — reference it in test-spec.md with setups: [{name: ${name}, params: {...}}]`);
}

/**
 * Replace dummy values with {{placeholder}} directly in the test script text.
 * Longer dummy values are replaced first to avoid partial matches.
 */
function reversePlaceholdersInScript(
  script: string,
  placeholders?: Record<string, { dummy: string; description?: string }>,
): string {
  if (!placeholders) return script;

  const entries = Object.entries(placeholders).sort(
    (a, b) => b[1].dummy.length - a[1].dummy.length,
  );

  let result = script;
  for (const [key, def] of entries) {
    result = result.replaceAll(def.dummy, `{{${key}}}`);
  }
  return result;
}

// --- Shared utilities ---

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
  const { exitCode, stdout, stderr } = await spawnVitestCaptured([
    "run",
    "--config",
    bundledVitestConfigPath(),
    scriptPath,
  ]);
  const currentScript = await readFile(scriptPath, "utf8");

  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return { exitCode, output: stdout + stderr, currentScript };
}

/**
 * Run vitest on `test.dummy.spec.ts`, but transparently expand any `${VAR}`
 * env refs to real values for the duration of the run. The original file is
 * preserved unchanged so subsequent reverse-replace still sees the env-ref
 * literals. Auto-fix edits the original file (via writeFile in callers), so
 * we always re-read it before each invocation.
 */
async function runVitestResolved(
  scriptPath: string,
): Promise<{ exitCode: number; output: string; currentScript: string }> {
  const original = await readFile(scriptPath, "utf8");
  if (!hasEnvRef(original)) {
    // No env refs — nothing to resolve, run the file directly.
    return runVitest(scriptPath);
  }

  const tmpPath = scriptPath.replace(/\.ts$/, ".__resolved.spec.ts");
  await writeFile(tmpPath, resolveEnvRefs(original), "utf-8");
  try {
    const { exitCode, stdout, stderr } = await spawnVitestCaptured([
      "run",
      "--config",
      bundledVitestConfigPath(),
      tmpPath,
    ]);
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return { exitCode, output: stdout + stderr, currentScript: original };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
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
