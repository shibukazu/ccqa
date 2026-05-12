import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  ensureCcqaDir,
  parseSpecPath,
  getTraceActions,
  getSetupDir,
  getTestScript,
  readSpecFile,
  saveTestScript,
} from "../store/index.ts";
import { actionsToScript } from "../codegen/actions-to-script.ts";
import type { SetupScript } from "../codegen/actions-to-script.ts";
import { buildCleanupPrompt } from "../prompts/codegen.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestTeed } from "../runtime/spawn-vitest.ts";
import { envRefsToJsExpression, hasEnvRef } from "../runtime/env-vars.ts";
import { runAutoFixLoop, resolveMode, type FixMode, type RunVitestResult } from "../diagnose/loop.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import type { TraceAction } from "../types.ts";
import * as log from "./logger.ts";

interface GenerateOptions {
  maxRetries: string;
  auto?: boolean;
  noInteractive?: boolean;
  interactive?: boolean;
  force?: boolean;
  /** commander stores --no-snapshot as `snapshot: false`. */
  snapshot?: boolean;
  language?: string;
  model?: string;
}

// `<feature>/<spec>` is a 2-segment alias of the on-disk path
// `.ccqa/features/<feature>/test-cases/<spec>/`. Document it on the
// argument and in the description so `generate --help` is self-explanatory.
export const generateCommand = new Command("generate")
  .argument(
    "<feature/spec>",
    "Spec id in '<feature>/<spec>' form (resolves to .ccqa/features/<feature>/test-cases/<spec>/)",
  )
  .description(
    "Generate agent-browser test script from recorded trace actions. " +
      "test.spec.ts is regenerated from actions.json on every run; pass --force to overwrite manual edits.",
  )
  .option("--max-retries <n>", "Maximum number of auto-fix retries", "3")
  .option("--auto", "Apply auto-fixes without confirmation regardless of confidence (CI use)")
  .option("--no-interactive", "Never prompt; only auto-apply when confidence is high, otherwise give up")
  .option("--force", "Overwrite an existing test.spec.ts without warning")
  .option(
    "--no-snapshot",
    "Don't pin AGENT_BROWSER_SESSION / capture page snapshots after a failure (debug toggle)",
  )
  .option(
    "--language <bcp47>",
    "Language for diagnose reasoning / hint text (e.g. 'en', 'ja')",
    "en",
  )
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .action(async (specPath: string, opts: GenerateOptions) => {
    const { featureName, specName } = parseSpecPath(specPath);
    const mode = resolveMode(opts);
    const useSnapshot = opts.snapshot !== false;
    await runGenerate(
      featureName,
      specName,
      parseInt(opts.maxRetries, 10),
      mode,
      opts.force ?? false,
      useSnapshot,
      opts.language ?? "en",
      opts.model,
    );
  });

async function runGenerate(
  featureName: string,
  specName: string,
  maxRetries: number,
  mode: FixMode,
  force: boolean,
  useSnapshot: boolean,
  outputLanguage: string,
  model: string | undefined,
): Promise<void> {
  log.header("generate", `${featureName}/${specName}`);

  await ensureCcqaDir();

  // Refuse to overwrite an existing test.spec.ts unless --force.
  // generate regenerates the script from actions.json, so any manual edits to
  // test.spec.ts (e.g. patched selectors) are silently lost without this check.
  // We always confirm interactively (regardless of --auto / --no-interactive),
  // because overwriting a hand-edited file is a different kind of decision
  // than auto-applying an auto-fix and warrants an explicit y/N. CI flows
  // should pass --force.
  const existingScriptPath = await getTestScript(featureName, specName);
  if (existingScriptPath && !force) {
    const proceed = await confirmOverwrite(existingScriptPath);
    if (!proceed) {
      log.info("aborted; pass --force to overwrite without prompting");
      return;
    }
  }

  const { path: actionsPath, actions } = await getTraceActions(featureName, specName);

  log.meta("trace", actionsPath);
  log.meta("actions", actions.length);

  const specContent = await readSpecFile(featureName, specName);
  const spec = parseTestSpec(specContent);
  const setupScripts = await loadSetupScripts(
    spec.setups as Array<{ name: string; params?: Record<string, string> }> | undefined,
  );
  if (setupScripts.length > 0) {
    log.meta("setups", setupScripts.map((s) => s.name).join(", "));
  }
  log.meta("fix-mode", mode);
  log.meta("language", outputLanguage);
  log.blank();

  const cleanedActions = await cleanupActions(actions, model);
  if (cleanedActions.length !== actions.length) {
    log.meta("cleaned", cleanedActions.length);
  }

  const script = actionsToScript(cleanedActions, spec.title, setupScripts.length > 0 ? setupScripts : undefined);
  const scriptPath = await saveTestScript(featureName, specName, script);
  log.meta("saved", scriptPath);
  log.blank();

  // Pin the agent-browser session so we can re-attach for snapshot capture
  // after a vitest failure. The generated script reads AGENT_BROWSER_SESSION
  // via `||=`, so this value flows through unmodified. `--no-snapshot`
  // disables both the pin and the post-failure snapshot, restoring the
  // pre-snapshot behavior for debugging.
  const agentBrowserSession = useSnapshot ? `ccqa-generate-${Date.now()}` : undefined;
  const runVitestForSession = (path: string) => runVitest(path, agentBrowserSession);

  // Wrap the run in try/finally so a wedged daemon from a previous attempt
  // never persists across invocations. We close the session on entry too
  // (in case a stale one shares the name from a crashed prior run) and
  // again on exit (success, failure, or thrown). The helper is best-effort
  // and never throws.
  //
  // Ctrl-C bypasses try/finally on Node by default, so we also wire a
  // signal handler that fires close before we exit. SIGINT/SIGTERM both
  // get the same treatment.
  let signalHandler: (() => void) | null = null;
  if (agentBrowserSession) {
    await closeSession(agentBrowserSession);
    signalHandler = () => {
      void closeSession(agentBrowserSession).finally(() => process.exit(130));
    };
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
  }
  try {
    const initialRun = await log.timedPhase("vitest run #1", () => runVitestForSession(scriptPath), "run");
    if (initialRun.exitCode === 0) {
      log.hint(`run 'ccqa run ${featureName}/${specName}' to execute the test`);
      return;
    }

    const passed = await runAutoFixLoop({
      scriptPath,
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

    if (passed) {
      log.hint(`run 'ccqa run ${featureName}/${specName}' to execute the test`);
      return;
    }

    log.warn("auto-fix exhausted; test still failing");
    process.exit(1);
  } finally {
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    if (agentBrowserSession) await closeSession(agentBrowserSession);
  }
}

async function confirmOverwrite(path: string): Promise<boolean> {
  // Without a TTY (CI, piped stdin) we can't prompt. Refuse to overwrite —
  // CI/scripted callers should pass --force explicitly to opt in.
  if (!process.stdin.isTTY) {
    log.warn(`${path} exists and stdin is not a TTY; refusing to overwrite. Pass --force to allow.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\n");
    process.stdout.write(`[warn] ${path} already exists.\n`);
    process.stdout.write(`[warn] generate will regenerate it from actions.json and any manual edits will be lost.\n`);
    const answer = await new Promise<string>((res) => rl.question("Overwrite? [y/N] ", res));
    const norm = answer.trim().toLowerCase();
    return norm === "y" || norm === "yes";
  } finally {
    rl.close();
  }
}

async function loadSetupScripts(
  setups?: Array<{ name: string; params?: Record<string, string> }>,
): Promise<SetupScript[]> {
  if (!setups?.length) return [];

  const result: SetupScript[] = [];
  for (const ref of setups) {
    const scriptPath = join(getSetupDir(ref.name), "test.spec.ts");
    const script = await readFile(scriptPath, "utf-8").catch(() => {
      throw new Error(`Setup test script not found: ${scriptPath}. Run \`ccqa generate-setup ${ref.name}\` first.`);
    });
    const body = extractTestBody(script);
    const resolved = replacePlaceholders(body, ref.params ?? {});
    result.push({ name: ref.name, body: resolved });
  }
  return result;
}

/**
 * Extract the test body (statements inside the test callback) from a setup
 * test script.
 *
 * Locates the first arrow callback (`=> {`) after a top-level `test(` call
 * and returns the text between the matching `{` and `}`. Handles both
 * single-line and multi-line `test(...)` formatting (the latter is what
 * prettier produces).
 *
 * Brace tracking is naive (string/regex/comment literals are not parsed
 * specially), but setup test scripts are themselves generated by ccqa and
 * follow a fixed shape, so this is sufficient in practice.
 */
function extractTestBody(script: string): string {
  const testCallMatch = /\btest\s*\(/.exec(script);
  if (!testCallMatch) return "";
  const arrowIdx = script.indexOf("=> {", testCallMatch.index);
  if (arrowIdx === -1) return "";
  const bodyStart = arrowIdx + "=> {".length;
  let depth = 1;
  let i = bodyStart;
  for (; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return "";
  return script.slice(bodyStart, i).replace(/^\n/, "").replace(/\n\s*$/, "");
}

function replacePlaceholders(body: string, params: Record<string, string>): string {
  let result = body;
  for (const [key, value] of Object.entries(params)) {
    if (hasEnvRef(value)) {
      const expr = envRefsToJsExpression(value);
      const re = new RegExp(`(["'])\\{\\{${escapeRegExp(key)}\\}\\}\\1`, "g");
      result = result.replace(re, expr);
      result = result.replaceAll(`{{${key}}}`, value);
    } else {
      result = result.replaceAll(`{{${key}}}`, value);
    }
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
