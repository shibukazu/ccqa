import { Command } from "commander";
import { buildSetupTraceSystemPrompt, buildSetupTracePrompt } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ensureVeriqDir, readSetupSpecFile, saveSetupActions, saveSetupRoute } from "../store/index.ts";
import { parseSetupSpec } from "../spec/parser.ts";
import { parseAbAction, parseStatusLine, parseRouteStep } from "./trace.ts";
import type { Route, RouteStep, TraceAction } from "../types.ts";
import * as log from "./logger.ts";

export const traceSetupCommand = new Command("trace-setup")
  .argument("<name>", "Setup name to trace (e.g. login)")
  .description("Trace a setup procedure using dummy placeholder values")
  .action(async (name: string) => {
    await runTraceSetup(name);
  });

async function runTraceSetup(name: string): Promise<void> {
  log.header("trace-setup", name);

  await ensureVeriqDir();

  const specContent = await readSetupSpecFile(name);
  const spec = parseSetupSpec(specContent);

  // Replace {{key}} with dummy values for actual browser operation
  const resolvedSpec = replacePlaceholdersWithDummies(spec);

  log.meta("setup", spec.title);
  log.meta("steps", spec.steps.length);
  if (spec.placeholders) {
    log.meta("placeholders", Object.keys(spec.placeholders).join(", "));
  }
  log.blank();

  const systemPrompt = buildSetupTraceSystemPrompt(resolvedSpec);
  const prompt = buildSetupTracePrompt(resolvedSpec);

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
  const route: Route = { specName: name, timestamp, status: overallStatus, steps: routeSteps };

  const [routePath, actionsPath] = await Promise.all([
    saveSetupRoute(name, route),
    saveSetupActions(name, traceActions),
  ]);

  log.blank();
  log.meta("route", routePath);
  log.meta("saved", actionsPath);
  log.meta("actions", traceActions.length);
  log.meta("status", overallStatus.toUpperCase());
  log.hint(`run 'veriq generate-setup ${name}' to generate and validate the setup`);
}

function replacePlaceholdersWithDummies(spec: ReturnType<typeof parseSetupSpec>): typeof spec {
  if (!spec.placeholders) return spec;

  const dummies = spec.placeholders as Record<string, { dummy: string; description?: string }>;
  const resolve = (text: string): string => {
    let result = text;
    for (const [key, def] of Object.entries(dummies)) {
      result = result.replaceAll(`{{${key}}}`, def.dummy);
    }
    return result;
  };

  return {
    ...spec,
    steps: spec.steps.map((step) => ({
      ...step,
      instruction: resolve(step.instruction),
      expected: resolve(step.expected),
    })),
  };
}
