import { Command } from "commander";
import { buildSetupTraceSystemPrompt, buildSetupTracePrompt } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ensureCcqaDir, readSetupSpecFile, saveSetupActions, saveSetupRoute } from "../store/index.ts";
import { parseSetupSpec } from "../spec/parser.ts";
import { parseAbAction, parseStatusLine, parseRouteStep } from "./trace.ts";
import {
  assertAgentBrowserAvailable,
  AgentBrowserUnavailableError,
  formatAgentBrowserUnavailableMessage,
  pathWithAgentBrowserShim,
} from "../runtime/agent-browser-bin.ts";
import { hasEnvRef, resolveEnvRefs } from "../runtime/env-vars.ts";
import type { Route, RouteStep, TraceAction } from "../types.ts";
import * as log from "./logger.ts";

interface TraceSetupOptions {
  model?: string;
}

export const traceSetupCommand = new Command("trace-setup")
  .argument("<name>", "Setup name to trace (e.g. login)")
  .description("Trace a setup procedure using dummy placeholder values")
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .action(async (name: string, opts: TraceSetupOptions) => {
    await runTraceSetup(name, opts.model);
  });

async function runTraceSetup(name: string, model?: string): Promise<void> {
  log.header("trace-setup", name);

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

  const specContent = await readSetupSpecFile(name);
  const spec = parseSetupSpec(specContent);

  // Replace {{key}} with dummy values for actual browser operation. Env-var
  // references inside dummies (e.g. dummy: "${AUTH_PASSWORD}") are resolved
  // here so the browser receives real credentials.
  const resolvedSpec = replacePlaceholdersWithDummies(spec);

  // Reverse map of expanded-secret -> "${VAR}" placeholder, used to scrub
  // recorded actions before they hit actions.json. Built only for dummies
  // that contain env refs and resolve to a non-empty value.
  const secretsToScrub = buildSecretsToScrub(spec);

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
      env: { PATH: pathWithAgentBrowserShim(process.env["PATH"]), ANTHROPIC_API_KEY: "" },
      model,
      onAbAction: (abAction: string) => {
        const action = parseAbAction(scrubSecrets(abAction, secretsToScrub));
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
            const action = parseAbAction(scrubSecrets(trimmed, secretsToScrub));
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
  log.hint(`run 'ccqa generate-setup ${name}' to generate and validate the setup`);
}

function replacePlaceholdersWithDummies(spec: ReturnType<typeof parseSetupSpec>): typeof spec {
  if (!spec.placeholders) return spec;

  const dummies = spec.placeholders as Record<string, { dummy: string; description?: string }>;
  const resolve = (text: string): string => {
    let result = text;
    for (const [key, def] of Object.entries(dummies)) {
      // Resolve env refs inside the dummy value so prompts handed to Claude
      // (and thus agent-browser) receive real credentials when the user
      // wrote `dummy: "${AUTH_PASSWORD}"`.
      result = result.replaceAll(`{{${key}}}`, resolveEnvRefs(def.dummy));
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

/**
 * Build the substitution map used to scrub real secret values out of
 * recorded actions before they are written to actions.json.
 *
 * For each placeholder whose dummy contains env refs, store
 *   <resolved-value> -> <original ${VAR} string>
 * so that an `ab fill ... <secret>` line records the placeholder string
 * instead of the secret. Empty resolved values are skipped — they would
 * otherwise replace incidental empty strings in the recorded actions.
 */
function buildSecretsToScrub(
  spec: ReturnType<typeof parseSetupSpec>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!spec.placeholders) return map;
  const dummies = spec.placeholders as Record<string, { dummy: string; description?: string }>;
  for (const def of Object.values(dummies)) {
    if (!hasEnvRef(def.dummy)) continue;
    const resolved = resolveEnvRefs(def.dummy);
    if (!resolved) continue;
    map.set(resolved, def.dummy);
  }
  return map;
}

/** Replace every occurrence of a recorded secret with its `${VAR}` placeholder. */
function scrubSecrets(line: string, secrets: Map<string, string>): string {
  if (secrets.size === 0) return line;
  let result = line;
  for (const [secret, placeholder] of secrets) {
    if (!result.includes(secret)) continue;
    result = result.split(secret).join(placeholder);
  }
  return result;
}
