import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { buildTraceSystemPrompt, buildTracePrompt, generateSessionName } from "../prompts/trace.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ensureVeriqDir, parseSpecPath, readSpecFile, saveRoute, saveTraceActions, getSetupDir } from "../store/index.ts";
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
  const hasSetups = (spec.setups?.length ?? 0) > 0;

  log.meta("spec", spec.title);
  log.meta("url", spec.baseUrl);
  if (hasSetups) log.meta("setups", spec.setups!.map((s) => s.name).join(", "));
  log.meta("steps", spec.steps.length);
  log.blank();

  // Generate a session name to share between setup execution and trace
  const sessionName = generateSessionName();

  // Run setups before tracing (same session)
  if (hasSetups) {
    log.info("Running setup procedures...");
    await runSetups(
      spec.setups as Array<{ name: string; params?: Record<string, string> }>,
      sessionName,
    );
    log.blank();
  }

  const systemPrompt = buildTraceSystemPrompt(spec, {
    sessionName,
    skipCookiesClear: hasSetups,
  });
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
      env: { AGENT_BROWSER_SESSION: sessionName },
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

/**
 * Execute setup procedures by running their test.spec.ts via vitest with a fixed session name.
 * Creates a temporary runner script that sets the session and imports each setup's test body.
 */
async function runSetups(
  setups: Array<{ name: string; params?: Record<string, string> }>,
  sessionName: string,
): Promise<void> {
  for (const ref of setups) {
    log.info(`  setup: ${ref.name}`);

    const scriptPath = join(getSetupDir(ref.name), "test.spec.ts");
    let script = await readFile(scriptPath, "utf-8").catch(() => {
      throw new Error(`Setup test script not found: ${scriptPath}. Run \`veriq generate-setup ${ref.name}\` first.`);
    });

    // Replace placeholders with params
    for (const [key, value] of Object.entries(ref.params ?? {})) {
      script = script.replaceAll(`{{${key}}}`, value);
    }

    // Fix the session name to share with the trace phase
    script = script.replace(
      /process\.env\.AGENT_BROWSER_SESSION\s*=\s*`.+`;/,
      `process.env.AGENT_BROWSER_SESSION = ${JSON.stringify(sessionName)};`,
    );

    // Write temp file, run vitest, clean up
    const tmpPath = join(getSetupDir(ref.name), `_run.spec.ts`);
    await writeFile(tmpPath, script, "utf-8");

    try {
      const proc = Bun.spawn(["bunx", "vitest", "run", tmpPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);

      if (exitCode !== 0) {
        throw new Error(`Setup '${ref.name}' failed (exit ${exitCode})`);
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }
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
