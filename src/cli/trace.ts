import { Command } from "commander";
import { buildTraceSystemPrompt, buildTracePrompt, generateSessionName } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ensureCcqaDir,
  loadAllBlocks,
  parseSpecPath,
  readSpecFile,
  saveRoute,
  saveTraceActions,
  updateSpecRelatedPaths,
} from "../store/index.ts";
import { warnStaleBlockArtifacts } from "./stale-blocks.ts";
import { parseRelatedPathsBlock } from "../drift/parse-related-paths.ts";
import { parseTestSpec } from "../spec/parser.ts";
import { collectIncludedBlockNames, expandSpec } from "../spec/expand.ts";
import {
  assertAgentBrowserAvailable,
  AgentBrowserUnavailableError,
  formatAgentBrowserUnavailableMessage,
  pathWithAgentBrowserShim,
} from "../runtime/agent-browser-bin.ts";
import { validateActions } from "../runtime/replay-validate.ts";
import { buildSpecEnvScrub, scrubEnvValues } from "../runtime/env-scrub.ts";
import type { Route, RouteStep, TraceAction, TraceCommand, AssertType, ParsedStatusLine } from "../types.ts";
import * as log from "./logger.ts";

interface TraceOptions {
  model?: string;
}

export const traceCommand = new Command("trace")
  .argument(
    "<feature/spec>",
    "Spec id in '<feature>/<spec>' form (resolves to .ccqa/features/<feature>/test-cases/<spec>/)",
  )
  .description("Run agent-browser, verify assertions, and record structured actions")
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .action(async (specPath: string, opts: TraceOptions) => {
    const { featureName, specName } = parseSpecPath(specPath);
    await runTrace(featureName, specName, opts.model);
  });

async function runTrace(featureName: string, specName: string, model?: string): Promise<void> {
  log.header("trace", `${featureName}/${specName}`);

  try {
    const binDir = assertAgentBrowserAvailable();
    log.meta("agent-browser", binDir);
  } catch (e) {
    if (e instanceof AgentBrowserUnavailableError) {
      log.error(formatAgentBrowserUnavailableMessage());
      process.exit(1);
    }
    throw e;
  }

  await ensureCcqaDir();
  await warnStaleBlockArtifacts();

  const specContent = await readSpecFile(featureName, specName);
  const spec = parseTestSpec(specContent);
  const blocks = await loadAllBlocks();
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

  const systemPrompt = buildTraceSystemPrompt({
    title: spec.title,
    steps: expanded,
    sessionName,
  });
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
      allowedTools: ["Bash(*)", "Read", "Grep", "Glob"],
      // Prepend the peer-installed agent-browser shim dir to PATH so the
      // Claude subprocess can invoke `agent-browser ...` without requiring a
      // global install. Without this, peer-only setups (e.g. running ccqa
      // inside a Claude Code terminal) hit "command not found".
      env: {
        AGENT_BROWSER_SESSION: sessionName,
        PATH: pathWithAgentBrowserShim(process.env["PATH"]),
      },
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

  const validatedActions = validateAndReport(traceActions);

  const timestamp = new Date().toISOString();
  const route: Route = { specName, timestamp, status: overallStatus, steps: routeSteps };

  const [routePath, actionsPath] = await Promise.all([
    saveRoute(featureName, specName, route),
    saveTraceActions(featureName, specName, validatedActions),
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
    const written = await updateSpecRelatedPaths(featureName, specName, relatedPaths);
    if (written) {
      log.meta("relatedPaths", `${relatedPaths.length} path(s) written to ${written}`);
    }
  } else {
    log.warn("trace did not emit a RELATED_PATHS block; drift --changed cannot scope this spec");
  }

  log.hint(`run 'ccqa generate ${featureName}/${specName}' to generate a test script`);
}

/**
 * Run the post-trace replay validation and emit user-visible drop reports.
 * Splitting this out keeps `runTrace` readable; the function is pure aside
 * from `log.*` and the agent-browser invocations inside `validateActions`.
 */
function validateAndReport(actions: TraceAction[]): TraceAction[] {
  if (actions.length === 0) return actions;
  const sessionName = `${generateSessionName()}-validate`;
  log.blank();
  log.info("post-trace validation (replaying recorded actions)...");
  const { kept, dropped } = validateActions(actions, { sessionName });
  if (dropped.length === 0) {
    log.meta("validated", `${kept.length}/${actions.length} kept`);
    return kept;
  }
  for (const d of dropped) {
    log.warn(`dropped action #${d.index + 1} (${d.action.command}${d.action.selector ? " " + d.action.selector : ""}): ${d.reason}`);
  }
  log.meta("validated", `${kept.length}/${actions.length} kept (${dropped.length} dropped)`);
  return kept;
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

  const title = parts[2] ?? "";
  const action = (parts[3] ?? "").replace(/^ACTION:/, "").trim();
  const observation = (parts[4] ?? "").replace(/^OBSERVATION:/, "").trim();
  const statusRaw = (parts[5] ?? "").replace(/^STATUS:/, "").trim();

  const status = (["PASSED", "FAILED", "SKIPPED"] as const).find((s) => s === statusRaw) ?? "FAILED";
  return { title, action, observation, status };
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
    default:
      return null;
  }
}
