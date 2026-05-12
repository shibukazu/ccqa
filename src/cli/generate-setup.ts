import { readFile, writeFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import {
  ensureCcqaDir,
  readSetupSpecFile,
  getSetupActions,
  getSetupDir,
} from "../store/index.ts";
import { actionsToScript } from "../codegen/actions-to-script.ts";
import { buildCleanupPrompt } from "../prompts/codegen.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { parseSetupSpec } from "../spec/parser.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestTeed } from "../runtime/spawn-vitest.ts";
import { hasEnvRef, resolveEnvRefs } from "../runtime/env-vars.ts";
import { runAutoFixLoop, resolveMode, type FixMode, type RunVitestResult } from "../diagnose/loop.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import type { TraceAction } from "../types.ts";
import * as log from "./logger.ts";

interface GenerateSetupOptions {
  maxRetries: string;
  fromDummy?: boolean;
  auto?: boolean;
  noInteractive?: boolean;
  interactive?: boolean;
  language?: string;
  model?: string;
}

export const generateSetupCommand = new Command("generate-setup")
  .argument("<name>", "Setup name to generate (e.g. login)")
  .description("Clean up, validate, and templatize setup actions")
  .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
  .option("--from-dummy", "Resume from existing test.dummy.spec.ts (after manual fix)")
  .option("--auto", "Apply auto-fixes without confirmation regardless of confidence (CI use)")
  .option("--no-interactive", "Never prompt; only auto-apply when confidence is high, otherwise give up")
  .option(
    "--language <bcp47>",
    "Language for diagnose reasoning / hint text (e.g. 'en', 'ja')",
    "en",
  )
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .action(async (name: string, opts: GenerateSetupOptions) => {
    const mode = resolveMode(opts);
    await runGenerateSetup(
      name,
      parseInt(opts.maxRetries, 10),
      opts.fromDummy ?? false,
      mode,
      opts.language ?? "en",
      opts.model,
    );
  });

async function runGenerateSetup(
  name: string,
  maxRetries: number,
  fromDummy: boolean,
  mode: FixMode,
  outputLanguage: string,
  model: string | undefined,
): Promise<void> {
  log.header("generate-setup", name);

  await ensureCcqaDir();

  const specContent = await readSetupSpecFile(name);
  const spec = parseSetupSpec(specContent);
  const dummyPath = join(getSetupDir(name), "test.dummy.spec.ts");
  const finalPath = join(getSetupDir(name), "test.spec.ts");

  // We pass actions to the diagnose loop for context. When --from-dummy
  // skips the actions.json read, we fall back to an empty array.
  let cleanedActions: TraceAction[] = [];

  if (fromDummy) {
    const exists = await stat(dummyPath).then(() => true).catch(() => false);
    if (!exists) {
      log.warn(`test.dummy.spec.ts not found. Run without --from-dummy first.`);
      process.exit(1);
    }
    log.info("Resuming from existing test.dummy.spec.ts");
  } else {
    const { actions } = await getSetupActions(name);
    log.meta("setup", spec.title);
    log.meta("actions", actions.length);
    log.meta("fix-mode", mode);
    log.meta("language", outputLanguage);
    log.blank();

    cleanedActions = await cleanupActions(actions, model);
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
  //
  // Pin the agent-browser session so the auto-fix loop can re-attach for
  // snapshot capture after a failure. The generated script reads
  // AGENT_BROWSER_SESSION via `||=`, so this value flows through.
  const agentBrowserSession = `ccqa-generate-setup-${name}-${Date.now()}`;
  const runVitestForSession = (path: string) => runVitestResolved(path, agentBrowserSession);

  // Best-effort cleanup before/after; see the matching block in generate.ts.
  await closeSession(agentBrowserSession);
  const signalHandler = () => {
    void closeSession(agentBrowserSession).finally(() => process.exit(130));
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    const initialRun = await log.timedPhase("vitest run #1", () => runVitestForSession(dummyPath), "run");

    let passed = initialRun.exitCode === 0;
    if (!passed) {
      passed = await runAutoFixLoop({
        scriptPath: dummyPath,
        initialRun,
        specMarkdown: specContent,
        actions: cleanedActions,
        maxRetries,
        mode,
        runVitest: runVitestForSession,
        agentBrowserSession,
        outputLanguage,
        model,
      });
    }

    if (!passed) {
      log.warn("auto-fix exhausted; setup test still failing");
      log.hint(`edit ${dummyPath} manually, then run: ccqa generate-setup ${name} --from-dummy`);
      process.exit(1);
    }

    // Phase 3: Reverse-replace dummy values → {{placeholders}}, save as test.spec.ts
    const currentScript = await readFile(dummyPath, "utf8");
    const templatizedScript = reversePlaceholdersInScript(
      currentScript,
      spec.placeholders as Record<string, { dummy: string; description?: string }> | undefined,
    );

    await writeFile(finalPath, templatizedScript, "utf-8");
    await unlink(dummyPath).catch(() => {});

    log.blank();
    log.meta("saved", finalPath);
    log.hint(`setup '${name}' is ready; reference it in test-spec.md with setups: [{name: ${name}, params: {...}}]`);
  } finally {
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    await closeSession(agentBrowserSession);
  }
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

async function runVitest(scriptPath: string, agentBrowserSession?: string): Promise<RunVitestResult> {
  const { exitCode, stdout, stderr } = await spawnVitestTeed(
    ["run", "--config", bundledVitestConfigPath(), scriptPath],
    agentBrowserSession
      ? { env: { ...process.env, AGENT_BROWSER_SESSION: agentBrowserSession } }
      : {},
  );
  const currentScript = await readFile(scriptPath, "utf8");
  return { exitCode, output: stdout + stderr, currentScript };
}

/**
 * Run vitest on `test.dummy.spec.ts`, but transparently expand any `${VAR}`
 * env refs to real values for the duration of the run. The original file is
 * preserved unchanged so subsequent reverse-replace still sees the env-ref
 * literals. Auto-fix edits the original file (via writeFile in callers), so
 * we always re-read it before each invocation.
 */
async function runVitestResolved(scriptPath: string, agentBrowserSession?: string): Promise<RunVitestResult> {
  const original = await readFile(scriptPath, "utf8");
  if (!hasEnvRef(original)) {
    return runVitest(scriptPath, agentBrowserSession);
  }

  const tmpPath = scriptPath.replace(/\.ts$/, ".__resolved.spec.ts");
  await writeFile(tmpPath, resolveEnvRefs(original), "utf-8");
  try {
    const { exitCode, stdout, stderr } = await spawnVitestTeed(
      ["run", "--config", bundledVitestConfigPath(), tmpPath],
      agentBrowserSession
        ? { env: { ...process.env, AGENT_BROWSER_SESSION: agentBrowserSession } }
        : {},
    );
    return { exitCode, output: stdout + stderr, currentScript: original };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

async function cleanupActions(actions: TraceAction[], model?: string): Promise<TraceAction[]> {
  try {
    const prompt = buildCleanupPrompt(actions);
    const { result, isError } = await invokeClaudeStreaming(
      { prompt, disableBuiltinTools: true, maxTurns: 1, model },
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
