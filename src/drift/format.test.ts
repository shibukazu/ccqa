import { describe, expect, test } from "vitest";
import { renderDrift } from "./format.ts";
import type { SpecResult } from "./types.ts";

const target = { featureName: "tasks", specName: "create" };
const cwd = "/tmp/proj";

function results(): SpecResult[] {
  return [
    {
      target,
      ok: true,
      drift: {
        label: "TEST_DRIFT",
        confidence: 0.85,
        surface: "generated",
        subDiagnosis: "SELECTOR_DRIFT",
        headline: "aria-label 'Submit' not found in source",
        recommendation: "Update the selector to the new aria-label",
        evidence: [{ file: "src/app.tsx:42", detail: "closest match: 'Send'" }],
        reasoning: "",
      },
    },
  ];
}

describe("renderDrift", () => {
  test("text format prints the heading, the diagnosis, and a totals footer", () => {
    const out = renderDrift(results(), "text", cwd);
    expect(out).toContain("tasks/create");
    expect(out).toContain("ERROR");
    expect(out).toContain("TEST_DRIFT");
    expect(out).toContain("aria-label 'Submit' not found");
    expect(out).toContain("Update the selector");
    expect(out).toContain("src/app.tsx:42");
    expect(out).toContain("findings 1 error, 0 warn, 0 clean");
  });

  test("a clean spec (no drift) renders distinctly from a finding", () => {
    const out = renderDrift([{ target, ok: true, drift: null }], "text", cwd);
    expect(out).toContain("no drift");
    expect(out).toContain("findings 0 error, 0 warn, 1 clean");
  });

  test("json format produces a parseable single document with the diagnosis as-is", () => {
    const out = renderDrift(results(), "json", cwd);
    const parsed = JSON.parse(out);
    expect(parsed.specs).toHaveLength(1);
    expect(parsed.specs[0].feature).toBe("tasks");
    expect(parsed.specs[0].drift).toEqual(results()[0]!.drift);
  });

  test("json format renders drift: null for a clean spec", () => {
    const out = renderDrift([{ target, ok: true, drift: null }], "json", cwd);
    expect(JSON.parse(out).specs[0].drift).toBeNull();
  });

  test("github format emits one error annotation for a TEST_DRIFT/SPEC_CHANGE diagnosis", () => {
    const out = renderDrift(results(), "github", cwd);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::error file=.*\.ccqa\/features\/tasks\/test-cases\/create\/spec\.yaml/);
    expect(lines[0]).toContain("TEST_DRIFT");
  });

  test("github format emits a warning annotation for UNKNOWN", () => {
    const r: SpecResult[] = [
      {
        target,
        ok: true,
        drift: {
          label: "UNKNOWN",
          confidence: 0.3,
          surface: "spec",
          subDiagnosis: "NONE",
          headline: "cannot tell",
          recommendation: "",
          evidence: [],
          reasoning: "",
        },
      },
    ];
    const out = renderDrift(r, "github", cwd);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("::warning file=");
  });

  test("github format escapes newlines in the message body", () => {
    const r: SpecResult[] = [
      {
        target,
        ok: true,
        drift: {
          label: "SPEC_CHANGE",
          confidence: 0.9,
          surface: "spec",
          subDiagnosis: "NONE",
          headline: "first line",
          recommendation: "second line\nthird line",
          evidence: [],
          reasoning: "",
        },
      },
    ];
    const out = renderDrift(r, "github", cwd);
    // newlines in the body part are encoded as %0A so the annotation stays on one line.
    expect(out).toContain("%0A");
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  test("spec-level error renders distinctly across formats", () => {
    const r: SpecResult[] = [{ target, ok: false, drift: null, error: "Claude returned an error result" }];
    expect(renderDrift(r, "text", cwd)).toContain("ERROR  Claude returned an error result");
    expect(renderDrift(r, "json", cwd)).toContain('"error":');
    expect(renderDrift(r, "github", cwd)).toContain("::error file=");
  });

  test("empty results still emit a totals footer in text format", () => {
    const out = renderDrift([], "text", cwd);
    expect(out).toContain("specs    0");
    expect(out).toContain("findings 0 error, 0 warn, 0 clean");
  });
});
