import { Command } from "commander";
import { buildTraceSystemPrompt, buildTracePrompt } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ensureVeriqDir, parseSpecPath, readSpecFile, saveRoute, saveTraceActions } from "../store/index.ts";
import { parseTestSpec } from "../spec/parser.ts";
import type { Route, RouteStep, TraceAction, TraceCommand, AssertType, ParsedStatusLine } from "../types.ts";
import * as log from "./logger.ts";

export const traceCommand = new Command("trace")
  .argument("<feature/spec>", "Spec to trace (e.g. tasks/create-and-complete)")
  .description("Run agent-browser, verify assertions, and record structured actions")
  .action(async (specPath: string) => {
    const { featureName, specName } = parseSpecPath(specPath);
    await runTrace(featureName, specName);
  });

async function runTrace(featureName: string, specName: string): Promise<void> {
  log.header("trace", `${featureName}/${specName}`);

  await ensureVeriqDir();

  const specContent = await readSpecFile(featureName, specName);
  const spec = parseTestSpec(specContent);

  log.meta("spec", spec.title);
  log.meta("url", spec.baseUrl);
  log.meta("steps", spec.steps.length);
  log.blank();

  const systemPrompt = buildTraceSystemPrompt(spec);
  const prompt = buildTracePrompt(spec);

  log.info("Running agent-browser session...");
  log.blank();

  const routeSteps: RouteStep[] = [];
  let overallStatus: "passed" | "failed" = "passed";
  const traceActions: TraceAction[] = [];

  const { isError } = await invokeClaudeStreaming(
    {
      prompt,
      systemPrompt,
      allowedTools: ["Bash(*)", "Read", "Grep", "Glob"],
      onAbAction: (abAction: string) => {
        const action = parseAbAction(abAction);
        if (action) traceActions.push(action);
      },
      onAbActionFailed: () => {
        // Roll back the last intercepted AB_ACTION if the browser command failed
        traceActions.pop();
      },
    },
    (msg: SDKMessage) => {
      if (msg.type !== "assistant") return;

      for (const block of msg.message.content ?? []) {
        if (block.type !== "text" || !block.text) continue;
        const text = block.text;

        const statusLine = parseStatusLine(text);
        if (statusLine) log.step(statusLine.type, statusLine.stepId, statusLine.detail);

        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("ROUTE_STEP|")) {
            const routeStep = parseRouteStep(trimmed);
            if (routeStep) {
              routeSteps.push(routeStep);
              if (routeStep.status === "FAILED") overallStatus = "failed";
            }
          } else if (trimmed.startsWith("AB_ACTION|snapshot|") || trimmed.startsWith("AB_ACTION|assert|")) {
            const action = parseAbAction(trimmed);
            if (action) traceActions.push(action);
          }
        }
      }
    },
  );

  if (isError) overallStatus = "failed";

  const timestamp = new Date().toISOString();
  const route: Route = { specName, timestamp, status: overallStatus, steps: routeSteps };

  const [routePath, actionsPath] = await Promise.all([
    saveRoute(featureName, specName, route),
    saveTraceActions(featureName, specName, traceActions),
  ]);

  log.blank();
  log.meta("route", routePath);
  log.meta("saved", actionsPath);
  log.meta("actions", traceActions.length);
  log.meta("status", overallStatus.toUpperCase());
  log.hint(`run 'veriq generate ${featureName}/${specName}' to generate a test script`);
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
      // LLM may emit AB_ACTION|wait|--text|<text> or AB_ACTION|wait|<selector>
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
