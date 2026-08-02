import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../claude/invoke.ts", () => ({ invokeClaudeStreaming: vi.fn() }));
const { invokeClaudeStreaming } = await import("../claude/invoke.ts");
const { analyzeFailure, normaliseFailureAnalysis } = await import("./analyze.ts");

const NO_COST = {
  totalCostUsd: null,
  durationMs: null,
  durationApiMs: null,
  numTurns: null,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  models: [],
};

function claudeResult(result: string): Awaited<ReturnType<typeof invokeClaudeStreaming>> {
  return { result, isError: false, errorDetail: null, cost: NO_COST };
}

const MINIMAL_INPUT = { specYaml: "title: x", diffPatch: null, changedFiles: null, baseRef: null };
const MINIMAL_OPTIONS = { getFileDiff: () => null };

beforeEach(() => {
  vi.mocked(invokeClaudeStreaming).mockReset();
});

describe("normaliseFailureAnalysis", () => {
  test("accepts a well-formed analysis", () => {
    const out = normaliseFailureAnalysis({
      label: "SPEC_CHANGE",
      confidence: 0.8,
      surface: "spec",
      subDiagnosis: "NONE",
      headline: "Confirm dialog the spec asserts was removed",
      evidence: [{ file: "src/page.tsx (hunk @@ -10,4)", detail: "step's button removed" }],
      recommendation: "Re-draft the spec to match the new flow",
      reasoning: "the diff deletes the confirm dialog the spec asserts",
    });
    expect(out).toEqual({
      label: "SPEC_CHANGE",
      confidence: 0.8,
      surface: "spec",
      subDiagnosis: "NONE",
      headline: "Confirm dialog the spec asserts was removed",
      evidence: [{ file: "src/page.tsx (hunk @@ -10,4)", detail: "step's button removed" }],
      recommendation: "Re-draft the spec to match the new flow",
      reasoning: "the diff deletes the confirm dialog the spec asserts",
    });
  });

  test("keeps `surface` only where it means something — the two test-case causes", () => {
    expect(normaliseFailureAnalysis({ label: "TEST_DRIFT", surface: "generated" })?.surface).toBe("generated");
    expect(normaliseFailureAnalysis({ label: "PRODUCT_BUG", surface: "generated" })).not.toHaveProperty("surface");
    expect(normaliseFailureAnalysis({ label: "TEST_DRIFT", surface: "nonsense" })).not.toHaveProperty("surface");
  });

  test("rejects an unknown label (caller falls through to the next JSON candidate)", () => {
    expect(normaliseFailureAnalysis({ label: "FLAKY", confidence: 0.9 })).toBeNull();
  });

  test("a human-only grade (NO_DRIFT) degrades to UNKNOWN naming it, instead of being rejected as unparseable", () => {
    const out = normaliseFailureAnalysis({ label: "NO_DRIFT", confidence: 0.9 });
    expect(out).not.toBeNull();
    expect(out?.label).toBe("UNKNOWN");
    expect(out?.confidence).toBe(0);
    expect(out?.reasoning).toContain("NO_DRIFT");
  });

  test("every cause the run may answer is accepted", () => {
    for (const label of ["TEST_DRIFT", "SPEC_CHANGE", "PRODUCT_BUG", "ENVIRONMENT", "UNKNOWN"]) {
      expect(normaliseFailureAnalysis({ label })?.label).toBe(label);
    }
  });

  test("rejects non-objects", () => {
    expect(normaliseFailureAnalysis(null)).toBeNull();
    expect(normaliseFailureAnalysis("PRODUCT_BUG")).toBeNull();
    expect(normaliseFailureAnalysis([1, 2])).toBeNull();
  });

  test("missing optional fields degrade gracefully", () => {
    const out = normaliseFailureAnalysis({ label: "PRODUCT_BUG" });
    expect(out).toEqual({
      label: "PRODUCT_BUG",
      confidence: 0,
      subDiagnosis: "NONE",
      headline: "",
      recommendation: "",
      evidence: [],
      reasoning: "",
    });
  });

  test("clamps out-of-range confidence", () => {
    expect(normaliseFailureAnalysis({ label: "UNKNOWN", confidence: 7 })?.confidence).toBe(1);
    expect(normaliseFailureAnalysis({ label: "UNKNOWN", confidence: -1 })?.confidence).toBe(0);
  });

  test("invalid subDiagnosis falls back to NONE", () => {
    const out = normaliseFailureAnalysis({ label: "PRODUCT_BUG", subDiagnosis: "WEIRD" });
    expect(out?.subDiagnosis).toBe("NONE");
  });

  test("malformed evidence entries are dropped, valid ones kept", () => {
    const out = normaliseFailureAnalysis({
      label: "PRODUCT_BUG",
      evidence: [
        { detail: "kept, log-only" },
        { file: "a.ts:1" }, // no detail → dropped
        "not an object",
        { file: "b.ts:2", detail: "kept, with file" },
      ],
    });
    expect(out?.evidence).toEqual([
      { detail: "kept, log-only" },
      { file: "b.ts:2", detail: "kept, with file" },
    ]);
  });
});

describe("analyzeFailure", () => {
  test("a human-only grade degrades to UNKNOWN end-to-end, not the generic unparseable-JSON message", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      claudeResult('```json\n{"label":"NO_DRIFT","confidence":0.9}\n```'),
    );
    const { analysis } = await analyzeFailure(MINIMAL_INPUT, MINIMAL_OPTIONS);
    expect(analysis.label).toBe("UNKNOWN");
    expect(analysis.reasoning).toContain("NO_DRIFT");
    expect(analysis.reasoning).not.toContain("no parseable JSON");
  });

  test("JSON that parses but never normalises reports 'no candidate produced a usable analysis'", async () => {
    // Valid JSON, but not an object — every candidate fails normalisation.
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(claudeResult("```json\n[1,2,3]\n```"));
    const { analysis } = await analyzeFailure(MINIMAL_INPUT, MINIMAL_OPTIONS);
    expect(analysis.label).toBe("UNKNOWN");
    expect(analysis.reasoning).toContain("no candidate produced a usable analysis");
  });

  test("output with no JSON at all still reports 'no parseable JSON'", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(claudeResult("I could not classify this failure."));
    const { analysis } = await analyzeFailure(MINIMAL_INPUT, MINIMAL_OPTIONS);
    expect(analysis.label).toBe("UNKNOWN");
    expect(analysis.reasoning).toContain("no parseable JSON");
  });

  test("a resolved value the classifier quoted is masked in every field it authored", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      claudeResult(
        "```json\n" +
          JSON.stringify({
            label: "ENVIRONMENT",
            confidence: 0.7,
            headline: "signed in as user@example.com",
            recommendation: "check user@example.com exists",
            reasoning: "the repo's .env sets LOGIN_EMAIL=user@example.com",
            evidence: [{ file: ".env", detail: "user@example.com" }],
          }) +
          "\n```",
      ),
    );
    const { analysis } = await analyzeFailure(MINIMAL_INPUT, {
      ...MINIMAL_OPTIONS,
      envScrubMap: [["user@example.com", "${LOGIN_EMAIL}"]],
    });
    expect(analysis.headline).toBe("signed in as ${LOGIN_EMAIL}");
    expect(analysis.recommendation).toBe("check ${LOGIN_EMAIL} exists");
    expect(analysis.reasoning).not.toContain("user@example.com");
    expect(analysis.evidence).toEqual([{ file: ".env", detail: "${LOGIN_EMAIL}" }]);
  });
});
