import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import * as log from "../cli/logger.ts";
import { clamp, extractJsonCandidates, isObject, truncate } from "../diagnose/diagnose.ts";
import { buildFailureAnalysisPrompt, type FailureAnalysisPromptInput } from "./prompt.ts";
import {
  PREDICTED_LABELS,
  SUB_DIAGNOSES,
  type FailureAnalysis,
  type FailureEvidence,
  type PredictedLabel,
} from "./schema.ts";

export interface FailureAnalysisOutcome {
  /** Parsed and normalised analysis. Never null: unusable output degrades to UNKNOWN. */
  analysis: FailureAnalysis;
  /** Raw assistant text, kept for surfacing what happened when the analysis is weak. */
  raw: string;
  /** True when the SDK reported an error (network / model). */
  sdkError: boolean;
}

/** Fully-qualified name of the on-demand file-diff tool, as the model calls it. */
export const CHANGED_FILE_DIFF_TOOL = "mcp__diff__changed_file_diff";

/**
 * In-process MCP server exposing one tool: the diff hunk of a named changed
 * file. The inline patch in the prompt is only the relatedPaths-scoped seed;
 * this is the pull side — the model fetches hunks for files outside that
 * scope (or truncated inside it) only when it decides they matter, so the
 * full diff never has to ride in the prompt. Read-only over data already
 * captured in memory: no shell, no git access granted.
 */
function buildDiffMcpServer(getFileDiff: ((path: string) => string | null) | undefined) {
  return createSdkMcpServer({
    name: "diff",
    version: "1.0.0",
    tools: [
      tool(
        "changed_file_diff",
        "Return the unified diff (base...HEAD) of one changed file from this run's diff range. Works for ANY file listed in 'Changed files (name-status)', including files outside the spec's relatedPaths scope whose hunks are not in the inline patch.",
        { path: z.string().describe("File path exactly as it appears in the name-status list") },
        async ({ path }) => {
          const hunk = getFileDiff ? getFileDiff(path) : null;
          if (hunk) log.info(`  diff tool: ${path}`);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  hunk ??
                  (getFileDiff
                    ? `No diff found for "${path}" in this run's diff range. Check the exact path in the name-status list (paths are relative to the working directory).`
                    : "No diff context is available for this run."),
              },
            ],
          };
        },
      ),
    ],
  });
}

/**
 * Classify one failing spec into TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG /
 * UNKNOWN. Same resilience contract as diagnose(): read-only tools, JSON-only
 * final message, and any parse failure degrades to UNKNOWN with confidence 0
 * rather than throwing — the report must always render.
 */
export async function analyzeFailure(
  input: FailureAnalysisPromptInput,
  options: { model?: string; cwd?: string; getFileDiff?: (path: string) => string | null } = {},
): Promise<FailureAnalysisOutcome> {
  const prompt = buildFailureAnalysisPrompt(input);
  const { result: raw, isError } = await invokeClaudeStreaming(
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

  if (isError || !raw) {
    return {
      analysis: unknownAnalysis(
        isError ? "Claude returned an error result" : "Claude returned no output",
      ),
      raw: raw ?? "",
      sdkError: isError,
    };
  }

  for (const candidate of extractJsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const normalised = normaliseFailureAnalysis(parsed);
    if (normalised) return { analysis: normalised, raw, sdkError: false };
  }

  return {
    analysis: unknownAnalysis(
      `analysis returned no parseable JSON: ${truncate(raw, 500)}`,
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

const LABELS: ReadonlySet<string> = new Set(PREDICTED_LABELS);
const SUB_SET: ReadonlySet<string> = new Set(SUB_DIAGNOSES);

/**
 * Manual, lenient normalisation (mirrors diagnose's normaliseResult): a
 * missing/extra field should degrade gracefully, not reject the whole
 * prediction — only an unrecognisable label makes the candidate unusable.
 */
export function normaliseFailureAnalysis(parsed: unknown): FailureAnalysis | null {
  if (!isObject(parsed)) return null;
  const label = parsed["label"];
  if (typeof label !== "string" || !LABELS.has(label)) return null;

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

  return {
    label: label as PredictedLabel,
    confidence,
    subDiagnosis,
    headline,
    recommendation,
    evidence,
    reasoning,
  };
}
