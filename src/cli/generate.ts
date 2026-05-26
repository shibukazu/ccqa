import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  ensureCcqaDir,
  getTestScript,
  getTraceActions,
  loadAllBlocks,
  parseSpecPath,
  readSpecFile,
  saveTestScript,
} from "../store/index.ts";
import { warnStaleBlockArtifacts } from "./stale-blocks.ts";
import { actionsToScript, type EmptyStepNotice } from "../codegen/actions-to-script.ts";
import { cleanupActions as runActionCleanup } from "../codegen/cleanup.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { expandSpec, type ExpandedActionStep } from "../spec/expand.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestTeed } from "../runtime/spawn-vitest.ts";
import { runAutoFixLoop, resolveMode, type FixMode, type RunVitestResult } from "../diagnose/loop.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import type { TraceAction } from "../types.ts";
import { addLanguageOption, DEFAULT_LANGUAGE } from "./options.ts";
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
export const generateCommand = addLanguageOption(
  new Command("generate")
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
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    ),
).action(async (specPath: string, opts: GenerateOptions) => {
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
    opts.language ?? DEFAULT_LANGUAGE,
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
  const blocks = await loadAllBlocks();
  const expanded = expandSpec(spec, { blocks });

  await warnStaleBlockArtifacts();

  log.meta("steps", expanded.length);
  log.meta("fix-mode", mode);
  log.meta("language", outputLanguage);
  log.blank();

  const cleanedActions = await cleanupActions(actions, model);
  if (cleanedActions.length !== actions.length) {
    log.meta("cleaned", cleanedActions.length);
  }

  const markers = buildStepMarkers(expanded, cleanedActions);
  const emptySteps = findEmptySteps(expanded, cleanedActions);
  if (emptySteps.length > 0) {
    for (const e of emptySteps) {
      log.warn(`step ${e.stepId} has no kept actions — generated test will skip it (notice comment inserted).`);
    }
  }
  const script = actionsToScript({
    actions: cleanedActions,
    testName: spec.title,
    stepMarkers: markers,
    emptySteps,
  });
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
      specYaml: specContent,
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

/**
 * Build the per-step markers consumed by `actionsToScript`. Each action's
 * `stepId` (assigned at trace time from the last `STEP_START|...` line)
 * groups contiguous actions; we emit one marker at the first action of
 * each contiguous run. Unknown step ids are skipped rather than mis-labelled.
 */
function buildStepMarkers(
  steps: ExpandedActionStep[],
  actions: TraceAction[],
): Array<{ actionIndex: number; stepId: string; source: string }> {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const markers: Array<{ actionIndex: number; stepId: string; source: string }> = [];
  let lastEmittedStepId: string | null = null;
  for (let i = 0; i < actions.length; i++) {
    const id = actions[i]!.stepId;
    if (!id || id === lastEmittedStepId) continue;
    const step = stepById.get(id);
    if (!step) continue;
    markers.push({ actionIndex: i, stepId: step.id, source: step.source });
    lastEmittedStepId = id;
  }
  return markers;
}

/**
 * Spec steps that lost every action by the time the trace finished its
 * cleanup + validation passes. `actionsToScript` uses these to splice a
 * visible `// [warn] step N was dropped` block into the generated script,
 * so the spec author can see at a glance that the recorded test stopped
 * exercising part of the spec.
 *
 * `insertAfterIndex = -1` means the lost step came before any kept
 * action; otherwise it's the cleanedActions index whose action precedes
 * the lost step in spec order. Spec order is canonical for the comment
 * placement so the warning lands near the steps that DID survive.
 */
export function findEmptySteps(
  steps: ExpandedActionStep[],
  cleanedActions: TraceAction[],
): EmptyStepNotice[] {
  const presentStepIds = new Set<string>();
  for (const a of cleanedActions) if (a.stepId) presentStepIds.add(a.stepId);

  // Map every cleanedActions index back to its stepId so we know which
  // surviving step a "lost" step should appear after in spec order.
  const lastActionIndexByStep = new Map<string, number>();
  for (let i = 0; i < cleanedActions.length; i++) {
    const id = cleanedActions[i]!.stepId;
    if (id) lastActionIndexByStep.set(id, i);
  }

  const notices: EmptyStepNotice[] = [];
  let lastSeenSurvivorIndex = -1;
  for (const step of steps) {
    if (presentStepIds.has(step.id)) {
      const idx = lastActionIndexByStep.get(step.id);
      if (idx !== undefined) lastSeenSurvivorIndex = idx;
      continue;
    }
    notices.push({ stepId: step.id, source: step.source, insertAfterIndex: lastSeenSurvivorIndex });
  }
  return notices;
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
  const cleaned = await runActionCleanup(actions, model);
  return cleaned === actions ? actions : reattachStepIds(cleaned, actions);
}

/**
 * The Claude cleanup pass returns a pruned array without the `stepId` field
 * (the prompt deliberately doesn't expose it — that would make the prompt
 * easier to misformat). Re-attach stepIds here by replaying the cleaned
 * stream against the original and matching the next compatible action.
 *
 * Algorithm: walk both arrays in lockstep. For each cleaned action, scan
 * forward in `original` (from the last-matched cursor) for the next entry
 * with the same `command` + `selector` + `value` + `assertType` shape, and
 * borrow its `stepId`. Cleaned actions Claude invented from thin air (rare,
 * and explicitly forbidden by the prompt) end up with no stepId — codegen
 * just won't emit a step marker for that index, which is the same outcome
 * as a wholly stepId-less actions.json.
 *
 * The matching is forward-only so that if cleanup keeps two identical fills
 * (e.g. typing the same value twice intentionally), they're paired to the
 * first and second occurrence in the original — not both to the first.
 */
export function reattachStepIds(cleaned: TraceAction[], original: TraceAction[]): TraceAction[] {
  let cursor = 0;
  const out: TraceAction[] = [];
  for (const c of cleaned) {
    let matched: TraceAction | null = null;
    for (let i = cursor; i < original.length; i++) {
      if (sameShape(c, original[i]!)) {
        matched = original[i]!;
        cursor = i + 1;
        break;
      }
    }
    out.push(matched ? mergeFromOriginal(c, matched) : c);
  }
  return out;
}

/**
 * Merge a cleaned action back with its original counterpart. Always borrows
 * `stepId` (the cleanup prompt deliberately doesn't surface it). For `find_*`
 * actions, *also* re-attach the find-locator cluster if the cleaned copy
 * dropped any of them — Claude occasionally omits these fields under the
 * cleanup prompt and we'd otherwise emit a structurally broken action that
 * codegen has to silently skip.
 */
function mergeFromOriginal(cleaned: TraceAction, original: TraceAction): TraceAction {
  const merged: TraceAction = { ...cleaned };
  if (original.stepId && !merged.stepId) merged.stepId = original.stepId;
  if (cleaned.command.startsWith("find_")) {
    if (!merged.findLocator && original.findLocator) merged.findLocator = original.findLocator;
    if (!merged.findValue && original.findValue) merged.findValue = original.findValue;
    if (!merged.findName && original.findName) merged.findName = original.findName;
    if (merged.findIndex === undefined && original.findIndex !== undefined) merged.findIndex = original.findIndex;
    if (!merged.findExact && original.findExact) merged.findExact = original.findExact;
  }
  // The cleanup-pass LLM doesn't echo the lenient-mode `replayUnstable` /
  // `replayReason` fields the validator stamped onto the action. Without
  // restoring them here, codegen never sees the warning and the `// [warn]
  // replay-unstable: ...` comment block ends up missing from test.spec.ts.
  if (original.replayUnstable && !merged.replayUnstable) {
    merged.replayUnstable = original.replayUnstable;
    if (original.replayReason) merged.replayReason = original.replayReason;
  }
  return merged;
}

function sameShape(a: TraceAction, b: TraceAction): boolean {
  if (a.command !== b.command) return false;
  // find_* actions are identified by their locator + value. If both sides
  // carry them, require an exact match — that's how we distinguish the
  // intentionally-kept `find last [aria-label='Reply']` from the rejected
  // earlier `find text "Reply"`. If the cleaned side dropped them (the LLM
  // sometimes does — these fields aren't visible in older trained behaviour),
  // fall through to a command-only match so reattachStepIds can still locate
  // the original and `mergeFromOriginal` can restore the missing fields.
  if (a.command.startsWith("find_") && a.findLocator && b.findLocator) {
    return (
      (a.findLocator ?? "") === (b.findLocator ?? "") &&
      (a.findValue ?? "") === (b.findValue ?? "")
    );
  }
  if (a.command.startsWith("find_")) return true;
  return (
    (a.selector ?? "") === (b.selector ?? "") &&
    (a.value ?? "") === (b.value ?? "") &&
    (a.assertType ?? "") === (b.assertType ?? "")
  );
}
