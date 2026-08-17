import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { agentBrowserInvokeBase } from "../claude/agent-browser-invoke.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { toReportCost } from "../claude/to-report-cost.ts";
import * as log from "../cli/logger.ts";
import { languageDirective } from "../prompts/language.ts";
import {
  buildLiveSystemPromptPrefix,
  buildLiveSystemPromptStepSection,
  buildLiveUserPrompt,
  buildStepVerdictPrompt,
} from "../prompts/live.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";
import { describeKill, killSessionDaemon } from "./agent-browser-daemon.ts";
import { scrubEnvValues } from "./env-scrub.ts";
import { stepArtifactPaths } from "./live-artifacts.ts";
import { findLastStepResult } from "./live-result-parse.ts";
import { takeScreenshot } from "./screenshot.ts";
import { checkLiveSessionHealth, loadStateIntoSession, recoverLiveSession } from "./session-state.ts";

/**
 * Per-step cost / usage / turn snapshot, derived from the SDK's `result`
 * message. Recorded so reports can surface "step N cost $X / used Y tokens"
 * and a per-run total can be aggregated.
 *
 * All fields are `null` when the SDK didn't emit a `result` message for the
 * step (e.g. the run was interrupted or the mock replay shim was used).
 */
export interface LiveStepCost {
  totalCostUsd: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  /** Model id(s) the SDK reported using for this step. */
  models: string[];
}

export interface LiveStepResult {
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
  cost: LiveStepCost;
  /**
   * The `agent-browser` commands (Bash `tool_use`) Claude actually issued on
   * the accepted attempt, tail-trimmed. Feeds prompt auto-learning: the
   * command that finally worked is the shortcut a later run can jump straight
   * to instead of re-exploring. Empty when the step was skipped or issued no
   * agent-browser command.
   */
  commands: string[];
}

/**
 * Run-level aggregate of every step's cost. Sums of the per-step fields;
 * `null` when no step produced an SDK `result` message at all (typically a
 * test fixture).
 */
export interface LiveRunCost {
  totalCostUsd: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  /** Union of model ids the SDK reported using across all steps. */
  models: string[];
}

export interface LiveRunResult {
  runId: string;
  status: "passed" | "failed";
  sessionName: string;
  startedAt: string;
  durationMs: number;
  steps: LiveStepResult[];
  cost: LiveRunCost;
}

export interface RunLiveExecutorInput {
  spec: { title: string };
  steps: ExpandedActionStep[];
  runId: string;
  runDir: string;
  sessionName: string;
  /**
   * `[resolvedValue, "${VAR}"]` pairs for this spec's env refs, from
   * `buildProseEnvScrubMap`. Every string the model writes is put through it,
   * so a profile value it quotes back never lands in the step log or report.
   */
  envScrubMap: Array<[string, string]>;
  /**
   * Absolute path to a saved agent-browser auth-state file (cookies +
   * localStorage). When provided, ccqa restores it into the session once,
   * before any step runs (see loadStateIntoSession), so the spec starts
   * already signed-in. Restore is load-only; the file is never written back to.
   */
  statePath?: string | null;
  /**
   * The signed-in verify URL embedded in the restored session, when present.
   * Enables mid-run recovery: if the agent-browser daemon is replaced during a
   * step (a crash/restart drops the in-memory auth-state), the executor probes
   * this URL to detect the loss and re-anchors to it after re-injecting state
   * (see checkLiveSessionHealth / recoverLiveSession). Null for older sessions
   * saved without a verify URL — recovery is then disabled for that run.
   */
  verifyUrl?: string | null;
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
 * Run all spec steps once through Claude (live mode). Each step is one Claude
 * invocation that:
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
export async function runLiveExecutor(input: RunLiveExecutorInput): Promise<LiveRunResult> {
  const startedAt = new Date();
  const stepResults: LiveStepResult[] = [];
  let overallFailed = false;

  // Hoisted out of the loop: the system prompt's static prefix (everything
  // except the "Your Task: <stepId>" trailer) and the PATH lookup don't
  // change per step. Computing them once avoids both per-step filesystem
  // walks (resolveAgentBrowserBinDir → statSync up the tree) and per-step
  // ~5 KB string rebuilds of the full allSteps block.
  const statePath = input.statePath ?? null;
  const verifyUrl = input.verifyUrl ?? null;
  const promptPrefix = buildLiveSystemPromptPrefix({
    title: input.spec.title,
    allSteps: input.steps,
    sessionName: input.sessionName,
    statePath,
  });
  const suffixBlock = input.systemPromptSuffix
    ? `\n## Project-specific guidance\n\n${input.systemPromptSuffix}\n`
    : "";
  const langDirective = languageDirective(input.language);
  const invokeBase = agentBrowserInvokeBase({
    sessionName: input.sessionName,
    runId: input.runId,
  });

  const retries = Math.max(0, input.retries ?? 0);

  // Restore the saved auth-state up front, once, before any step runs. This
  // cold-starts the session's daemon and attaches cookies + localStorage
  // deterministically (see loadStateIntoSession), so step 1's "before"
  // screenshot and the model's first command already see a signed-in page —
  // rather than relying on a `--state` flag racing the daemon boot.
  if (statePath) {
    const injected = loadStateIntoSession(input.sessionName, statePath);
    if (!injected.ok && injected.wedged) {
      // The run's first command went unanswered, so every step would fail
      // against this same daemon. Force it out and try once more rather than
      // handing the spec a session nobody can drive.
      const kill = await killSessionDaemon(input.sessionName);
      log.warn(`session state restore failed: ${injected.error}; ${describeKill(kill)}`);
      if (kill.killed) {
        const retried = loadStateIntoSession(input.sessionName, statePath);
        if (!retried.ok) log.warn(`session state restore failed again: ${retried.error}`);
      }
    } else if (!injected.ok) {
      log.warn(`session state restore failed: ${injected.error}`);
    }
  }

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
      promptPrefix + buildLiveSystemPromptStepSection(step) + suffixBlock + langDirective;
    const userPrompt = buildLiveUserPrompt(step);

    // `attempt` counts extra attempts beyond the first (feeds the "(after N
    // attempts)" reasoning below). It advances on both a budgeted --retry and
    // the one-shot session-loss recovery, so a run with --retry 0 still gets a
    // second try when the daemon was replaced mid-step.
    let attempt = 0;
    let recoveredOnce = false;
    let lastOutcome: StepAttemptOutcome | null = null;
    for (;;) {
      lastOutcome = await executeStepAttempt(step, paths, systemPrompt, userPrompt);
      if (lastOutcome.status === "passed") break;

      // Session-loss recovery. A step can fail because its browser broke rather
      // than because the step was wrong: the daemon stopped answering, or it
      // restarted and dropped the in-memory auth-state injected at run start.
      // Probe (cheap, non-navigating) only after a failure and only once per
      // step, so a plain failure — wrong selector, real assertion miss — on a
      // healthy session is left alone and the model retries on its current page.
      if (!recoveredOnce) {
        // Telling the kinds apart needs the probe, so it always runs; spending
        // the slot here is what keeps this to once per step either way.
        recoveredOnce = true;
        const health = checkLiveSessionHealth(input.sessionName);
        // A blank page with no saved state has nothing to put back, and its
        // browser is still there — the other kinds leave the session unusable.
        if (!health.healthy && (health.kind !== "blank" || statePath)) {
          const kill =
            health.kind === "unresponsive" ? await killSessionDaemon(input.sessionName) : null;
          log.warn(
            `session broken during ${step.id} (${health.reason}); ` +
              (kill ? describeKill(kill) : "re-injecting auth-state"),
          );
          // Every command below goes through the socket the daemon is ignoring,
          // so a kill that failed makes the retry pure cost.
          if (!kill || kill.killed) {
            const rec = recoverLiveSession(input.sessionName, statePath, verifyUrl);
            if (!rec.ok) log.warn(`session recovery failed: ${rec.error}`);
            attempt++;
            continue;
          }
        }
      }

      if (attempt >= retries) break;
      attempt++;
      log.info(`  retry ${attempt}/${retries} for ${step.id}`);
    }

    const outcome = lastOutcome!;
    const recorded = scrubLiveStepText(
      {
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
        cost: outcome.cost,
        commands: outcome.commands,
      },
      input.envScrubMap,
    );
    stepResults.push(recorded);

    // Narrate from the scrubbed step, not the raw outcome — this line is what
    // CI captures in its job log.
    if (outcome.status === "passed") {
      log.step("STEP_DONE", step.id, recorded.reasoning);
    } else {
      log.step("ASSERTION_FAILED", step.id, recorded.reasoning);
      overallFailed = true;
    }
  }

  async function executeStepAttempt(
    step: ExpandedActionStep,
    paths: ReturnType<typeof stepArtifactPaths>,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<StepAttemptOutcome> {
    // No --state here: loadStateIntoSession already attached the auth-state to
    // the daemon before the loop, so this screenshot connects to that same
    // signed-in session. Passing --state now would only draw an "already
    // running" warning.
    const before = takeScreenshot(input.sessionName, paths.beforePng);
    if (!before.ok) log.warn(`screenshot (before, ${step.id}) failed: ${before.error}`);

    const transcriptParts: string[] = [];
    // The agent-browser commands Claude actually ran, in order. Text blocks
    // (the transcript) and tool_use blocks (these commands) are collected
    // side by side so STEP_RESULT parsing keeps working off the text while
    // the commands feed prompt learning.
    const commandParts: string[] = [];
    let isError = false;
    let errorDetail: string | null = null;
    let cost: LiveStepCost = emptyStepCost();
    try {
      const result = await invokeClaudeStreaming(
        {
          ...invokeBase,
          prompt: userPrompt,
          systemPrompt,
          model: input.model,
          envScrubMap: input.envScrubMap,
          relaxAbConstraints: true,
          timeoutMs: stepAttemptTimeoutMs(),
        },
        (msg: SDKMessage) => {
          if (msg.type !== "assistant") return;
          for (const block of msg.message.content ?? []) {
            if (block.type === "text" && block.text) transcriptParts.push(block.text);
            // Same access pattern proven in claude/invoke.ts's Bash logging.
            if (block.type === "tool_use" && block.name === "Bash") {
              const cmd = (block.input as Record<string, unknown>)?.["command"];
              if (typeof cmd === "string") commandParts.push(cmd);
            }
          }
        },
      );
      isError = result.isError;
      errorDetail = result.errorDetail;
      cost = toReportCost(result.cost);
    } catch (err) {
      isError = true;
      errorDetail = err instanceof Error ? err.message : String(err);
      transcriptParts.push(`[ccqa] invokeClaudeStreaming threw: ${errorDetail}`);
    }
    const transcript = transcriptParts.join("\n");

    // After: full page so the assertion target is in the artifact regardless of
    // scroll position. Before stays viewport-only (lighter, and the before-state
    // doesn't usually need to prove "this row appeared below the fold").
    const after = takeScreenshot(input.sessionName, paths.afterPng, { fullPage: true });
    if (!after.ok) log.warn(`screenshot (after, ${step.id}) failed: ${after.error}`);

    let judged = findLastStepResult(transcript);
    // Ending the turn with no verdict is the model dropping the protocol rather
    // than an outcome of the step, and the prompt forbidding it is not enough.
    let salvaged = false;
    if (shouldAskForVerdict({ judged, isError, transcript })) {
      const verdict = await requestStepVerdict(step, transcript);
      judged = findLastStepResult(verdict.text);
      salvaged = judged !== null;
      if (salvaged) transcriptParts.push(verdict.text);
      else log.warn(`${step.id} gave no STEP_RESULT, and none when asked for one`);
      cost = sumCosts([cost, verdict.cost]);
    }

    // The transcript is model prose plus whatever page text it quoted, and the
    // failure-analysis excerpt reads this file back into report.json — so it is
    // scrubbed on the way to disk, not at some later reader.
    const scrubbed = scrubEnvValues(transcriptParts.join("\n"), input.envScrubMap);
    await writeFile(paths.logTxt, scrubbed || "(no assistant text captured)", "utf-8");

    const { status, reasoning } = judgeStepOutcome({ step, isError, errorDetail, judged, salvaged });

    return {
      status,
      reasoning,
      beforePng: before.ok ? paths.beforePng : null,
      afterPng: after.ok ? paths.afterPng : null,
      cost,
      commands: commandParts.slice(-MAX_LEARNED_COMMANDS),
    };
  }

  /**
   * Ask for the verdict alone. No tools and one turn: this converts what the
   * model already reported into the line it owed, rather than sending it back
   * to a page whose step is over.
   */
  async function requestStepVerdict(
    step: ExpandedActionStep,
    transcript: string,
  ): Promise<{ text: string; cost: LiveStepCost }> {
    // Read the streamed text, not only the SDK's closing `result`: the verdict
    // is a line the model says, and a run whose result message never arrives
    // would otherwise lose one it did give.
    const said: string[] = [];
    try {
      const result = await invokeClaudeStreaming(
        {
          prompt: buildStepVerdictPrompt(step, transcript),
          model: input.model,
          allowedTools: [],
          disableBuiltinTools: true,
          disableThinking: true,
          maxTurns: 1,
          timeoutMs: VERDICT_TIMEOUT_MS,
        },
        (msg: SDKMessage) => {
          if (msg.type !== "assistant") return;
          for (const block of msg.message.content ?? []) {
            if (block.type === "text" && block.text) said.push(block.text);
          }
        },
      );
      // On an error `result` carries the failure text, which is ccqa's own
      // words — appending it would file them as the model's report.
      if (!result.isError) said.push(result.result);
      return { text: said.join("\n"), cost: toReportCost(result.cost) };
    } catch {
      return { text: said.join("\n"), cost: emptyStepCost() };
    }
  }

  const durationMs = Date.now() - startedAt.getTime();
  return {
    runId: input.runId,
    status: overallFailed ? "failed" : "passed",
    sessionName: input.sessionName,
    startedAt: startedAt.toISOString(),
    durationMs,
    steps: stepResults,
    cost: sumStepCosts(stepResults),
  };
}

interface StepAttemptOutcome {
  status: "passed" | "failed";
  reasoning: string;
  beforePng: string | null;
  afterPng: string | null;
  cost: LiveStepCost;
  /** Tail-trimmed agent-browser commands issued during this attempt. */
  commands: string[];
}

/**
 * Keep only the tail of the command list. A step that churned through many
 * selectors shouldn't blow the learning-summary budget, and the last commands
 * are the winning path — exactly the shortcut a later run should reuse.
 */
const MAX_LEARNED_COMMANDS = 15;

/**
 * Wall-clock ceiling on one step attempt. The prompt's own ~3 minute wait
 * budget cannot end a step, because a model parked on a notification never
 * comes back to read it. Sized off measured runs: the longest passing step was
 * 4 minutes, against a wedged one that ran 15.
 */
const STEP_ATTEMPT_TIMEOUT_MS = 8 * 60_000;

/**
 * One text-only turn, so this only guards against the call hanging — kept far
 * below the step ceiling so asking for a verdict cannot meaningfully extend it.
 */
const VERDICT_TIMEOUT_MS = 60_000;

/**
 * A missing verdict is worth asking about only when the model left something to
 * judge and the invocation itself is not the answer: an error or a spent
 * ceiling already says what became of the step, and a turn with no prose at all
 * would only trade a precise "STEP_RESULT missing" for an invented sentence.
 */
export function shouldAskForVerdict(input: {
  judged: ReturnType<typeof findLastStepResult>;
  isError: boolean;
  transcript: string;
}): boolean {
  return input.judged === null && !input.isError && input.transcript.trim().length > 0;
}

/** Env override so a slow environment can be tuned without a release. */
function stepAttemptTimeoutMs(): number {
  const raw = Number(process.env["CCQA_LIVE_STEP_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : STEP_ATTEMPT_TIMEOUT_MS;
}

function emptyStepCost(): LiveStepCost {
  return {
    totalCostUsd: null,
    durationApiMs: null,
    numTurns: null,
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    models: [],
  };
}

/**
 * Sum a list of per-step costs into a single run-level cost. Any field that
 * had at least one numeric value across the steps becomes a sum; a field that
 * was null on every step stays null (instead of collapsing to 0, which would
 * hide "we never got SDK telemetry" from the report).
 */
function sumStepCosts(steps: LiveStepResult[]): LiveRunCost {
  return sumCosts(steps.map((s) => s.cost));
}

function sumCosts(costs: LiveStepCost[]): LiveRunCost {
  const sum = (pick: (c: LiveStepCost) => number | null): number | null => {
    let total = 0;
    let seen = false;
    for (const c of costs) {
      const v = pick(c);
      if (v !== null) {
        total += v;
        seen = true;
      }
    }
    return seen ? total : null;
  };
  const modelSet = new Set<string>();
  for (const c of costs) for (const m of c.models) modelSet.add(m);
  return {
    totalCostUsd: sum((c) => c.totalCostUsd),
    durationApiMs: sum((c) => c.durationApiMs),
    numTurns: sum((c) => c.numTurns),
    inputTokens: sum((c) => c.inputTokens),
    cacheCreationInputTokens: sum((c) => c.cacheCreationInputTokens),
    cacheReadInputTokens: sum((c) => c.cacheReadInputTokens),
    outputTokens: sum((c) => c.outputTokens),
    models: [...modelSet],
  };
}

interface JudgeInput {
  step: ExpandedActionStep;
  isError: boolean;
  /** Why the invocation failed, when known; see `InvokeClaudeStreamingResult`. */
  errorDetail: string | null;
  judged: ReturnType<typeof findLastStepResult>;
  /**
   * The verdict was reconstructed after the step ended, from the model's own
   * narrative with no page to check. Marked so a reader does not take it for
   * something the model confirmed while it still had the browser.
   */
  salvaged?: boolean;
}

/**
 * Collapse the four step-verdict cases (agent error / STEP_RESULT missing /
 * stepId mismatch / model verdict) into a `(status, reasoning)` pair.
 * Kept as a pure helper so the executor loop stays readable and the
 * branches are individually testable.
 */
export function judgeStepOutcome({ step, isError, errorDetail, judged, salvaged }: JudgeInput): {
  status: "passed" | "failed";
  reasoning: string;
} {
  if (isError) {
    // Name the cause when the SDK gave one (missing native binary, bad
    // credentials); "returned an error" on its own is not actionable.
    const detail = errorDetail ? `: ${errorDetail}` : "";
    return {
      status: "failed",
      reasoning: judged?.reasoning
        ? `agent error${detail}; last reasoning: ${judged.reasoning}`
        : `Claude invocation returned an error${detail}`,
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
  return { status, reasoning: salvaged ? `(verdict given after the step ended) ${reasoning}` : reasoning };
}

/**
 * Scrub the strings a step carries that the model authored: its verdict prose
 * and the commands it issued. `instruction` / `expected` are copied from the
 * spec, which keeps `${VAR}` symbolic, so they need nothing.
 */
export function scrubLiveStepText(
  step: LiveStepResult,
  scrubMap: Array<[string, string]>,
): LiveStepResult {
  return {
    ...step,
    reasoning: scrubEnvValues(step.reasoning, scrubMap),
    commands: step.commands.map((c) => scrubEnvValues(c, scrubMap)),
  };
}

function buildSkippedStep(step: ExpandedActionStep, reason: string): LiveStepResult {
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
    cost: emptyStepCost(),
    commands: [],
  };
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function truncateForLog(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? oneLine.slice(0, 100) + "…" : oneLine;
}
