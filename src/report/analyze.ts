import { invokeClaudeStreaming } from "../claude/invoke.ts";
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

/**
 * Classify one failing spec into TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG /
 * UNKNOWN. Same resilience contract as diagnose(): read-only tools, JSON-only
 * final message, and any parse failure degrades to UNKNOWN with confidence 0
 * rather than throwing — the report must always render.
 */
export async function analyzeFailure(
  input: FailureAnalysisPromptInput,
  options: { model?: string; cwd?: string } = {},
): Promise<FailureAnalysisOutcome> {
  const prompt = buildFailureAnalysisPrompt(input);
  const { result: raw, isError } = await invokeClaudeStreaming(
    {
      prompt,
      allowedTools: ["Read", "Grep", "Glob"],
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
