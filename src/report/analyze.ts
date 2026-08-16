import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import * as log from "../cli/logger.ts";
import { clamp, extractJsonCandidates, isObject, truncate } from "../diagnose/diagnose.ts";
import { scrubEnvValues } from "../runtime/env-scrub.ts";
import {
  buildFailureAnalysisPrompt,
  CHANGED_FILE_DIFF_TOOL,
  type FailureAnalysisPromptInput,
} from "./prompt.ts";
import {
  ACTUAL_CAUSES,
  DRIFT_FAILURE_CAUSES,
  DriftSurfaceSchema,
  predictedForKind,
  SUB_DIAGNOSES,
  type FailureAnalysis,
  type FailureEvidence,
  type PredictedLabel,
} from "./schema.ts";

interface FailureAnalysisOptions {
  model?: string;
  cwd?: string;
  getFileDiff: (path: string) => string | null;
  /**
   * `[resolvedValue, "${VAR}"]` pairs from `buildProseEnvScrubMap`, applied to
   * the classifier's prose before it reaches the row (see `scrubOutcome`).
   */
  envScrubMap?: Array<[string, string]>;
}

export interface FailureAnalysisOutcome {
  /** Parsed and normalised analysis. Never null: unusable output degrades to UNKNOWN. */
  analysis: FailureAnalysis;
  /** Raw assistant text, kept for surfacing what happened when the analysis is weak. */
  raw: string;
  /** True when the SDK reported an error (network / model). */
  sdkError: boolean;
}

/**
 * In-process MCP server exposing one tool: the diff hunk of a named changed
 * file. The inline patch in the prompt is only a truncated seed; this is the
 * pull side — the model fetches a hunk cut or dropped by truncation only
 * when it decides it matters, so the full diff never has to ride in the
 * prompt. Read-only over data already captured in memory: no shell, no git
 * access granted. The server/tool names must compose to
 * CHANGED_FILE_DIFF_TOOL (prompt.ts), which is how the prompt tells the
 * model to call it.
 */
function buildDiffMcpServer(getFileDiff: (path: string) => string | null) {
  return createSdkMcpServer({
    name: "diff",
    version: "1.0.0",
    tools: [
      tool(
        "changed_file_diff",
        "Return the unified diff (base...HEAD) of one changed file from this run's diff range. Works for ANY file listed in 'Changed files (name-status)', including one whose hunk was cut or dropped by truncation from the inline patch.",
        { path: z.string().describe("File path exactly as it appears in the name-status list") },
        async ({ path }) => {
          const hunk = getFileDiff(path);
          if (hunk) log.info(`  diff tool: ${path}`);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  hunk ??
                  `No diff found for "${path}" in this run's diff range. Check the exact path in the name-status list (paths are relative to the working directory).`,
              },
            ],
          };
        },
      ),
    ],
  });
}

/**
 * Classify one failing spec into all four causes (plus UNKNOWN) in a single
 * call: it holds the execution evidence AND reads the source itself, so no
 * separate audit runs first. Same resilience contract as diagnose(): read-only
 * tools, JSON-only final message, and any parse failure degrades to UNKNOWN
 * with confidence 0 rather than throwing — the report must always render.
 */
export async function analyzeFailure(
  input: FailureAnalysisPromptInput,
  options: FailureAnalysisOptions,
): Promise<FailureAnalysisOutcome> {
  return scrubOutcome(await classifyFailure(input, options), options.envScrubMap ?? []);
}

/**
 * Mask the profile values the classifier may have quoted: its Read/Grep reach
 * the repository, so a local `.env` is in reach of its prose even when the
 * evidence it was handed is clean. A literal match — a value the model
 * paraphrases still gets through. Only what the classifier authored is
 * covered: the row's other evidence (`failureLogExcerpt`, `diffExcerpt`)
 * passes to the report and the hub as its producer wrote it.
 */
function scrubOutcome(
  outcome: FailureAnalysisOutcome,
  scrubMap: Array<[string, string]>,
): FailureAnalysisOutcome {
  if (scrubMap.length === 0) return outcome;
  const scrub = (text: string): string => scrubEnvValues(text, scrubMap);
  const { analysis } = outcome;
  return {
    ...outcome,
    raw: scrub(outcome.raw),
    analysis: {
      ...analysis,
      headline: scrub(analysis.headline),
      recommendation: scrub(analysis.recommendation),
      reasoning: scrub(analysis.reasoning),
      // `file` stays as written: it is a coordinate into the repository, and
      // masking a path segment would break the pointer it exists to be.
      evidence: analysis.evidence.map((item) => ({
        ...item,
        detail: scrub(item.detail),
      })),
    },
  };
}

/**
 * Pause before the single retry of an errored classification call. Long enough
 * to ride out a transient network/model hiccup, short enough not to stall the
 * report when the error is persistent.
 */
const RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyFailure(
  input: FailureAnalysisPromptInput,
  options: FailureAnalysisOptions,
): Promise<FailureAnalysisOutcome> {
  const prompt = buildFailureAnalysisPrompt(input);
  const invoke = () =>
    invokeClaudeStreaming(
      {
        prompt,
        allowedTools: ["Read", "Grep", "Glob", CHANGED_FILE_DIFF_TOOL],
        mcpServers: { diff: buildDiffMcpServer(options.getFileDiff) },
        silenceBashLog: true,
        maxTurns: 12,
        ...(options.model ? { model: options.model } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      () => {},
    );

  let { result: raw, isError } = await invoke();
  // One retry, exactly once: an errored invocation is usually a transient
  // SDK/network failure, and settling for UNKNOWN 0% on the first miss leaves
  // the notification unable to say anything but "the run failed". Capped at
  // one so a persistent outage cannot multiply the run's Claude spend.
  let retried = false;
  if (isError) {
    log.warn("failure analysis: Claude invocation errored — retrying once");
    await sleep(RETRY_DELAY_MS);
    ({ result: raw, isError } = await invoke());
    retried = true;
  }

  if (isError || !raw) {
    const cause = isError ? "Claude returned an error result" : "Claude returned no output";
    return {
      analysis: unknownAnalysis(retried ? `${cause} (after 1 retry)` : cause),
      raw: raw ?? "",
      sdkError: isError,
    };
  }

  // Tracks whether any candidate at least parsed as JSON, so the fall-through
  // message below can tell "the model never produced JSON" apart from "it did,
  // but nothing in it normalised to a usable analysis" — the latter used to be
  // misreported as the former (see normaliseFailureAnalysis's NO_DRIFT case).
  let sawParseableJson = false;
  for (const candidate of extractJsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawParseableJson = true;
    const normalised = normaliseFailureAnalysis(parsed);
    if (normalised) return { analysis: normalised, raw, sdkError: false };
  }

  return {
    analysis: unknownAnalysis(
      sawParseableJson
        ? `no candidate produced a usable analysis: ${truncate(raw, 500)}`
        : `analysis returned no parseable JSON: ${truncate(raw, 500)}`,
    ),
    raw,
    sdkError: false,
  };
}

function unknownAnalysis(reasoning: string): FailureAnalysis {
  return {
    label: "UNKNOWN",
    confidence: 0,
    subDiagnosis: "NONE",
    headline: "",
    recommendation: "",
    evidence: [],
    reasoning,
  };
}

/**
 * Cap on the number of evidence items retained from the LLM's answer. Three
 * is enough to make a case; anything beyond starts to feel like the model
 * rambling. Exported so the renderer can assert the same cap when it ever
 * receives a value that bypassed this normaliser (e.g. legacy reports).
 */
export const MAX_EVIDENCE_ITEMS = 3;

const LABELS: ReadonlySet<string> = new Set(predictedForKind("run"));
const SUB_SET: ReadonlySet<string> = new Set(SUB_DIAGNOSES);
/** `surface` says how a stale test case is repaired; no other cause has one. */
const SURFACED_LABELS: ReadonlySet<string> = new Set(DRIFT_FAILURE_CAUSES);
/** Vocabulary words a run may not answer with: NO_DRIFT is a human grade, not a cause. */
const NON_ANSWERS: ReadonlySet<string> = new Set(
  ACTUAL_CAUSES.filter((c) => !LABELS.has(c)),
);

/**
 * Manual, lenient normalisation (mirrors diagnose's normaliseResult): a
 * missing/extra field should degrade gracefully, not reject the whole
 * prediction — only an unrecognisable label makes the candidate unusable.
 */
export function normaliseFailureAnalysis(parsed: unknown): FailureAnalysis | null {
  if (!isObject(parsed)) return null;
  const label = parsed["label"];
  if (typeof label !== "string") return null;
  if (!LABELS.has(label)) {
    // A word from the grading vocabulary is not unparseable — it is a model
    // answering with something only a human may record. Reporting it as "no
    // parseable JSON" hides the real cause and drops the label itself past
    // the reasoning's truncation.
    if (NON_ANSWERS.has(label)) {
      log.warn(`analysis answered "${label}", a human grade rather than a cause — degrading to UNKNOWN`);
      return unknownAnalysis(
        `the classifier answered ${label}, which only a human grading the row may record — it is not a cause the analysis may report`,
      );
    }
    return null;
  }

  const confidence =
    typeof parsed["confidence"] === "number" ? clamp(parsed["confidence"], 0, 1) : 0;
  const reasoning = typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : "";
  const headline = typeof parsed["headline"] === "string" ? parsed["headline"] : "";
  const recommendation =
    typeof parsed["recommendation"] === "string" ? parsed["recommendation"] : "";
  const rawSub = parsed["subDiagnosis"];
  const subDiagnosis =
    typeof rawSub === "string" && SUB_SET.has(rawSub)
      ? (rawSub as FailureAnalysis["subDiagnosis"])
      : "NONE";

  const evidence: FailureEvidence[] = [];
  if (Array.isArray(parsed["evidence"])) {
    for (const item of parsed["evidence"]) {
      if (!isObject(item)) continue;
      const detail = typeof item["detail"] === "string" ? item["detail"] : null;
      if (detail === null) continue;
      const file = typeof item["file"] === "string" ? item["file"] : undefined;
      evidence.push(file !== undefined ? { file, detail } : { detail });
      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
    }
  }

  // Dropped for the causes that are not about the test case, so a stray
  // surface can't make PRODUCT_BUG render as if it named a half to repair.
  const surface = SURFACED_LABELS.has(label)
    ? DriftSurfaceSchema.safeParse(parsed["surface"])
    : null;

  return {
    label: label as PredictedLabel,
    confidence,
    subDiagnosis,
    headline,
    recommendation,
    evidence,
    reasoning,
    ...(surface?.success ? { surface: surface.data } : {}),
  };
}
