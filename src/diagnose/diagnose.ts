import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { buildDiagnosePrompt, type DiagnosePromptInput } from "./prompt.ts";
import type {
  Diagnosis,
  DiagnosisResult,
  SleepFix,
} from "./types.ts";

export interface DiagnoseOutcome {
  /** Parsed and normalised diagnosis. null when the LLM produced literally nothing usable. */
  result: DiagnosisResult | null;
  /** Raw assistant text from the SDK, useful for surfacing what happened when result is null or weak. */
  raw: string;
  /** True when the SDK reported an error (network / model). */
  sdkError: boolean;
}

export async function diagnose(
  input: DiagnosePromptInput,
  options: { model?: string } = {},
): Promise<DiagnoseOutcome> {
  const prompt = buildDiagnosePrompt(input);
  // Allow read-only filesystem inspection so the LLM can grep the app's
  // source for the actual aria-label / placeholder / role values when the
  // failure log alone is not enough to classify the failure (the common
  // SELECTOR_DRIFT case). No Bash, no Write, no WebFetch — diagnose must
  // never mutate state. maxTurns is bumped so the model can run a few
  // grep/read turns before producing the final JSON.
  //
  // 20 (was 10): in practice 10 was tight enough that any non-trivial
  // failure — e.g. asserting a common Japanese word that also appears in
  // unrelated sidebar copy — burned the budget on `Grep` candidates before
  // the model could commit to a label, and the SDK then surfaced "Reached
  // maximum number of turns" as a thrown error. 20 gives roughly twice the
  // exploration headroom while staying well under the per-spec vitest
  // timeout (5 min); the auto-fix loop already catches throws from the
  // SDK, so this is purely a precision improvement, not a safety change.
  const { result: raw, isError } = await invokeClaudeStreaming(
    {
      prompt,
      allowedTools: ["Read", "Grep", "Glob"],
      maxTurns: 20,
      model: options.model,
    },
    () => {},
  );
  if (isError) return { result: null, raw: raw ?? "", sdkError: true };
  if (!raw) return { result: null, raw: "", sdkError: false };

  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const normalised = normaliseResult(parsed);
    if (normalised) return { result: normalised, raw, sdkError: false };
  }

  // Fall back to UNKNOWN so the caller can still hand off to the user
  // with *some* context. Better to say "the LLM said X but didn't produce
  // valid JSON we could match" than to disappear silently.
  return {
    result: {
      diagnosis: { type: "UNKNOWN", reason: "diagnose returned no parseable diagnosis JSON" },
      confidence: 0,
      reasoning: truncate(raw, 1000),
    },
    raw,
    sdkError: false,
  };
}

/**
 * Pull every plausible JSON object out of `raw`. We try, in order:
 *   1. The whole string with code fences stripped (the prompt asks for
 *      JSON-only, so this is the happy path).
 *   2. Each balanced `{...}` block found by scanning the text. The model
 *      sometimes prefixes the JSON with a "Confirmed: ..." sentence or
 *      mentions partial JSON in its tool-using reasoning; we want to
 *      try the *last* well-formed object first because it's most likely
 *      the final answer, then earlier ones as a fallback.
 *
 * The caller `JSON.parse`s each candidate and stops at the first match
 * that normalises to a known DiagnosisResult.
 */
export function extractJsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const stripped = stripFence(raw);
  if (stripped) out.push(stripped);

  // Scan for balanced {...} blocks. Strings/escapes are tracked so braces
  // inside string literals don't break the depth count.
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // Latest balanced block first — that's the LLM's final answer when it
  // narrated before/after.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (!out.includes(block)) out.push(block);
  }
  return out;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}... [truncated, ${s.length - max} more chars]`;
}

export function stripFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

export function normaliseResult(parsed: unknown): DiagnosisResult | null {
  if (!isObject(parsed)) return null;
  const diagnosis = normaliseDiagnosis(parsed["diagnosis"]);
  if (!diagnosis) return null;
  const confidence = typeof parsed["confidence"] === "number" ? clamp(parsed["confidence"], 0, 1) : 0;
  const reasoning = typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : "";
  return { diagnosis, confidence, reasoning };
}

function normaliseDiagnosis(raw: unknown): Diagnosis | null {
  if (!isObject(raw)) return null;
  const type = raw["type"];

  switch (type) {
    case "TIMING_ISSUE": {
      const fixes = normaliseSleepFixes(raw["fixes"]);
      if (fixes.length === 0) return null;
      return { type: "TIMING_ISSUE", fixes };
    }
    case "OVER_ASSERTION": {
      const lines = Array.isArray(raw["lines"])
        ? raw["lines"].filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        : [];
      if (lines.length === 0) return null;
      const reason = typeof raw["reason"] === "string" ? raw["reason"] : "";
      return { type: "OVER_ASSERTION", lines, reason };
    }
    case "SELECTOR_DRIFT": {
      const line = typeof raw["line"] === "number" ? raw["line"] : null;
      const oldSelector = typeof raw["oldSelector"] === "string" ? raw["oldSelector"] : null;
      const newSelector = typeof raw["newSelector"] === "string" ? raw["newSelector"] : null;
      if (line === null || !oldSelector || !newSelector) return null;
      const reason = typeof raw["reason"] === "string" ? raw["reason"] : "";
      return { type: "SELECTOR_DRIFT", line, oldSelector, newSelector, reason };
    }
    case "DATA_MISSING": {
      const reason = typeof raw["reason"] === "string" ? raw["reason"] : "";
      return { type: "DATA_MISSING", reason };
    }
    case "UNKNOWN": {
      const reason = typeof raw["reason"] === "string" ? raw["reason"] : "";
      return { type: "UNKNOWN", reason };
    }
    default:
      return null;
  }
}

function normaliseSleepFixes(raw: unknown): SleepFix[] {
  if (!Array.isArray(raw)) return [];
  const out: SleepFix[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const line = typeof item["line"] === "number" ? item["line"] : null;
    if (line === null) continue;
    const reason = typeof item["reason"] === "string" ? item["reason"] : "";

    if (item["kind"] === "insert") {
      const seconds = typeof item["seconds"] === "number" ? item["seconds"] : null;
      if (seconds === null) continue;
      out.push({ kind: "insert", line, seconds, reason });
    } else if (item["kind"] === "increase") {
      const increaseTo = typeof item["increase_to"] === "number" ? item["increase_to"] : null;
      if (increaseTo === null) continue;
      out.push({ kind: "increase", line, increase_to: increaseTo, reason });
    }
  }
  return out;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
