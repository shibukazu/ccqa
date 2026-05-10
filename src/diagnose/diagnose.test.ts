import { describe, test, expect } from "vitest";
import { extractJsonCandidates, normaliseResult, stripFence } from "./diagnose.ts";

describe("extractJsonCandidates", () => {
  test("returns the whole stripped string for a clean JSON output", () => {
    const candidates = extractJsonCandidates('{"a": 1}');
    expect(candidates[0]).toBe('{"a": 1}');
  });

  test("recovers JSON when the LLM prefixes a sentence", () => {
    const raw = `Confirmed: aria-label drift.\n\n{"diagnosis":{"type":"UNKNOWN","reason":"x"},"confidence":0.5}`;
    const candidates = extractJsonCandidates(raw);
    const parsedAny = candidates
      .map((c) => {
        try {
          return JSON.parse(c) as { diagnosis?: { type?: string } };
        } catch {
          return null;
        }
      })
      .find((p) => p?.diagnosis?.type === "UNKNOWN");
    expect(parsedAny).toBeTruthy();
  });

  test("ignores braces inside string literals", () => {
    const raw = `noise\n{"reason": "the user said \\"foo} bar\\"","diagnosis":{"type":"UNKNOWN","reason":"x"},"confidence":0.5}`;
    const candidates = extractJsonCandidates(raw);
    const parsed = candidates
      .map((c) => {
        try {
          return JSON.parse(c) as { reason?: string };
        } catch {
          return null;
        }
      })
      .find((p) => p?.reason === 'the user said "foo} bar"');
    expect(parsed).toBeTruthy();
  });

  test("returns the latest balanced block first when multiple objects exist", () => {
    const raw = `{"first":1} stuff {"second":2}`;
    const candidates = extractJsonCandidates(raw);
    // stripFence yields the whole string (not parseable as JSON), then the
    // scanner adds blocks latest-first.
    expect(candidates[1]).toBe('{"second":2}');
    expect(candidates[2]).toBe('{"first":1}');
  });
});

describe("stripFence", () => {
  test("removes ```json fences", () => {
    expect(stripFence("```json\n{\"a\": 1}\n```")).toBe('{"a": 1}');
  });

  test("removes plain ``` fences", () => {
    expect(stripFence("```\n{\"a\": 1}\n```")).toBe('{"a": 1}');
  });

  test("returns trimmed input when no fence", () => {
    expect(stripFence("  {\"a\": 1}  ")).toBe('{"a": 1}');
  });
});

describe("normaliseResult", () => {
  test("parses TIMING_ISSUE with insert+increase fixes (new schema)", () => {
    const result = normaliseResult({
      diagnosis: {
        type: "TIMING_ISSUE",
        fixes: [
          { kind: "insert", line: 12, seconds: 3, reason: "page nav" },
          { kind: "increase", line: 4, increase_to: 6, reason: "slow load" },
        ],
      },
      confidence: 0.92,
      reasoning: "press Enter triggers navigation",
    });
    expect(result?.diagnosis.type).toBe("TIMING_ISSUE");
    expect(result?.confidence).toBe(0.92);
    if (result?.diagnosis.type !== "TIMING_ISSUE") return;
    expect(result.diagnosis.fixes).toHaveLength(2);
    expect(result.diagnosis.fixes[0]).toEqual({ kind: "insert", line: 12, seconds: 3, reason: "page nav" });
    expect(result.diagnosis.fixes[1]).toEqual({ kind: "increase", line: 4, increase_to: 6, reason: "slow load" });
  });

  test("parses TIMING_ISSUE with legacy schema (no kind field)", () => {
    const result = normaliseResult({
      diagnosis: {
        type: "TIMING_ISSUE",
        fixes: [
          { line: 12, seconds: 3, reason: "x" },
          { line: 4, increase_to: 6, reason: "y" },
        ],
      },
      confidence: 0.5,
      reasoning: "",
    });
    if (result?.diagnosis.type !== "TIMING_ISSUE") throw new Error("expected TIMING_ISSUE");
    expect(result.diagnosis.fixes[0]).toEqual({ kind: "insert", line: 12, seconds: 3, reason: "x" });
    expect(result.diagnosis.fixes[1]).toEqual({ kind: "increase", line: 4, increase_to: 6, reason: "y" });
  });

  test("parses OVER_ASSERTION", () => {
    const result = normaliseResult({
      diagnosis: { type: "OVER_ASSERTION", lines: [42, 43], reason: "spec doesn't require" },
      confidence: 0.75,
      reasoning: "",
    });
    if (result?.diagnosis.type !== "OVER_ASSERTION") throw new Error("expected OVER_ASSERTION");
    expect(result.diagnosis.lines).toEqual([42, 43]);
  });

  test("parses SELECTOR_DRIFT", () => {
    const result = normaliseResult({
      diagnosis: {
        type: "SELECTOR_DRIFT",
        line: 22,
        oldSelector: "[aria-label='A']",
        newSelector: "[aria-label='B']",
        reason: "renamed",
      },
      confidence: 0.88,
      reasoning: "snapshot shows B",
    });
    if (result?.diagnosis.type !== "SELECTOR_DRIFT") throw new Error("expected SELECTOR_DRIFT");
    expect(result.diagnosis.oldSelector).toBe("[aria-label='A']");
    expect(result.diagnosis.newSelector).toBe("[aria-label='B']");
  });

  test("parses DATA_MISSING and UNKNOWN", () => {
    expect(normaliseResult({ diagnosis: { type: "DATA_MISSING", reason: "no fixture" }, confidence: 0.4 })?.diagnosis.type).toBe("DATA_MISSING");
    expect(normaliseResult({ diagnosis: { type: "UNKNOWN", reason: "?" }, confidence: 0.2 })?.diagnosis.type).toBe("UNKNOWN");
  });

  test("rejects malformed input", () => {
    expect(normaliseResult(null)).toBeNull();
    expect(normaliseResult({ diagnosis: { type: "??" } })).toBeNull();
    expect(normaliseResult({ diagnosis: { type: "SELECTOR_DRIFT", line: 1 } })).toBeNull();
    expect(normaliseResult({ diagnosis: { type: "TIMING_ISSUE", fixes: [] } })).toBeNull();
  });

  test("clamps confidence to [0, 1]", () => {
    const r = normaliseResult({
      diagnosis: { type: "UNKNOWN", reason: "x" },
      confidence: 5,
    });
    expect(r?.confidence).toBe(1);
    const r2 = normaliseResult({
      diagnosis: { type: "UNKNOWN", reason: "x" },
      confidence: -3,
    });
    expect(r2?.confidence).toBe(0);
  });
});
