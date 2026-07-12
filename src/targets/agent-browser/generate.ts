import { readFile } from "node:fs/promises";
import { loadAllBlocks, saveTestScript } from "../../store/index.ts";
import { actionsToScript, type EmptyStepNotice } from "../../codegen/actions-to-script.ts";
import { cleanupActions as runActionCleanup } from "../../codegen/cleanup.ts";
import { expandSpec, type ExpandedActionStep } from "../../spec/expand.ts";
import { bundledVitestConfigPath } from "../../runtime/bundled-config.ts";
import { spawnVitestTeed } from "../../runtime/spawn-vitest.ts";
import { runAutoFixLoop, type RunVitestResult } from "../../diagnose/loop.ts";
import { closeSession } from "../../diagnose/snapshot.ts";
import type { RecordedAction } from "../../types.ts";
import type { GenerateContext, GenerateResult } from "../types.ts";
import * as log from "../../cli/logger.ts";

/**
 * The agent-browser generation body: cleanup → step markers → codegen →
 * vitest → auto-fix loop. Extracted from the `ccqa generate` CLI action so
 * the target plugin owns the pipeline while the CLI keeps argument handling,
 * the overwrite confirmation, and exit-code policy.
 */
export async function generateAgentBrowserTest(ctx: GenerateContext): Promise<GenerateResult> {
  const { spec, featureName, specName, cwd, fix } = ctx;
  const actions = ctx.recording;
  if (!actions) {
    throw new Error(
      `the agent-browser target needs a recording — run \`ccqa record ${featureName}/${specName}\` first`,
    );
  }

  const blocks = await loadAllBlocks(cwd);
  const expanded = expandSpec(spec, { blocks });

  log.meta("steps", expanded.length);
  log.meta("fix-mode", fix.mode);
  log.meta("language", ctx.language);
  log.blank();

  const cleanedActions = await cleanupActions(actions, ctx.model);
  if (cleanedActions.length !== actions.length) {
    log.meta("cleaned", cleanedActions.length);
  }

  const markers = buildStepMarkers(expanded, cleanedActions);
  const emptySteps = findEmptySteps(expanded, cleanedActions);
  const warnings = emptySteps.map(
    (e) => `step ${e.stepId} has no kept actions — generated test will skip it (notice comment inserted).`,
  );
  for (const w of warnings) log.warn(w);

  const script = actionsToScript({
    actions: cleanedActions,
    testName: spec.title,
    stepMarkers: markers,
    emptySteps,
  });
  const scriptPath = await saveTestScript(featureName, specName, script, cwd);
  log.meta("saved", scriptPath);
  log.blank();

  // Pin the agent-browser session so we can re-attach for snapshot capture
  // after a vitest failure. The generated script reads AGENT_BROWSER_SESSION
  // via `||=`, so this value flows through unmodified. `--no-snapshot`
  // disables both the pin and the post-failure snapshot, restoring the
  // pre-snapshot behavior for debugging.
  const agentBrowserSession = fix.useSnapshot ? `ccqa-generate-${Date.now()}` : undefined;
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
    let passed = initialRun.exitCode === 0;
    if (!passed) {
      passed = await runAutoFixLoop({
        scriptPath,
        initialRun,
        specYaml: ctx.specYaml,
        actions: cleanedActions,
        maxRetries: fix.maxRetries,
        mode: fix.mode,
        runVitest: runVitestForSession,
        agentBrowserSession,
        outputLanguage: ctx.language,
        model: ctx.model,
      });
    }
    return {
      files: [{ path: scriptPath, kind: "test" }],
      summary: `test.spec.ts generated from ${cleanedActions.length} recorded action(s)`,
      warnings,
      passed,
    };
  } finally {
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    if (agentBrowserSession) await closeSession(agentBrowserSession);
  }
}

/**
 * Build the per-step markers consumed by the emitters (`actionsToScript`,
 * the playwright mechanical emit). Each action's `stepId` (assigned at trace
 * time from the last `STEP_START|...` line) groups contiguous actions; we
 * emit one marker at the first action of each contiguous run. Unknown step
 * ids are skipped rather than mis-labelled.
 */
export function buildStepMarkers(
  steps: ExpandedActionStep[],
  actions: RecordedAction[],
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
  cleanedActions: RecordedAction[],
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

async function cleanupActions(actions: RecordedAction[], model?: string): Promise<RecordedAction[]> {
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
 * with the same `action` + `locator` + `value` + `assert` shape, and
 * borrow its `stepId`. Cleaned actions Claude invented from thin air (rare,
 * and explicitly forbidden by the prompt) end up with no stepId — codegen
 * just won't emit a step marker for that index, which is the same outcome
 * as a wholly stepId-less ir.json.
 *
 * The matching is forward-only so that if cleanup keeps two identical fills
 * (e.g. typing the same value twice intentionally), they're paired to the
 * first and second occurrence in the original — not both to the first.
 */
export function reattachStepIds(cleaned: RecordedAction[], original: RecordedAction[]): RecordedAction[] {
  let cursor = 0;
  const out: RecordedAction[] = [];
  for (const c of cleaned) {
    let matched: RecordedAction | null = null;
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
 * `stepId` (the cleanup prompt deliberately doesn't surface it), and
 * re-attaches the `locator` / `index` cluster if the cleaned copy dropped
 * it — Claude occasionally omits these fields under the cleanup prompt and
 * we'd otherwise emit a structurally broken action that codegen has to
 * surface as a dropped-action warning.
 */
function mergeFromOriginal(cleaned: RecordedAction, original: RecordedAction): RecordedAction {
  const merged: RecordedAction = { ...cleaned };
  if (original.stepId && !merged.stepId) merged.stepId = original.stepId;
  if (!merged.locator && original.locator) {
    merged.locator = original.locator;
    if (merged.index === undefined && original.index !== undefined) merged.index = original.index;
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

function sameShape(a: RecordedAction, b: RecordedAction): boolean {
  if (a.action !== b.action) return false;
  // Locators identify the action. If both sides carry one, require a match
  // on strategy + value — that's how we distinguish the intentionally-kept
  // `index: "last"` pick from a rejected earlier text-locator attempt. If
  // the cleaned side dropped its locator (the LLM sometimes does), fall
  // through to a value/assert match so reattachStepIds can still locate the
  // original and `mergeFromOriginal` can restore the missing cluster.
  if (a.locator && b.locator && (a.locator.by !== b.locator.by || a.locator.value !== b.locator.value)) {
    return false;
  }
  return (
    (a.value ?? "") === (b.value ?? "") &&
    (a.assert ?? "") === (b.assert ?? "")
  );
}
