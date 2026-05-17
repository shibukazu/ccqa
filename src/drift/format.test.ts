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
      issues: [
        {
          severity: "ERROR",
          category: "unimplemented",
          stepId: "step-02",
          message: "aria-label 'Submit' not found in source",
          detail: "closest match: 'Send'",
        },
        {
          severity: "WARN",
          category: "granularity",
          stepId: null,
          message: "step bundles three actions",
        },
        { severity: "OK", category: "assertable", stepId: null, message: "all expected strings exist" },
      ],
    },
  ];
}

describe("renderDrift", () => {
  test("text format prints headings, findings, and a totals footer", () => {
    const out = renderDrift(results(), "text", cwd);
    expect(out).toContain("tasks/create");
    expect(out).toContain("ERROR");
    expect(out).toContain("aria-label 'Submit' not found");
    expect(out).toContain("WARN");
    expect(out).toContain("step bundles three actions");
    expect(out).toContain("findings 1 error, 1 warn, 1 ok");
  });

  test("json format produces a parseable single document", () => {
    const out = renderDrift(results(), "json", cwd);
    const parsed = JSON.parse(out);
    expect(parsed.specs).toHaveLength(1);
    expect(parsed.specs[0].feature).toBe("tasks");
    expect(parsed.specs[0].issues).toHaveLength(3);
  });

  test("github format emits one annotation per non-OK issue", () => {
    const out = renderDrift(results(), "github", cwd);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^::error file=.*\.ccqa\/features\/tasks\/test-cases\/create\/spec\.yaml/);
    expect(lines[1]).toMatch(/^::warning file=/);
    expect(out).not.toContain("severity=OK");
  });

  test("github format escapes newlines in the message body", () => {
    const r: SpecResult[] = [
      {
        target,
        ok: true,
        issues: [
          {
            severity: "ERROR",
            category: "assertable",
            stepId: "step-01",
            message: "first line",
            detail: "second line\nthird line",
          },
        ],
      },
    ];
    const out = renderDrift(r, "github", cwd);
    // newlines in the body part are encoded as %0A so the annotation stays on one line.
    expect(out).toContain("%0A");
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  test("spec-level error renders distinctly across formats", () => {
    const r: SpecResult[] = [{ target, ok: false, issues: [], error: "Claude returned an error result" }];
    expect(renderDrift(r, "text", cwd)).toContain("ERROR  Claude returned an error result");
    expect(renderDrift(r, "json", cwd)).toContain('"error":');
    expect(renderDrift(r, "github", cwd)).toContain("::error file=");
  });

  test("empty results still emit a totals footer in text format", () => {
    const out = renderDrift([], "text", cwd);
    expect(out).toContain("specs    0");
    expect(out).toContain("findings 0 error, 0 warn, 0 ok");
  });
});
