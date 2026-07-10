import { buildTraceSystemPrompt, buildTracePrompt, generateSessionName } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  loadAllBlocks,
  loadPromptBundleFromHub,
  readSpecFile,
  saveRoute,
  saveTraceActions,
  updateSpecRelatedPaths,
} from "../store/index.ts";
import type { HubContext } from "./hub-conn.ts";
import { parseRelatedPathsBlock } from "../drift/parse-related-paths.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { collectIncludedBlockNames, expandSpec } from "../spec/expand.ts";
import { agentBrowserInvokeBase } from "../claude/agent-browser-invoke.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";
import { validateActions, type ValidationMode } from "../runtime/replay-validate.ts";
import { buildSpecEnvScrub, scrubEnvValues } from "../runtime/env-scrub.ts";
import { formatUnstableDrop, scrubUnstableActions } from "../runtime/literal-scrub.ts";
import { languageDirective } from "../prompts/language.ts";
import { FIND_LOCATORS } from "../types.ts";
import type {
  Route,
  RouteStep,
  TraceAction,
  TraceCommand,
  AssertType,
  FindLocator,
  ParsedStatusLine,
} from "../types.ts";
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
  /** RouteStep list captured from ROUTE_STEP lines, in order. */
  route: Route;
  /** Number of TraceActions kept after scrub / dedup / validation. */
  actionsKept: number;
  /** Total TraceActions emitted before scrub / dedup / validation. */
  actionsRecorded: number;
  /**
   * The kept actions themselves (post scrub / dedup / validation), in order.
   * The record agent-prompt refresh needs the concrete commands + selectors
   * that survived — the RouteStep prose alone doesn't carry them, so without
   * this the learner can't name the canonical selector it's told to record.
   */
  actions: TraceAction[];
  /** Per-step churn (see {@link StepChurn}), keyed by stepId. */
  churnByStep: Map<string, StepChurn>;
}

export async function runTrace(
  featureName: string,
  specName: string,
  model?: string,
  validationMode: ValidationMode = "lenient",
  language?: string,
  opts: { cwd?: string; hubContext?: HubContext | null } = {},
): Promise<RunTraceResult> {
  log.header("trace", `${featureName}/${specName}`);

  await preflightAgentBrowserCommand();

  const specContent = await readSpecFile(featureName, specName, opts.cwd);
  const spec = parseTestSpec(specContent);
  const blocks = await loadAllBlocks(opts.cwd);
  const expanded = expandSpec(spec, { blocks });

  // Build the env-value → `${VAR}` scrub map BEFORE the trace starts so
  // every recorded action (whether routed through the PreToolUse Bash hook
  // or via Claude's `AB_ACTION|...` text emissions) gets its concrete
  // env-derived values replaced with the symbolic form. Without this,
  // `abAssertTextVisible` and similar text-channel actions land in
  // actions.json with the literal trace-time value (e.g. a per-run id),
  // which then bakes into test.spec.ts and breaks `ccqa run` whenever the
  // env value changes.
  const envScrub = buildSpecEnvScrub(spec, expanded);
  const envScrubMap = envScrub.map;
  if (envScrub.unresolved.length > 0) {
    log.warn(
      `spec references env var(s) with empty/unset values: ${envScrub.unresolved.join(", ")} — their literal trace-time values will be baked into actions.json`,
    );
  }

  log.meta("spec", spec.title);
  log.meta("steps", expanded.length);
  const includes = collectIncludedBlockNames(spec);
  if (includes.length > 0) log.meta("blocks", includes.join(", "));
  log.blank();

  const sessionName = generateSessionName();

  const baseSystemPrompt = buildTraceSystemPrompt({
    title: spec.title,
    steps: expanded,
    sessionName,
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

  const routeSteps: RouteStep[] = [];
  let overallStatus: "passed" | "failed" = "passed";
  const traceActions: TraceAction[] = [];
  // Tagged onto each recorded action so codegen can group by step even when
  // a step opens no URL (e.g. a "fill the form" step sandwiched between an
  // `open` step and a navigation).
  let currentStepId: string | undefined;
  // Only captures text from RELATED_PATHS_BEGIN onward so a long trace doesn't
  // accumulate every assistant message in memory just to extract one block.
  let relatedPathsBuffer: string | null = null;

  const withStepId = (action: TraceAction | null): TraceAction | null => {
    if (!action) return null;
    return currentStepId ? { ...action, stepId: currentStepId } : action;
  };

  const { isError } = await invokeClaudeStreaming(
    {
      prompt,
      systemPrompt,
      ...agentBrowserInvokeBase({ sessionName, runId: sessionName }),
      model,
      onAbAction: (abAction: string) => {
        const action = withStepId(parseAbAction(scrubEnvValues(abAction, envScrubMap)));
        if (action) traceActions.push(action);
      },
      onAbActionFailed: () => {
        traceActions.pop();
      },
    },
    (msg: SDKMessage) => {
      if (msg.type !== "assistant") return;

      for (const block of msg.message.content ?? []) {
        if (block.type !== "text" || !block.text) continue;
        const text = block.text;
        if (relatedPathsBuffer !== null) {
          relatedPathsBuffer += text + "\n";
        } else {
          const idx = text.indexOf("RELATED_PATHS_BEGIN");
          if (idx !== -1) relatedPathsBuffer = text.slice(idx) + "\n";
        }

        // Walk lines in order so STEP_START updates currentStepId before any
        // subsequent AB_ACTION/ROUTE_STEP on the same block are processed.
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          const status = parseStatusLine(line);
          if (status) {
            if (status.type === "STEP_START" && status.stepId) {
              currentStepId = status.stepId;
            }
            log.step(status.type, status.stepId, status.detail);
            continue;
          }
          if (trimmed.startsWith("ROUTE_STEP|")) {
            const routeStep = parseRouteStep(trimmed);
            if (routeStep) {
              routeSteps.push(routeStep);
              if (routeStep.status === "FAILED") overallStatus = "failed";
            }
          } else if (trimmed.startsWith("AB_ACTION|snapshot|") || trimmed.startsWith("AB_ACTION|assert|")) {
            const action = withStepId(parseAbAction(scrubEnvValues(trimmed, envScrubMap)));
            if (action) traceActions.push(action);
          }
        }
      }
    },
  );

  if (isError) overallStatus = "failed";

  const scrubbedActions = scrubAndReport(traceActions);
  const dedupedActions = dedupAndReport(scrubbedActions);
  const validatedActions = validateAndReport(dedupedActions, validationMode);

  const timestamp = new Date().toISOString();
  const route: Route = { specName, timestamp, status: overallStatus, steps: routeSteps };

  const [routePath, actionsPath] = await Promise.all([
    saveRoute(featureName, specName, route, opts.cwd),
    saveTraceActions(featureName, specName, validatedActions, opts.cwd),
  ]);

  log.blank();
  log.meta("route", routePath);
  log.meta("saved", actionsPath);
  log.meta("actions", validatedActions.length);
  log.meta("status", overallStatus.toUpperCase());

  const relatedPaths = relatedPathsBuffer !== null
    ? parseRelatedPathsBlock(relatedPathsBuffer)
    : null;
  if (relatedPaths !== null) {
    const written = await updateSpecRelatedPaths(featureName, specName, relatedPaths, opts.cwd);
    if (written) {
      log.meta("relatedPaths", `${relatedPaths.length} path(s) written to ${written}`);
    }
  } else {
    log.warn("trace did not emit a RELATED_PATHS block; drift --changed cannot scope this spec");
  }

  log.hint(`run 'ccqa generate ${featureName}/${specName}' to generate a test script`);

  return {
    route,
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
function buildChurnByStep(raw: TraceAction[], kept: TraceAction[]): Map<string, StepChurn> {
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

/** Input commands whose `.value` holds the typed text (the cross-command key). */
const INPUT_COMMANDS = new Set<TraceCommand>(["fill", "type", "find_fill", "find_type"]);

/** How an action reaches its target — a CSS selector or a `find` locator. */
function targetSignature(a: TraceAction): string {
  return a.selector ?? `${a.findLocator ?? ""}:${a.findValue ?? ""}:${a.findName ?? ""}:${a.findIndex ?? ""}`;
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
 * then `find_fill label=…` with the same value) and neither was dropped, so
 * drop-churn misses it. Keyed on exact `value` equality with a triviality guard
 * to stay conservative; counts distinct values (not pairs) to avoid over-count.
 */
export function countRedundantByStep(kept: TraceAction[]): Map<string, number> {
  const perStep = new Map<string, Map<string, Set<string>>>();
  for (const a of kept) {
    if (!INPUT_COMMANDS.has(a.command)) continue;
    const v = a.value;
    if (!v || isTrivialValue(v)) continue;
    const step = a.stepId ?? "<no step>";
    const byValue = perStep.get(step) ?? new Map<string, Set<string>>();
    const sigs = byValue.get(v) ?? new Set<string>();
    sigs.add(targetSignature(a));
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
function scrubAndReport(actions: TraceAction[]): TraceAction[] {
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
 * Claude occasionally records the same `find_click` (identical command,
 * locator, value, fields) twice in a row when retrying a selector after a
 * snapshot — only the last attempt is "the canonical one". Collapsing the
 * dupes keeps actions.json from accumulating ghost-retries the LLM never
 * meant to commit.
 *
 * The dedupe is intentionally conservative — adjacent + structurally
 * IDENTICAL only. We do NOT try to compress retries with different
 * selectors / locators (that would risk dropping a legitimate "click the
 * neighbouring button" sequence). The trace prompt now asks Claude not to
 * emit failed attempts in the first place, so this is the belt-and-braces
 * pass.
 */
function dedupAndReport(actions: TraceAction[]): TraceAction[] {
  if (actions.length === 0) return actions;
  const kept: TraceAction[] = [];
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
 * exact same agent-browser invocation. We compare by command + every
 * field that drives codegen output, sharing the same stepId (so we don't
 * silently merge two distinct steps that happen to start identically).
 */
function isAdjacentDuplicate(a: TraceAction, b: TraceAction): boolean {
  if (a.command !== b.command) return false;
  if ((a.stepId ?? "") !== (b.stepId ?? "")) return false;
  return (
    (a.selector ?? "") === (b.selector ?? "") &&
    (a.value ?? "") === (b.value ?? "") &&
    (a.target ?? "") === (b.target ?? "") &&
    (a.label ?? "") === (b.label ?? "") &&
    (a.assertType ?? "") === (b.assertType ?? "") &&
    (a.findLocator ?? "") === (b.findLocator ?? "") &&
    (a.findValue ?? "") === (b.findValue ?? "") &&
    (a.findName ?? "") === (b.findName ?? "") &&
    (a.findIndex ?? -1) === (b.findIndex ?? -1) &&
    (a.findExact ?? false) === (b.findExact ?? false) &&
    (a.files ?? []).join("|") === (b.files ?? []).join("|")
  );
}

/**
 * Run the post-trace replay validation and emit user-visible drop reports.
 * Splitting this out keeps `runTrace` readable; the function is pure aside
 * from `log.*` and the agent-browser invocations inside `validateActions`.
 *
 * In lenient mode (the default) failing actions are NOT removed — they're
 * tagged with `replayUnstable: true` and merged back into the output stream
 * in their original order so codegen can still emit them (with a `// [warn]`
 * comment) and let the auto-fix loop decide what to do.
 */
function validateAndReport(actions: TraceAction[], mode: ValidationMode): TraceAction[] {
  if (actions.length === 0) return actions;
  const sessionName = `${generateSessionName()}-validate`;
  log.blank();
  log.info(`post-trace validation in ${mode} mode (replaying ${actions.length} recorded action(s))...`);
  const { kept, unstable, dropped, rescuedSteps = [] } = validateActions(actions, {
    sessionName,
    mode,
    onProgress: (i, total, action) => {
      log.progress(i, total, validationProgressLabel(action));
    },
  });
  log.progressEnd();
  if (rescuedSteps.length > 0) {
    log.info(`rescued ${rescuedSteps.length} step(s) that had lost every action: ${rescuedSteps.join(", ")}`);
  }
  if (mode === "lenient") {
    if (unstable.length === 0) {
      log.meta("validated", `${kept.length}/${actions.length} kept`);
    } else {
      for (const u of unstable) {
        const head = `${u.command}${u.selector ? " " + u.selector : ""}${u.findValue ? " " + u.findValue : ""}`;
        log.warn(`replay-unstable: ${head} — ${u.replayReason ?? "(no reason)"} (kept in actions.json with warning)`);
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
    log.warn(`dropped action #${d.index + 1} (${d.action.command}${d.action.selector ? " " + d.action.selector : ""}): ${d.reason}`);
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
  originalActions: TraceAction[],
  kept: TraceAction[],
  unstable: TraceAction[],
): TraceAction[] {
  const allowed = new Set<TraceAction>([...kept, ...unstable]);
  const merged: TraceAction[] = [];
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
function validationProgressLabel(action: TraceAction): string {
  const step = action.stepId ? `${action.stepId} ` : "";
  const detail = action.findLocator
    ? `find ${action.findLocator} ${action.findValue ?? ""}`.trim()
    : action.selector
      ? `${action.command} ${action.selector}`
      : action.value
        ? `${action.command} ${action.value}`
        : action.command;
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
function reportPerStepBreakdown(beforeValidation: TraceAction[], afterValidation: TraceAction[]): void {
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

function groupCountByStep(actions: TraceAction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of actions) {
    const id = a.stepId ?? "<no step>";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
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

export function parseRouteStep(line: string): RouteStep | null {
  const parts = line.split("|");
  if (parts.length < 6) return null;

  const stepId = (parts[1] ?? "").trim();
  const title = parts[2] ?? "";
  const action = (parts[3] ?? "").replace(/^ACTION:/, "").trim();
  const observation = (parts[4] ?? "").replace(/^OBSERVATION:/, "").trim();
  const statusRaw = (parts[5] ?? "").replace(/^STATUS:/, "").trim();

  const status = (["PASSED", "FAILED", "SKIPPED"] as const).find((s) => s === statusRaw) ?? "FAILED";
  return { ...(stepId ? { stepId } : {}), title, action, observation, status };
}

export function parseAbAction(line: string): TraceAction | null {
  if (!line.startsWith("AB_ACTION|")) return null;
  const parts = line.split("|");
  const command = parts[1] as TraceCommand | undefined;

  switch (command) {
    case "cookies_clear":
      return { command };
    case "open":
      return { command, value: parts[2] };
    case "press":
      return { command, value: parts[2] };
    case "scroll":
      return { command, direction: parts[2], pixels: parts[3] };
    case "snapshot":
      return { command, observation: parts[2] };
    case "assert":
      return {
        command,
        assertType: parts[2] as AssertType,
        selector: parts[3] || undefined,
        value: parts[4] || undefined,
        observation: parts[5] || undefined,
      };
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
      return { command, selector: parts[2], label: parts[3] };
    case "wait": {
      const isTextWait = parts[2] === "--text";
      const selector = isTextWait ? `text=${parts[3]}` : parts[2];
      return { command, selector, label: isTextWait ? parts[4] : parts[3] };
    }
    case "fill":
    case "type":
    case "select":
      return { command, selector: parts[2], value: parts[3], label: parts[4] };
    case "drag":
      return { command, selector: parts[2], target: parts[3], label: parts[4] };
    case "upload": {
      // AB_ACTION|upload|<sel>|<file1>[|<file2>...]
      const selector = parts[2];
      const files = parts.slice(3).filter((f) => f !== "");
      if (!selector || files.length === 0) return null;
      return { command, selector, files };
    }
    case "find_click":
    case "find_dblclick":
    case "find_hover":
    case "find_focus":
    case "find_check":
    case "find_uncheck":
      // AB_ACTION|find_<action>|<locator>|<value>|<extra>|<exact>|<label>
      return parseFindAction(command, parts, false);
    case "find_fill":
    case "find_type":
      // AB_ACTION|find_<action>|<locator>|<value>|<extra>|<exact>|<fillValue>|<label>
      return parseFindAction(command, parts, true);
    default:
      return null;
  }
}

/**
 * Common parser for the `find_*` family. `<extra>` carries `--name` for
 * `role`, the integer index for `nth`, and is empty otherwise. We accept a
 * literally empty `<extra>` (the LLM emits a placeholder `|` so the
 * positional layout stays stable across locators).
 */
function parseFindAction(
  command: TraceCommand,
  parts: string[],
  hasFillValue: boolean,
): TraceAction | null {
  const locator = parts[2] as FindLocator | undefined;
  const findValue = parts[3];
  const extra = parts[4] ?? "";
  const exactToken = parts[5] ?? "";
  if (!locator || !FIND_LOCATORS.includes(locator) || !findValue) return null;

  const findExact = exactToken === "exact" ? true : undefined;
  const findName = locator === "role" && extra ? extra : undefined;
  const findIndex = locator === "nth" && extra ? Number.parseInt(extra, 10) : undefined;
  if (locator === "nth" && (findIndex === undefined || Number.isNaN(findIndex))) return null;

  return {
    command,
    findLocator: locator,
    findValue,
    ...(findExact !== undefined && { findExact }),
    ...(findName !== undefined && { findName }),
    ...(findIndex !== undefined && { findIndex }),
    ...(hasFillValue ? { value: parts[6], label: parts[7] } : { label: parts[6] }),
  };
}
