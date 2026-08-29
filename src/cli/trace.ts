import { buildTraceSystemPrompt, buildTracePrompt, generateSessionName } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  loadAllBlocks,
  loadPromptBundleFromHub,
  readSpecFile,
  saveFailedRecording,
  saveRecording,
} from "../store/index.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import type { RunTeardown } from "./run-teardown.ts";
import type { HubContext } from "./hub-conn.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  collectIncludedBlockNames,
  expandSpec,
  isExpandedActionStep,
} from "../spec/expand.ts";
import { agentBrowserInvokeBase } from "../claude/agent-browser-invoke.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";
import { validateActions, type ValidationMode } from "../runtime/replay-validate.ts";
import { buildSpecEnvScrub, scrubEnvValues } from "../runtime/env-scrub.ts";
import { formatUnstableDrop, scrubUnstableActions } from "../runtime/literal-scrub.ts";
import { languageDirective } from "../prompts/language.ts";
import { parseAbActionLine, promoteMarkedAssert } from "../ir/from-agent-browser.ts";
import { describeLocator, locatorToSelector } from "../ir/to-agent-browser.ts";
import type { Locator, RecordedAction } from "../ir/types.ts";
import type { ParsedStatusLine } from "../types.ts";
import * as log from "./logger.ts";

/**
 * Per-step churn counts. `recorded` vs `kept` is emit-then-drop waste (a
 * selector that failed and was dropped); `redundant` is fields entered through
 * 2+ selectors that BOTH survived. Both signal steps the record playbook should
 * learn to skip.
 */
export interface StepChurn {
  recorded: number;
  kept: number;
  redundant: number;
}

export interface RunTraceResult {
  /** Overall run status, derived from the status-line protocol. */
  status: "passed" | "failed";
  /**
   * Every STEP_START / STEP_DONE / ASSERTION_FAILED / STEP_SKIPPED /
   * RUN_COMPLETED line captured from the trace, in order. The record
   * agent-prompt refresh reconstructs its per-step narrative from these.
   */
  statusLines: ParsedStatusLine[];
  /**
   * Number of actions kept after scrub / dedup / validation. On a FAILED
   * trace the replay validation is skipped (unless `validateFailedTrace`
   * asked for it), so these are the scrub+dedup survivors, untagged.
   */
  actionsKept: number;
  /** Total actions emitted before scrub / dedup / validation. */
  actionsRecorded: number;
  /**
   * The kept actions themselves (post scrub / dedup / validation), in order.
   * The record agent-prompt refresh needs the concrete commands + selectors
   * that survived — the status-line prose alone doesn't carry them, so
   * without this the learner can't name the canonical selector it's told
   * to record.
   */
  actions: RecordedAction[];
  /** Per-step churn (see {@link StepChurn}), keyed by stepId. */
  churnByStep: Map<string, StepChurn>;
}

export interface RunTraceOptions {
  cwd?: string;
  hubContext?: HubContext | null;
  /** Extra caller guidance appended to the trace system prompt (`--instruction`). */
  instruction?: string;
  /**
   * Called whenever the trace advances to a new spec step. Lets the caller
   * know which step was in flight when a signal killed the process — the
   * trace's own result never materialises on that path.
   */
  onStep?: (stepId: string) => void;
  /**
   * When given, the trace registers its agent-browser sessions here so a
   * signal or `--timeout` reaps them; the normal path closes them itself as
   * soon as the browser work is done.
   */
  teardown?: RunTeardown;
  /**
   * Run the post-trace replay validation even when the trace FAILED. A
   * failed trace generates no code, so the replay is normally skipped — but
   * the trace learner reads its stability tags, so the caller sets this
   * when learning is enabled.
   */
  validateFailedTrace?: boolean;
}

/**
 * Step ids (in spec order) whose kept actions include no assertion. A step
 * with none produced a test that performs the step but verifies nothing
 * about its `expected` — surfaced as a per-step warning after validation.
 */
export function stepsWithoutAsserts(stepIds: string[], actions: RecordedAction[]): string[] {
  const withAssert = new Set(
    actions.filter((a) => a.action === "assert" && a.stepId !== undefined).map((a) => a.stepId),
  );
  return stepIds.filter((id) => !withAssert.has(id));
}

export async function runTrace(
  featureName: string,
  specName: string,
  model?: string,
  validationMode: ValidationMode = "lenient",
  language?: string,
  opts: RunTraceOptions = {},
): Promise<RunTraceResult> {
  log.header("trace", `${featureName}/${specName}`);

  await preflightAgentBrowserCommand();

  const specContent = await readSpecFile(featureName, specName, opts.cwd);
  const spec = parseTestSpec(specContent);
  const blocks = await loadAllBlocks(opts.cwd);
  // A judge step records nothing: it states a claim about the page rather than
  // an action to replay, and the generator places the call from the step list.
  // Refusing one here would make a spec that carries a claim unrecordable.
  const expanded = expandSpec(spec, { blocks });
  const steps = expanded.filter(isExpandedActionStep);

  // Build the env-value → `${VAR}` scrub map BEFORE the trace starts so
  // every recorded action (whether routed through the PreToolUse Bash hook
  // or via Claude's `AB_ACTION|...` text emissions) gets its concrete
  // env-derived values replaced with the symbolic form. Without this,
  // `abAssertTextVisible` and similar text-channel actions land in
  // ir.json with the literal trace-time value (e.g. a per-run id),
  // which then bakes into test.spec.ts and breaks `ccqa run` whenever the
  // env value changes.
  const sessionName = generateSessionName();
  // The trace child always runs with CCQA_RUN_ID set to the session name
  // (agentBrowserInvokeBase below), whatever the parent env holds — the
  // override keeps `${CCQA_RUN_ID}` scrubbing against the value the child
  // actually sees.
  const envScrub = buildSpecEnvScrub(spec, expanded, { CCQA_RUN_ID: sessionName });
  const envScrubMap = envScrub.map;
  if (envScrub.unresolved.length > 0) {
    // An unset ref can't be scrubbed, so it bakes in (see above). Surface that
    // loudly and actionably rather than as a single passing note.
    log.warn(
      `spec references env var(s) that are unset at record time: ${envScrub.unresolved.join(", ")}`,
    );
    log.warn(
      "their concrete trace-time values (e.g. navigate URLs) will be baked into ir.json instead of kept as ${VAR}, so the recording won't switch across environments.",
    );
    log.hint(
      "load these vars before recording — pass --profile <name> (hub) or define them in .env — then re-record.",
    );
  }

  log.meta("spec", spec.title);
  log.meta("steps", steps.length);
  const includes = collectIncludedBlockNames(spec);
  if (includes.length > 0) log.meta("blocks", includes.join(", "));
  log.blank();

  opts.teardown?.trackSession(sessionName);

  const baseSystemPrompt = buildTraceSystemPrompt({
    title: spec.title,
    steps,
    sessionName,
    ...(opts.instruction ? { instruction: opts.instruction } : {}),
  });
  const promptBundle = await loadPromptBundleFromHub(opts.hubContext ?? null, "record");
  if (promptBundle !== null) log.meta("prompt", promptBundle.loaded.join(" + "));
  const systemPrompt =
    (promptBundle === null
      ? baseSystemPrompt
      : `${baseSystemPrompt}\n## Project-specific guidance\n\n${promptBundle.text}\n`) +
    languageDirective(language);
  const prompt = buildTracePrompt(spec.title);

  log.info("Running agent-browser session...");
  log.blank();

  const statusLines: ParsedStatusLine[] = [];
  let overallStatus: "passed" | "failed" = "passed";
  const traceActions: RecordedAction[] = [];
  // Tags each recorded action with its spec step so codegen can group by
  // step even when a step opens no URL (e.g. a "fill the form" step
  // sandwiched between a `navigate` step and a navigation).
  const stepTracker = createStepTracker(opts.onStep);

  const withStepId = (action: RecordedAction | null, stepId: string | undefined): RecordedAction | null => {
    if (!action) return null;
    return stepId ? { ...action, stepId } : action;
  };

  // How many actions the most recent command event pushed, so a failed
  // command rolls back exactly its own contribution — a promoted
  // `url_contains:` marker pushes two actions, an unparseable command none.
  let lastCommandPushCount = 0;

  const { isError } = await invokeClaudeStreaming(
    {
      prompt,
      systemPrompt,
      ...agentBrowserInvokeBase({ sessionName, runId: sessionName }),
      model,
      envScrubMap,
      onAbAction: ({ abAction, stepId, assertMarker }) => {
        const stepForCommand = stepTracker.fromCommand(stepId);
        const line = abAction === undefined ? null : scrubEnvValues(abAction, envScrubMap);
        let recorded: RecordedAction[] | null = null;
        if (assertMarker !== undefined) {
          recorded = promoteMarkedAssert(line, scrubEnvValues(assertMarker, envScrubMap));
          if (recorded === null) {
            log.warn(
              `CCQA_ASSERT=${assertMarker} does not match a promotable command (wait --text / get count / url_contains:<substring>) — recording the command without an assert`,
            );
          }
        }
        if (recorded === null) {
          const parsed = line === null ? null : parseAbActionLine(line);
          recorded = parsed === null ? [] : [parsed];
        }
        let pushed = 0;
        for (const action of recorded) {
          const stamped = withStepId(action, stepForCommand);
          if (stamped) {
            traceActions.push(stamped);
            pushed += 1;
          }
        }
        lastCommandPushCount = pushed;
      },
      onAbActionFailed: () => {
        if (lastCommandPushCount > 0) traceActions.splice(-lastCommandPushCount);
        lastCommandPushCount = 0;
      },
    },
    (msg: SDKMessage) => {
      if (msg.type !== "assistant") return;

      for (const block of msg.message.content ?? []) {
        if (block.type !== "text" || !block.text) continue;

        // Walk lines in order so STEP_START advances the step tracker before
        // any subsequent AB_ACTION on the same block is processed.
        for (const line of block.text.split("\n")) {
          const trimmed = line.trim();
          const status = parseStatusLine(line);
          if (status) {
            if (status.type === "STEP_START" && status.stepId) {
              stepTracker.fromStepStartLine(status.stepId);
            }
            if (status.type === "ASSERTION_FAILED") overallStatus = "failed";
            if (status.type === "RUN_COMPLETED" && status.stepId === "failed") overallStatus = "failed";
            statusLines.push(status);
            log.step(status.type, status.stepId, status.detail);
            continue;
          }
          if (trimmed.startsWith("AB_ACTION|snapshot|") || trimmed.startsWith("AB_ACTION|assert|")) {
            const action = withStepId(
              parseAbActionLine(scrubEnvValues(trimmed, envScrubMap)),
              stepTracker.current(),
            );
            if (action) traceActions.push(action);
          }
        }
      }
    },
  );

  if (isError) overallStatus = "failed";

  const scrubbedActions = scrubAndReport(traceActions);
  const dedupedActions = dedupAndReport(scrubbedActions);
  // A FAILED trace's actions are diagnosis material, not a test in the
  // making — nothing is generated from them, so the browser replay's
  // stability tags usually buy minutes of browser time for nobody. The one
  // consumer left is the trace learner, which reads unstable tags to avoid
  // canonicalizing a flaky selector — so the caller opts back in via
  // `validateFailedTrace` when learning is on. The replay resolves
  // `${CCQA_RUN_ID}` to the trace's own value, so it hits the same DOM
  // state the trace recorded against.
  const validatedActions =
    overallStatus === "passed" || opts.validateFailedTrace === true
      ? validateAndReport(dedupedActions, validationMode, { CCQA_RUN_ID: sessionName }, opts.teardown)
      : dedupedActions;

  // The trace session is done with the browser — close it now (best-effort,
  // no need to wait) rather than at process end, so no Chrome lingers
  // through the generate / auto-fix half. The teardown registration above
  // stays as the backstop for the paths that never reach here.
  void (opts.teardown?.closeTracked(sessionName) ?? closeSession(sessionName));

  // A FAILED trace did not demonstrate the spec, so its actions must never
  // replace a recording that did. They go to a side file for diagnosis;
  // ir.json (and therefore the generated test) is left untouched.
  const recordingPath =
    overallStatus === "passed"
      ? await saveRecording(featureName, specName, validatedActions, opts.cwd)
      : await saveFailedRecording(featureName, specName, validatedActions, opts.cwd);

  log.blank();
  log.meta("saved", recordingPath);
  log.meta("actions", validatedActions.length);
  log.meta("status", overallStatus.toUpperCase());

  if (overallStatus === "passed") {
    // A step whose actions carry no assertion produced a test that performs
    // the step but verifies nothing about its `expected` — the kind of green
    // that reads as coverage. Loud, per step, before codegen runs.
    for (const stepId of stepsWithoutAsserts(steps.map((s) => s.id), validatedActions)) {
      log.warn(`${stepId} recorded no assertion — nothing in the generated test verifies its 'expected'`);
    }
    log.hint(`run 'ccqa generate ${featureName}/${specName}' to generate a test script`);
  } else {
    log.warn(
      "trace FAILED — the recorded actions were saved beside the spec for diagnosis; the previous ir.json and generated code are left untouched",
    );
  }

  return {
    status: overallStatus,
    statusLines,
    actionsKept: validatedActions.length,
    actionsRecorded: traceActions.length,
    actions: validatedActions,
    churnByStep: buildChurnByStep(traceActions, validatedActions),
  };
}

/**
 * Per-step churn: `recorded` (raw trace before scrub) vs `kept` (survivors) —
 * their delta is emit-then-drop waste — plus `redundant`, the count of fields
 * entered through 2+ selectors that both survived (`countRedundantByStep`).
 * Spans scrub + dedup + validate, unlike `reportPerStepBreakdown` which only
 * covers the validation stage.
 */
function buildChurnByStep(raw: RecordedAction[], kept: RecordedAction[]): Map<string, StepChurn> {
  const recordedByStep = groupCountByStep(raw);
  const keptByStep = groupCountByStep(kept);
  const redundantByStep = countRedundantByStep(kept);
  const churn = new Map<string, StepChurn>();
  for (const [stepId, recorded] of recordedByStep) {
    churn.set(stepId, {
      recorded,
      kept: keptByStep.get(stepId) ?? 0,
      redundant: redundantByStep.get(stepId) ?? 0,
    });
  }
  return churn;
}

/** Input actions whose `.value` holds the typed text (the cross-command key). */
const INPUT_ACTIONS = new Set<RecordedAction["action"]>(["fill", "type"]);

/**
 * Stable string form of a locator (with its positional index) used to tell
 * whether two actions reached their target the same way.
 */
function locatorSignature(locator: Locator | undefined, index: RecordedAction["index"]): string {
  if (!locator) return "";
  const name = locator.by === "role" ? locator.name ?? "" : "";
  const exact = locator.by !== "css" && locator.exact ? "exact" : "";
  return `${locator.by}:${locator.value}:${name}:${exact}:${index ?? ""}`;
}

/**
 * A value too generic to prove two fills hit the *same* field. `${VAR}` refs
 * are always significant (distinct vars = distinct fields); bare numbers and
 * very short literals collide legitimately (e.g. "100" into two amount fields),
 * so they don't count as redundancy.
 */
function isTrivialValue(v: string): boolean {
  const t = v.trim();
  if (t.length === 0) return true;
  if (/^\$\{?\w+\}?$/.test(t)) return false;
  return t.length < 3 || /^-?\d+(\.\d+)?$/.test(t);
}

/**
 * Per-step count of fields entered via 2+ different selectors that both
 * survived — the agent reached the same field two ways (e.g. `fill "[aria-…]"`
 * then `find label=…` with the same value) and neither was dropped, so
 * drop-churn misses it. Keyed on exact `value` equality with a triviality guard
 * to stay conservative; counts distinct values (not pairs) to avoid over-count.
 */
export function countRedundantByStep(kept: RecordedAction[]): Map<string, number> {
  const perStep = new Map<string, Map<string, Set<string>>>();
  for (const a of kept) {
    if (!INPUT_ACTIONS.has(a.action)) continue;
    const v = a.value;
    if (!v || isTrivialValue(v)) continue;
    const step = a.stepId ?? "<no step>";
    const byValue = perStep.get(step) ?? new Map<string, Set<string>>();
    const sigs = byValue.get(v) ?? new Set<string>();
    sigs.add(locatorSignature(a.locator, a.index));
    byValue.set(v, sigs);
    perStep.set(step, byValue);
  }
  const out = new Map<string, number>();
  for (const [step, byValue] of perStep) {
    let n = 0;
    for (const sigs of byValue.values()) if (sigs.size >= 2) n += 1;
    if (n > 0) out.set(step, n);
  }
  return out;
}

/**
 * Strip actions whose recorded fields contain "unstable literal" values
 * (clock readings, ISO datetimes, Unix-epoch IDs) that Claude baked into
 * the trace despite not coming through `${ENV_VAR}`. These would otherwise
 * pin the generated test to a single run. Reported the same way as
 * `validateAndReport` so users see one uniform "dropped" surface.
 */
function scrubAndReport(actions: RecordedAction[]): RecordedAction[] {
  if (actions.length === 0) return actions;
  const { kept, dropped } = scrubUnstableActions(actions);
  if (dropped.length === 0) return kept;
  log.blank();
  log.info("post-trace literal scrub (removing run-specific values)...");
  for (const d of dropped) {
    log.warn(`dropped action #${d.index + 1} (${formatUnstableDrop(d)})`);
  }
  log.meta("scrubbed", `${kept.length}/${actions.length} kept (${dropped.length} dropped)`);
  return kept;
}

/**
 * Drop *immediate* duplicate AB_ACTION emissions inside the same step.
 * Claude occasionally records the same semantic-locator click (identical
 * action, locator, value, fields) twice in a row when retrying a selector
 * after a snapshot — only the last attempt is "the canonical one". Collapsing
 * the dupes keeps ir.json from accumulating ghost-retries the LLM never
 * meant to commit.
 *
 * The dedupe is intentionally conservative — adjacent + structurally
 * IDENTICAL only. We do NOT try to compress retries with different
 * locators (that would risk dropping a legitimate "click the neighbouring
 * button" sequence). The trace prompt now asks Claude not to emit failed
 * attempts in the first place, so this is the belt-and-braces pass.
 */
function dedupAndReport(actions: RecordedAction[]): RecordedAction[] {
  if (actions.length === 0) return actions;
  const kept: RecordedAction[] = [];
  let dropped = 0;
  for (const action of actions) {
    const prev = kept[kept.length - 1];
    if (prev && isAdjacentDuplicate(prev, action)) {
      dropped += 1;
      continue;
    }
    kept.push(action);
  }
  if (dropped === 0) return kept;
  log.meta("deduped", `${kept.length}/${actions.length} kept (${dropped} adjacent duplicate(s) dropped)`);
  return kept;
}

/**
 * Two actions are an "adjacent duplicate" when they would generate the
 * exact same agent-browser invocation. We compare by action + every
 * field that drives codegen output, sharing the same stepId (so we don't
 * silently merge two distinct steps that happen to start identically).
 */
function isAdjacentDuplicate(a: RecordedAction, b: RecordedAction): boolean {
  if (a.action !== b.action) return false;
  if ((a.stepId ?? "") !== (b.stepId ?? "")) return false;
  return (
    locatorSignature(a.locator, a.index) === locatorSignature(b.locator, b.index) &&
    (a.value ?? "") === (b.value ?? "") &&
    locatorSignature(a.target, undefined) === locatorSignature(b.target, undefined) &&
    (a.label ?? "") === (b.label ?? "") &&
    (a.assert ?? "") === (b.assert ?? "") &&
    (a.files ?? []).join("|") === (b.files ?? []).join("|")
  );
}

/**
 * Run the post-trace replay validation and emit user-visible drop reports.
 * Splitting this out keeps `runTrace` readable; side effects are `log.*`,
 * the agent-browser invocations inside `validateActions`, and the replay
 * session's registration/close on `teardown`.
 *
 * In lenient mode (the default) failing actions are NOT removed — they're
 * tagged with `replayUnstable: true` and merged back into the output stream
 * in their original order so codegen can still emit them (with a `// [warn]`
 * comment) and let the auto-fix loop decide what to do.
 */
function validateAndReport(
  actions: RecordedAction[],
  mode: ValidationMode,
  envOverrides: Record<string, string>,
  teardown?: RunTeardown,
): RecordedAction[] {
  if (actions.length === 0) return actions;
  const sessionName = `${generateSessionName()}-validate`;
  teardown?.trackSession(sessionName);
  log.blank();
  log.info(`post-trace validation in ${mode} mode (replaying ${actions.length} recorded action(s))...`);
  const { kept, unstable, dropped, rescuedSteps = [] } = validateActions(actions, {
    sessionName,
    mode,
    envOverrides,
    onProgress: (i, total, action) => {
      log.progress(i, total, validationProgressLabel(action));
    },
  });
  // The replay session is done — close it here (best-effort, no need to
  // wait) instead of leaving an idle browser to the end of the process. A
  // throw above is covered by the teardown registration, which reaps every
  // still-tracked session.
  void (teardown?.closeTracked(sessionName) ?? closeSession(sessionName));
  log.progressEnd();
  if (rescuedSteps.length > 0) {
    log.info(`rescued ${rescuedSteps.length} step(s) that had lost every action: ${rescuedSteps.join(", ")}`);
  }
  if (mode === "lenient") {
    if (unstable.length === 0) {
      log.meta("validated", `${kept.length}/${actions.length} kept`);
    } else {
      for (const u of unstable) {
        const head = `${u.action}${u.locator ? " " + describeLocator(u.locator) : ""}`;
        log.warn(`replay-unstable: ${head} — ${u.replayReason ?? "(no reason)"} (kept in ir.json with warning)`);
      }
      log.meta(
        "validated",
        `${kept.length}/${actions.length} kept, ${unstable.length} flagged replay-unstable (kept with warning)`,
      );
    }
    // Lenient mode: thread the kept + unstable back into the original
    // sequence so codegen sees the spec's narrative intact.
    const merged = mergeKeptAndUnstableInOriginalOrder(actions, kept, unstable);
    reportPerStepBreakdown(actions, merged);
    return merged;
  }
  // Strict mode: legacy behaviour — drop failing actions, log cascades.
  if (dropped.length === 0) {
    log.meta("validated", `${kept.length}/${actions.length} kept`);
    reportPerStepBreakdown(actions, kept);
    return kept;
  }
  let cascadeStart: number | null = null;
  let cascadeCount = 0;
  let cascadeStepId: string | undefined;
  const flushCascade = (): void => {
    if (cascadeStart === null || cascadeCount === 0) return;
    const stepTag = cascadeStepId ? ` in ${cascadeStepId}` : "";
    log.warn(`cascade dropped ${cascadeCount} action(s)${stepTag} after action #${cascadeStart}`);
    cascadeStart = null;
    cascadeCount = 0;
    cascadeStepId = undefined;
  };
  for (const d of dropped) {
    const isCascade = d.reason.startsWith("skipped after");
    if (isCascade && cascadeStart !== null && cascadeStepId === d.action.stepId) {
      cascadeCount += 1;
      continue;
    }
    flushCascade();
    if (isCascade) {
      cascadeStart = d.index;
      cascadeCount = 1;
      cascadeStepId = d.action.stepId;
      continue;
    }
    log.warn(`dropped action #${d.index + 1} (${d.action.action}${d.action.locator ? " " + describeLocator(d.action.locator) : ""}): ${d.reason}`);
  }
  flushCascade();
  log.meta("validated", `${kept.length}/${actions.length} kept (${dropped.length} dropped)`);
  reportPerStepBreakdown(actions, kept);
  return kept;
}

/**
 * Lenient-mode helper: re-thread the `kept` and `unstable` lists back into
 * the original recording order. Object identity is fine because the
 * validator pushes original references — no shallow copies.
 */
function mergeKeptAndUnstableInOriginalOrder(
  originalActions: RecordedAction[],
  kept: RecordedAction[],
  unstable: RecordedAction[],
): RecordedAction[] {
  const allowed = new Set<RecordedAction>([...kept, ...unstable]);
  const merged: RecordedAction[] = [];
  for (const a of originalActions) {
    if (allowed.has(a)) merged.push(a);
  }
  return merged;
}

/**
 * Compact one-liner used as the progress label while validation replays
 * each action. Keep it under ~80 chars so it fits on a single terminal
 * row when paired with the `[info] N/M ` prefix.
 */
function validationProgressLabel(action: RecordedAction): string {
  const step = action.stepId ? `${action.stepId} ` : "";
  const detail = action.locator
    ? `${action.action} ${locatorToSelector(action.locator)}`
    : action.value
      ? `${action.action} ${action.value}`
      : action.action;
  const trimmed = detail.length > 80 ? detail.slice(0, 77) + "..." : detail;
  return `${step}${trimmed}`;
}

/**
 * Print a per-step `kept/total` line so a step that lost ALL its actions
 * during validation surfaces clearly. Without this, a spec author can't
 * tell that "verify created content" or "delete the thing" silently fell
 * off the generated test — the trace appears to pass while half the spec
 * is missing. Lost steps are also surfaced as a dedicated warning line so
 * they don't blend into the per-step breakdown noise.
 */
function reportPerStepBreakdown(beforeValidation: RecordedAction[], afterValidation: RecordedAction[]): void {
  const before = groupCountByStep(beforeValidation);
  const after = groupCountByStep(afterValidation);
  // Walk in the order step ids first appeared in the trace so output
  // matches the spec narrative.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const a of beforeValidation) {
    const id = a.stepId ?? "<no step>";
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const lostSteps: string[] = [];
  for (const id of ordered) {
    const total = before.get(id) ?? 0;
    const kept = after.get(id) ?? 0;
    const dropped = total - kept;
    const isLost = kept === 0 && total > 0 && id !== "<no step>";
    if (isLost) lostSteps.push(id);
    const tag = isLost ? " ⚠ entire step removed" : "";
    log.meta(`  ${id}`, `${kept}/${total} kept${dropped > 0 ? `, ${dropped} dropped` : ""}${tag}`);
  }
  if (lostSteps.length > 0) {
    log.warn(`${lostSteps.length} spec step(s) lost every recorded action: ${lostSteps.join(", ")} — the generated test will NOT exercise these steps.`);
  }
}

function groupCountByStep(actions: RecordedAction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const id = a.stepId ?? "<no step>";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Tracks which spec step incoming actions belong to. Two channels feed it:
 *
 * - `fromCommand` — the `CCQA_STEP=<step-id>` env prefix the PreToolUse hook
 *   parses off each agent-browser command. Authoritative: it travels on the
 *   same channel as the command itself, so it can't desync from the actions.
 * - `fromStepStartLine` — the `STEP_START|...` text protocol. Fallback only:
 *   models often skip protocol text during long tool-call loops.
 *
 * A command-channel id also advances the current step so later text-channel
 * lines (`AB_ACTION|assert|...`) attach to the right step even when
 * STEP_START was never printed.
 */
export interface StepTracker {
  current: () => string | undefined;
  fromStepStartLine: (stepId: string) => void;
  /** Returns the step to attach to the action recorded from this command. */
  fromCommand: (stepId: string | undefined) => string | undefined;
}

export function createStepTracker(onChange?: (stepId: string) => void): StepTracker {
  let currentStepId: string | undefined;
  const advance = (stepId: string): void => {
    if (stepId === currentStepId) return;
    currentStepId = stepId;
    onChange?.(stepId);
  };
  return {
    current: () => currentStepId,
    fromStepStartLine: advance,
    fromCommand: (stepId) => {
      if (stepId) advance(stepId);
      return currentStepId;
    },
  };
}

export function parseStatusLine(text: string): ParsedStatusLine | null {
  for (const line of text.split("\n")) {
    const match = line.match(/^(STEP_START|STEP_DONE|ASSERTION_FAILED|STEP_SKIPPED|RUN_COMPLETED)\|([^|]*)\|(.*)$/);
    if (match) {
      return {
        type: match[1] as ParsedStatusLine["type"],
        stepId: match[2] ?? "",
        detail: match[3] ?? "",
      };
    }
  }
  return null;
}

