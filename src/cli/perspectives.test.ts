import { describe, expect, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  extractNotes,
  mergePerspectives,
  parseSummaries,
  withoutGeneratedAt,
  type SummaryEntry,
} from "./perspectives.ts";
import { extractRelatedPaths, upsertSpec } from "./perspectives-sync.ts";
import { PerspectivesSchema, type PerspectiveFeature, type Perspectives, type PerspectiveSpec } from "../types.ts";

const skeleton: PerspectiveFeature[] = [
  {
    featureName: "tasks",
    specs: [
      {
        specName: "search-tasks",
        title: "項目を検索できる",
        summary: "",
        status: { mode: "deterministic", traced: true, generated: true },
        relatedPaths: ["src/features/tasks/**"],
      },
    ],
  },
];

describe("PerspectivesSchema", () => {
  test("accepts a minimal valid inventory", () => {
    const parsed = PerspectivesSchema.parse({
      features: [
        {
          featureName: "f",
          specs: [
            { specName: "s", title: "t", summary: "", status: { mode: "deterministic", traced: false, generated: false } },
          ],
        },
      ],
    });
    expect(parsed.features).toHaveLength(1);
  });

  test("allows an optional note and omitted relatedPaths", () => {
    const parsed = PerspectivesSchema.parse({
      features: [
        {
          featureName: "f",
          specs: [
            {
              specName: "s",
              title: "t",
              summary: "checks login",
              status: { mode: "deterministic", traced: true, generated: true },
              note: "owned by QA team",
            },
          ],
        },
      ],
    });
    expect(parsed.features[0]?.specs[0]?.note).toBe("owned by QA team");
  });

  test("rejects a severity-like unknown key (the boundary we care about)", () => {
    expect(() =>
      PerspectivesSchema.parse({
        features: [
          {
            featureName: "f",
            specs: [
              {
                specName: "s",
                title: "t",
                summary: "",
                status: { mode: "deterministic", traced: false, generated: false },
                severity: "high",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("parseSummaries", () => {
  test("parses well-formed summary entries", () => {
    const out = parseSummaries(
      JSON.stringify({
        summaries: [{ featureName: "f", specName: "s", summary: "verifies search" }],
      }),
    );
    expect(out).toEqual([{ featureName: "f", specName: "s", summary: "verifies search" }]);
  });

  test("drops entries with missing/typed-wrong fields but keeps valid ones", () => {
    const out = parseSummaries(
      JSON.stringify({
        summaries: [
          { featureName: "f", specName: "s", summary: "ok" },
          { featureName: "f", specName: 1, summary: "bad specName" },
          { featureName: "f" },
        ],
      }),
    );
    expect(out).toEqual([{ featureName: "f", specName: "s", summary: "ok" }]);
  });

  test("returns null when the payload is not valid JSON", () => {
    expect(parseSummaries("not json")).toBeNull();
  });

  test("returns null (does not throw) when the payload parses to null or a primitive", () => {
    // `JSON.parse("null")` / `"123"` are valid JSON but not objects; the
    // property access must not throw an uncaught TypeError.
    expect(parseSummaries("null")).toBeNull();
    expect(parseSummaries("123")).toBeNull();
    expect(parseSummaries('"a string"')).toBeNull();
  });

  test("returns null when `summaries` is not an array", () => {
    expect(parseSummaries(JSON.stringify({ summaries: {} }))).toBeNull();
  });

  test("parses the optional QA-table fields when present", () => {
    const out = parseSummaries(
      JSON.stringify({
        summaries: [
          {
            featureName: "f",
            specName: "s",
            summary: "verifies search",
            startScreen: "一覧画面 (/items)",
            testCondition: "管理者でログイン済み",
            preconditions: ["管理者でログイン", ""],
          },
        ],
      }),
    );
    expect(out).toEqual([
      {
        featureName: "f",
        specName: "s",
        summary: "verifies search",
        startScreen: "一覧画面 (/items)",
        testCondition: "管理者でログイン済み",
        preconditions: ["管理者でログイン"], // empty string filtered out
      },
    ]);
  });

  test("omits empty optional fields rather than emitting blank values", () => {
    const out = parseSummaries(
      JSON.stringify({
        summaries: [
          { featureName: "f", specName: "s", summary: "ok", startScreen: "", preconditions: [] },
        ],
      }),
    );
    expect(out).toEqual([{ featureName: "f", specName: "s", summary: "ok" }]);
  });
});

describe("mergePerspectives", () => {
  test("fills summaries matched by feature/spec and timestamps the result", () => {
    const summaries: SummaryEntry[] = [
      { featureName: "tasks", specName: "search-tasks", summary: "検索できることを確認" },
    ];
    const merged = mergePerspectives(skeleton, summaries, new Map());
    expect(merged.features[0]?.specs[0]?.summary).toBe("検索できることを確認");
    expect(merged.generatedAt).toBeDefined();
  });

  test("leaves summary empty when Claude returned no match", () => {
    const merged = mergePerspectives(skeleton, [], new Map());
    expect(merged.features[0]?.specs[0]?.summary).toBe("");
  });

  test("preserves a human note for the matching spec", () => {
    const noteMap = new Map([["tasks/search-tasks", "manual-only"]]);
    const merged = mergePerspectives(skeleton, [], noteMap);
    expect(merged.features[0]?.specs[0]?.note).toBe("manual-only");
  });

  test("does not invent a note for specs without one", () => {
    const merged = mergePerspectives(skeleton, [], new Map());
    expect(merged.features[0]?.specs[0]?.note).toBeUndefined();
  });

  test("merges the QA-table fields from the summary entry", () => {
    const summaries: SummaryEntry[] = [
      {
        featureName: "tasks",
        specName: "search-tasks",
        summary: "検索できることを確認",
        startScreen: "一覧画面 (/items)",
        testCondition: "管理者でログイン済み",
        preconditions: ["管理者でログイン"],
      },
    ];
    const merged = mergePerspectives(skeleton, summaries, new Map());
    const spec = merged.features[0]?.specs[0];
    expect(spec?.startScreen).toBe("一覧画面 (/items)");
    expect(spec?.testCondition).toBe("管理者でログイン済み");
    expect(spec?.preconditions).toEqual(["管理者でログイン"]);
  });

  test("leaves QA-table fields undefined when the summary omits them", () => {
    const summaries: SummaryEntry[] = [
      { featureName: "tasks", specName: "search-tasks", summary: "s" },
    ];
    const merged = mergePerspectives(skeleton, summaries, new Map());
    const spec = merged.features[0]?.specs[0];
    expect(spec?.startScreen).toBeUndefined();
    expect(spec?.preconditions).toBeUndefined();
  });
});

describe("withoutGeneratedAt (no-op detection ignores the timestamp)", () => {
  test("two serialisations differing only in generatedAt compare equal", () => {
    const a = stringifyYaml({
      generatedAt: "2026-05-26T00:00:00.000Z",
      features: [
        {
          featureName: "f",
          specs: [{ specName: "s", title: "t", summary: "x", status: { mode: "deterministic", traced: true, generated: true } }],
        },
      ],
    });
    const b = stringifyYaml({
      generatedAt: "2026-05-26T09:99:99.999Z", // different stamp, same content
      features: [
        {
          featureName: "f",
          specs: [{ specName: "s", title: "t", summary: "x", status: { mode: "deterministic", traced: true, generated: true } }],
        },
      ],
    });
    expect(a).not.toBe(b); // raw strings differ on the timestamp line
    expect(withoutGeneratedAt(a)).toBe(withoutGeneratedAt(b)); // but substantive content matches
  });

  test("a real content change is still detected", () => {
    const a = stringifyYaml({
      generatedAt: "2026-05-26T00:00:00.000Z",
      features: [
        {
          featureName: "f",
          specs: [{ specName: "s", title: "t", summary: "old", status: { mode: "deterministic", traced: true, generated: true } }],
        },
      ],
    });
    const b = stringifyYaml({
      generatedAt: "2026-05-26T00:00:00.000Z",
      features: [
        {
          featureName: "f",
          specs: [{ specName: "s", title: "t", summary: "new", status: { mode: "deterministic", traced: true, generated: true } }],
        },
      ],
    });
    expect(withoutGeneratedAt(a)).not.toBe(withoutGeneratedAt(b));
  });
});

describe("extractNotes (round-trip note preservation)", () => {
  test("recovers notes from the hub's current document", () => {
    const prior = {
      generatedAt: "2026-05-25T00:00:00.000Z",
      features: [
        {
          featureName: "tasks",
          specs: [
            {
              specName: "search-tasks",
              title: "項目を検索できる",
              summary: "old summary that will be regenerated",
              status: { mode: "deterministic", traced: true, generated: true },
              note: "deliberately kept by a human",
            },
          ],
        },
      ],
    };
    const notes = extractNotes(prior);
    expect(notes.get("tasks/search-tasks")).toBe("deliberately kept by a human");
  });

  test("regression: a fresh skeleton + extracted notes keeps the human note", () => {
    const prior = {
      features: [
        {
          featureName: "tasks",
          specs: [
            {
              specName: "search-tasks",
              title: "old title",
              summary: "old",
              status: { mode: "deterministic", traced: false, generated: false },
              note: "QA-owned note",
            },
          ],
        },
      ],
    };
    const notes = extractNotes(prior);
    // New skeleton has a fresh summary/status; the note must still survive.
    const merged = mergePerspectives(
      skeleton,
      [{ featureName: "tasks", specName: "search-tasks", summary: "new summary" }],
      notes,
    );
    const spec = merged.features[0]?.specs[0];
    expect(spec?.summary).toBe("new summary");
    expect(spec?.note).toBe("QA-owned note");
  });

  test("returns an empty map for an absent or schema-mismatched document", () => {
    expect(extractNotes(null).size).toBe(0);
    expect(extractNotes(undefined).size).toBe(0);
    expect(extractNotes("not an object").size).toBe(0);
    expect(extractNotes({ features: [{ bogus: true }] }).size).toBe(0);
  });
});

describe("upsertSpec (incremental record/generate sync)", () => {
  const entry = (specName: string): PerspectiveSpec => ({
    specName,
    title: "t",
    summary: "s",
    status: { mode: "deterministic", traced: true, generated: true },
  });

  test("replaces an existing spec entry in place", () => {
    const doc: Perspectives = {
      features: [{ featureName: "tasks", specs: [{ ...entry("search-tasks"), summary: "old", note: "keep me" }] }],
    };
    upsertSpec(doc, "tasks", { ...entry("search-tasks"), note: "keep me" });
    expect(doc.features[0]?.specs).toHaveLength(1);
    expect(doc.features[0]?.specs[0]?.summary).toBe("s");
    expect(doc.features[0]?.specs[0]?.note).toBe("keep me");
  });

  test("inserts a new spec name-sorted within its feature", () => {
    const doc: Perspectives = {
      features: [{ featureName: "tasks", specs: [entry("a-spec"), entry("z-spec")] }],
    };
    upsertSpec(doc, "tasks", entry("m-spec"));
    expect(doc.features[0]?.specs.map((s) => s.specName)).toEqual(["a-spec", "m-spec", "z-spec"]);
  });

  test("creates a missing feature and keeps features name-sorted", () => {
    const doc: Perspectives = {
      features: [{ featureName: "auth", specs: [entry("login")] }, { featureName: "tasks", specs: [entry("a")] }],
    };
    upsertSpec(doc, "notifications", entry("assign"));
    expect(doc.features.map((f) => f.featureName)).toEqual(["auth", "notifications", "tasks"]);
  });
});

describe("extractRelatedPaths", () => {
  test("transcribes string entries verbatim and drops non-strings", () => {
    const yaml = ["title: t", "relatedPaths:", "  - src/features/tasks/**", "  - 42"].join("\n");
    expect(extractRelatedPaths(yaml)).toEqual(["src/features/tasks/**"]);
  });

  test("returns empty for a spec without relatedPaths or unparsable YAML", () => {
    expect(extractRelatedPaths("title: t")).toEqual([]);
    expect(extractRelatedPaths(": : not yaml : :")).toEqual([]);
  });
});
