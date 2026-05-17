import { describe, expect, test } from "vitest";
import { ensureUnique, extractJsonBlock, sanitizeNamePart } from "./draft.ts";
import { DraftNamingSchema, DraftReportSchema } from "../types.ts";

describe("extractJsonBlock", () => {
  test("returns null for empty / non-json text", () => {
    expect(extractJsonBlock("")).toBeNull();
    expect(extractJsonBlock("hello")).toBeNull();
  });

  test("extracts a fenced ```json block", () => {
    const out = extractJsonBlock('prefix\n```json\n{"a":1}\n```\nsuffix');
    expect(out).toBe('{"a":1}');
  });

  test("extracts a fence without language tag", () => {
    const out = extractJsonBlock('```\n{"x":2}\n```');
    expect(out).toBe('{"x":2}');
  });

  test("returns the first fenced block when several exist", () => {
    const out = extractJsonBlock('```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```');
    expect(out).toBe('{"a":1}');
  });

  test("falls back to bare json object", () => {
    const out = extractJsonBlock('{"a":3}');
    expect(out).toBe('{"a":3}');
  });

  test("does not fall back when text is partial json", () => {
    expect(extractJsonBlock('garbage {"a":3} more')).toBeNull();
  });
});

describe("DraftReportSchema", () => {
  test("accepts a minimal valid report", () => {
    const parsed = DraftReportSchema.parse({ issues: [], patch: "" });
    expect(parsed.issues).toEqual([]);
    expect(parsed.patch).toBe("");
  });

  test("accepts an issue with all fields", () => {
    const parsed = DraftReportSchema.parse({
      issues: [
        {
          severity: "ERROR",
          category: "assertable",
          stepId: "step-02",
          message: "Expected text not found in code",
          detail: "searched for 'Done' under src/",
        },
      ],
      patch: "title: demo\nsteps:\n  - instruction: i\n    expected: e\n",
    });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.severity).toBe("ERROR");
  });

  test("rejects unknown severity", () => {
    expect(() =>
      DraftReportSchema.parse({
        issues: [{ severity: "BOOM", category: "assertable", stepId: null, message: "x" }],
        patch: "",
      }),
    ).toThrow();
  });

  test("rejects missing patch", () => {
    expect(() => DraftReportSchema.parse({ issues: [] })).toThrow();
  });

  test("allows null stepId", () => {
    const parsed = DraftReportSchema.parse({
      issues: [{ severity: "WARN", category: "granularity", stepId: null, message: "ok" }],
      patch: "",
    });
    expect(parsed.issues[0]?.stepId).toBeNull();
  });
});

describe("DraftNamingSchema", () => {
  test("accepts a valid naming response", () => {
    const parsed = DraftNamingSchema.parse({
      featureName: "tasks",
      specName: "create-and-complete",
      reason: "fits existing area",
    });
    expect(parsed.featureName).toBe("tasks");
  });

  test("reason is optional", () => {
    const parsed = DraftNamingSchema.parse({
      featureName: "auth",
      specName: "login-with-email",
    });
    expect(parsed.reason).toBeUndefined();
  });

  test("rejects empty featureName", () => {
    expect(() => DraftNamingSchema.parse({ featureName: "", specName: "x" })).toThrow();
  });
});

describe("sanitizeNamePart", () => {
  test("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(sanitizeNamePart("Create And Complete")).toBe("create-and-complete");
    expect(sanitizeNamePart("Task_List/View")).toBe("task-list-view");
  });

  test("trims leading/trailing hyphens", () => {
    expect(sanitizeNamePart("---hello---")).toBe("hello");
    expect(sanitizeNamePart("  spaced  ")).toBe("spaced");
  });

  test("collapses repeated separators", () => {
    expect(sanitizeNamePart("a   b___c")).toBe("a-b-c");
  });

  test("returns empty string when no valid chars", () => {
    expect(sanitizeNamePart("***")).toBe("");
    expect(sanitizeNamePart("")).toBe("");
  });

  test("caps length at 60 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeNamePart(long).length).toBe(60);
  });
});

describe("ensureUnique", () => {
  test("returns input unchanged when feature does not exist", () => {
    const out = ensureUnique([], "tasks", "create");
    expect(out).toEqual({ featureName: "tasks", specName: "create" });
  });

  test("returns input unchanged when specName is free", () => {
    const tree = [{ featureName: "tasks", specs: [{ specName: "delete" }] }];
    expect(ensureUnique(tree, "tasks", "create")).toEqual({ featureName: "tasks", specName: "create" });
  });

  test("appends -2 when specName collides once", () => {
    const tree = [{ featureName: "tasks", specs: [{ specName: "create" }] }];
    expect(ensureUnique(tree, "tasks", "create")).toEqual({ featureName: "tasks", specName: "create-2" });
  });

  test("walks suffixes until free", () => {
    const tree = [
      {
        featureName: "tasks",
        specs: [{ specName: "create" }, { specName: "create-2" }, { specName: "create-3" }],
      },
    ];
    expect(ensureUnique(tree, "tasks", "create")).toEqual({ featureName: "tasks", specName: "create-4" });
  });
});
