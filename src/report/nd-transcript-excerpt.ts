import { readFile } from "node:fs/promises";
import type { NdRunResult, NdStepResult } from "../runtime/nd-executor.ts";

/**
 * The failure-analysis prompt only has so much context window to give. A
 * full ND transcript is several hundred KB of Claude assistant text spread
 * across step-NN.log.txt files. We summarise it for the classifier:
 *
 *   - For every step before the failing one: a one-line `[step-NN passed: reason]` row.
 *   - For the failing step: the full reasoning, plus the head + tail of its
 *     transcript log (so the classifier sees what Claude tried and how it
 *     decided to call fail).
 *
 * Total target size: ~30 KB. The head/tail budget defaults to 5 KB each
 * which empirically captures the meaningful framing without ballooning
 * tokens. Callers can override for testing.
 */
export interface BuildNdTranscriptExcerptOptions {
  /** Bytes from the head of the failing step's log. Default 5000. */
  headBytes?: number;
  /** Bytes from the tail of the failing step's log. Default 5000. */
  tailBytes?: number;
  /** Hard upper bound on the whole excerpt. Default 30000. */
  maxBytes?: number;
}

/**
 * Build a compact transcript summary for the failure classifier.
 *
 * Returns `null` when the run has no failed step (every step passed/skipped),
 * since the failure analyzer has nothing to explain in that case.
 */
export async function buildNdTranscriptExcerpt(
  result: NdRunResult,
  options: BuildNdTranscriptExcerptOptions = {},
): Promise<string | null> {
  const failingIndex = result.steps.findIndex((s) => s.status === "failed");
  if (failingIndex === -1) return null;
  const failingStep = result.steps[failingIndex]!;

  const headBytes = options.headBytes ?? 5000;
  const tailBytes = options.tailBytes ?? 5000;
  const maxBytes = options.maxBytes ?? 30000;

  const lines = result.steps.slice(0, failingIndex).map(formatPreviousStep);
  lines.push(await formatFailingStep(failingStep, headBytes, tailBytes));

  // Trailing skipped-step summary so the classifier knows the run aborted
  // mid-way rather than passing through.
  const skippedAfter = result.steps
    .slice(failingIndex + 1)
    .filter((s) => s.status === "skipped");
  if (skippedAfter.length > 0) {
    lines.push(
      `\n[${skippedAfter.length} subsequent step(s) skipped because ${failingStep.stepId} failed]`,
    );
  }

  const combined = lines.join("\n");
  return combined.length > maxBytes
    ? `${combined.slice(0, maxBytes)}\n…[transcript excerpt truncated at ${maxBytes} bytes]`
    : combined;
}

function formatPreviousStep(step: NdStepResult): string {
  const reason = oneLine(step.reasoning) || "(no reason given)";
  return `[${step.stepId} ${step.status}: ${reason}]`;
}

async function formatFailingStep(
  step: NdStepResult,
  headBytes: number,
  tailBytes: number,
): Promise<string> {
  const header = `\n>>> Failed step ${step.stepId}\nInstruction: ${oneLine(step.instruction)}\nExpected: ${oneLine(step.expected)}\nReasoning (Claude's verdict): ${oneLine(step.reasoning) || "(none)"}`;

  if (!step.logTxt) return `${header}\n(No assistant log file recorded for this step.)`;

  const raw = await readFile(step.logTxt, "utf-8").catch((err: unknown) => {
    return `[log file unreadable: ${err instanceof Error ? err.message : String(err)}]`;
  });

  if (raw.length <= headBytes + tailBytes) {
    return `${header}\n--- assistant log ---\n${raw}`;
  }

  const head = raw.slice(0, headBytes);
  const tail = raw.slice(raw.length - tailBytes);
  const omitted = raw.length - headBytes - tailBytes;
  return `${header}\n--- assistant log (head ${headBytes}B) ---\n${head}\n…[${omitted} bytes omitted]…\n--- assistant log (tail ${tailBytes}B) ---\n${tail}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
