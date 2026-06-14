import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { agentBrowserInvokeBase } from "../claude/agent-browser-invoke.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import * as log from "../cli/logger.ts";
import { languageDirective } from "../prompts/language.ts";
import {
  buildRunNdSystemPromptPrefix,
  buildRunNdSystemPromptStepSection,
  buildRunNdUserPrompt,
} from "../prompts/run-nd.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";
import { stepArtifactPaths } from "./nd-artifacts.ts";
import { findLastStepResult } from "./nd-result-parse.ts";
import { takeScreenshot } from "./screenshot.ts";

export interface NdStepResult {
  stepId: string;
  source: string;
  instruction: string;
  expected: string;
  status: "passed" | "failed" | "skipped";
  reasoning: string;
  beforePng: string | null;
  afterPng: string | null;
  logTxt: string | null;
  durationMs: number;
}

export interface NdRunResult {
  runId: string;
  status: "passed" | "failed";
  sessionName: string;
  startedAt: string;
  durationMs: number;
  steps: NdStepResult[];
}

export interface RunNdExecutorInput {
  spec: { title: string };
  steps: ExpandedActionStep[];
  runId: string;
  runDir: string;
  sessionName: string;
  systemPromptSuffix?: string | null;
  model?: string;
  language?: string;
  /**
   * Maximum number of re-attempts per step. The first attempt is not counted —
   * `retries: 2` means "try once, and if it fails try up to 2 more times". On
   * the final accepted attempt the artifacts (PNG, log) overwrite the earlier
   * attempts so the recorded result reflects the final state. Default 0.
   */
  retries?: number;
}

/**
 * Run all spec steps once through Claude (non-deterministic mode). Each step
 * is one Claude invocation that:
 *   1. takes a "before" screenshot of the live session
 *   2. lets Claude execute the step's instruction via agent-browser (full
 *      surface, no replay-time selector constraints)
 *   3. takes an "after" screenshot
 *   4. parses a STEP_RESULT line from the assistant transcript
 *
 * On the first failed step, every remaining step is recorded as `skipped` and
 * the overall run status flips to `failed`. The Chrome session persists
 * across steps so step N+1 starts on whatever page step N left the browser on.
 */
export async function runNdExecutor(input: RunNdExecutorInput): Promise<NdRunResult> {
  const startedAt = new Date();
  const stepResults: NdStepResult[] = [];
  let overallFailed = false;

  // Hoisted out of the loop: the system prompt's static prefix (everything
  // except the "Your Task: <stepId>" trailer) and the PATH lookup don't
  // change per step. Computing them once avoids both per-step filesystem
  // walks (resolveAgentBrowserBinDir → statSync up the tree) and per-step
  // ~5 KB string rebuilds of the full allSteps block.
  const promptPrefix = buildRunNdSystemPromptPrefix({
    title: input.spec.title,
    allSteps: input.steps,
    sessionName: input.sessionName,
  });
  const suffixBlock = input.systemPromptSuffix
    ? `\n## Project-specific guidance\n\n${input.systemPromptSuffix}\n`
    : "";
  const langDirective = languageDirective(input.language);
  const invokeBase = agentBrowserInvokeBase(input.sessionName);

  const retries = Math.max(0, input.retries ?? 0);

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    log.info(`step ${i + 1}/${input.steps.length} [${step.id}] ${truncateForLog(step.instruction)}`);

    if (overallFailed) {
      stepResults.push(buildSkippedStep(step, "earlier step failed"));
      log.step("STEP_SKIPPED", step.id, "earlier step failed");
      continue;
    }

    const paths = stepArtifactPaths(input.runDir, step.id);
    await ensureDir(paths.beforePng);
    const stepStartedAt = Date.now();
    const systemPrompt =
      promptPrefix + buildRunNdSystemPromptStepSection(step) + suffixBlock + langDirective;
    const userPrompt = buildRunNdUserPrompt(step);

    let attempt = 0;
    let lastOutcome: StepAttemptOutcome | null = null;
    while (attempt <= retries) {
      if (attempt > 0) log.info(`  retry ${attempt}/${retries} for ${step.id}`);
      lastOutcome = await executeStepAttempt(step, paths, systemPrompt, userPrompt);
      if (lastOutcome.status === "passed") break;
      attempt++;
    }

    const outcome = lastOutcome!;
    stepResults.push({
      stepId: step.id,
      source: step.source,
      instruction: step.instruction,
      expected: step.expected,
      status: outcome.status,
      reasoning:
        attempt > 0 && outcome.status === "failed"
          ? `${outcome.reasoning} (after ${attempt + 1} attempts)`
          : outcome.reasoning,
      beforePng: outcome.beforePng,
      afterPng: outcome.afterPng,
      logTxt: paths.logTxt,
      durationMs: Date.now() - stepStartedAt,
    });

    if (outcome.status === "passed") {
      log.step("STEP_DONE", step.id, outcome.reasoning);
    } else {
      log.step("ASSERTION_FAILED", step.id, outcome.reasoning);
      overallFailed = true;
    }
  }

  async function executeStepAttempt(
    step: ExpandedActionStep,
    paths: ReturnType<typeof stepArtifactPaths>,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<StepAttemptOutcome> {
    const before = takeScreenshot(input.sessionName, paths.beforePng);
    if (!before.ok) log.warn(`screenshot (before, ${step.id}) failed: ${before.error}`);

    const transcriptParts: string[] = [];
    let isError = false;
    try {
      const result = await invokeClaudeStreaming(
        {
          ...invokeBase,
          prompt: userPrompt,
          systemPrompt,
          model: input.model,
          relaxAbConstraints: true,
        },
        (msg: SDKMessage) => {
          if (msg.type !== "assistant") return;
          for (const block of msg.message.content ?? []) {
            if (block.type === "text" && block.text) transcriptParts.push(block.text);
          }
        },
      );
      isError = result.isError;
    } catch (err) {
      isError = true;
      transcriptParts.push(
        `[ccqa] invokeClaudeStreaming threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const transcript = transcriptParts.join("\n");

    const after = takeScreenshot(input.sessionName, paths.afterPng);
    if (!after.ok) log.warn(`screenshot (after, ${step.id}) failed: ${after.error}`);

    await writeFile(paths.logTxt, transcript || "(no assistant text captured)", "utf-8");

    const { status, reasoning } = judgeStepOutcome({
      step,
      isError,
      judged: findLastStepResult(transcript),
    });

    return {
      status,
      reasoning,
      beforePng: before.ok ? paths.beforePng : null,
      afterPng: after.ok ? paths.afterPng : null,
    };
  }

  const durationMs = Date.now() - startedAt.getTime();
  return {
    runId: input.runId,
    status: overallFailed ? "failed" : "passed",
    sessionName: input.sessionName,
    startedAt: startedAt.toISOString(),
    durationMs,
    steps: stepResults,
  };
}

interface StepAttemptOutcome {
  status: "passed" | "failed";
  reasoning: string;
  beforePng: string | null;
  afterPng: string | null;
}

interface JudgeInput {
  step: ExpandedActionStep;
  isError: boolean;
  judged: ReturnType<typeof findLastStepResult>;
}

/**
 * Collapse the four step-verdict cases (agent error / STEP_RESULT missing /
 * stepId mismatch / model verdict) into a `(status, reasoning)` pair.
 * Kept as a pure helper so the executor loop stays readable and the
 * branches are individually testable.
 */
function judgeStepOutcome({ step, isError, judged }: JudgeInput): {
  status: "passed" | "failed";
  reasoning: string;
} {
  if (isError) {
    return {
      status: "failed",
      reasoning: judged?.reasoning
        ? `agent error; last reasoning: ${judged.reasoning}`
        : "Claude invocation returned an error",
    };
  }
  if (!judged) {
    return { status: "failed", reasoning: "STEP_RESULT missing" };
  }
  const status: "passed" | "failed" = judged.status === "pass" ? "passed" : "failed";
  const baseReason = judged.reasoning || "(no reason given)";
  const reasoning =
    judged.stepId === step.id
      ? baseReason
      : `(stepId mismatch: model wrote ${judged.stepId}) ${baseReason}`;
  return { status, reasoning };
}

function buildSkippedStep(step: ExpandedActionStep, reason: string): NdStepResult {
  return {
    stepId: step.id,
    source: step.source,
    instruction: step.instruction,
    expected: step.expected,
    status: "skipped",
    reasoning: reason,
    beforePng: null,
    afterPng: null,
    logTxt: null,
    durationMs: 0,
  };
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function truncateForLog(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? oneLine.slice(0, 100) + "…" : oneLine;
}
