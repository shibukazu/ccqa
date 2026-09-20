import { describe, expect, test, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import * as log from "./logger.ts";
import { caseFromDocument, type TestCase } from "../cases/case.ts";
import { openCaseReader } from "../cases/reader.ts";
import type { CaseRead } from "../cases/source.ts";
import { ProjectConfigSchema } from "../config/project-config.ts";
import {
  buildSkeleton,
  comparePerspectivesSkeleton,
  extractNotes,
  mergePerspectives,
  parseSummaries,
  transcribeSteps,
  withoutGeneratedAt,
  type SummaryEntry,
} from "./perspectives.ts";
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

  test("allows an optional note", () => {
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

  test("strips a severity-like unknown key rather than rejecting the whole document", () => {
    // The schema strips unknown keys (forward-compat for shared hub docs read
    // by older CLIs), so a stray `severity` is dropped — the boundary "severity
    // never enters the stored document" holds, without bricking the reader.
    const parsed = PerspectivesSchema.parse({
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
    });
    expect(parsed.features[0]?.specs[0]).not.toHaveProperty("severity");
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

describe("comparePerspectivesSkeleton (--check)", () => {
  const hubDoc = (over: Partial<PerspectiveSpec> = {}): Perspectives => ({
    generatedAt: "2026-07-13T00:00:00.000Z",
    features: [
      {
        featureName: "tasks",
        specs: [
          {
            specName: "search-tasks",
            title: "項目を検索できる",
            summary: "Claude が書いた要約（比較対象外）",
            startScreen: "一覧画面",
            status: { mode: "deterministic", traced: true, generated: true },
            note: "human note（比較対象外）",
            ...over,
          },
        ],
      },
    ],
  });

  test("in-sync mechanical fields yield no issues — descriptive fields and note are ignored", () => {
    expect(comparePerspectivesSkeleton(skeleton, hubDoc())).toEqual([]);
  });

  // The hub reads this field to decide which specs an audit owes an answer
  // for, so a document that disagrees is exactly the stale case --verify is
  // for — and the only one no other field would surface.
  test("flags a spec turned off locally that the hub still lists as enabled", () => {
    const local: PerspectiveFeature[] = [
      { ...skeleton[0]!, specs: [{ ...skeleton[0]!.specs[0]!, disabled: true }] },
    ];
    expect(comparePerspectivesSkeleton(local, hubDoc())).toEqual([
      "tasks/search-tasks: out of date — disabled",
    ]);
  });

  test("treats absent and false as the same answer, so an older document is not stale", () => {
    expect(comparePerspectivesSkeleton(skeleton, hubDoc({ disabled: false }))).toEqual([]);
  });

  test("flags a local spec missing from the hub and a hub entry with no local spec", () => {
    const localOnly: PerspectiveFeature[] = [
      ...skeleton,
      {
        featureName: "auth",
        specs: [{ specName: "login", title: "t", summary: "", status: { mode: "deterministic", traced: false, generated: false } }],
      },
    ];
    const issues = comparePerspectivesSkeleton(localOnly, {
      features: [
        ...hubDoc().features,
        { featureName: "gone", specs: [{ specName: "old", title: "t", summary: "", status: { mode: "live", traced: false, generated: false } }] },
      ],
    });
    expect(issues).toContain("auth/login: not in the hub document");
    expect(issues).toContain("gone/old: no longer exists locally (stale hub entry)");
    expect(issues).toHaveLength(2);
  });

  test("flags title / status drift on one line per spec", () => {
    const issues = comparePerspectivesSkeleton(skeleton, hubDoc({
      title: "古いタイトル",
      status: { mode: "deterministic", traced: true, generated: false },
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("tasks/search-tasks: out of date");
    expect(issues[0]).toContain("title");
    expect(issues[0]).toContain("generated=false");
  });

  test("flags a target change (agent-browser hub entry vs an external-target local spec)", () => {
    const issues = comparePerspectivesSkeleton(
      [
        {
          featureName: "tasks",
          specs: [
            {
              specName: "search-tasks",
              title: "項目を検索できる",
              summary: "",
              status: { mode: "deterministic", traced: true, generated: true, target: "playwright" },
            },
          ],
        },
      ],
      hubDoc(), // hub entry has no `target` (agent-browser)
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("target=playwright");
  });
});

describe("buildSkeleton", () => {
  /** A source where one case reads and one refuses to. */
  function localCases(): Parameters<typeof buildSkeleton>[0] {
    const read = (id: string, testCase: TestCase | null): CaseRead => ({
      id,
      case: testCase,
      document: { path: `/repo/docs/testcase/${id}.md`, text: "the document" },
      error: testCase === null ? "line 3: could not be read" : null,
    });
    const ok = caseFromDocument(
      {
        id: "todo/add_item",
        path: "/repo/docs/testcase/todo/add_item.md",
        text: "the document",
        title: "Adding an item puts it on the list",
        mode: "deterministic",
        steps: [{ instruction: "Open the todo list" }],
      },
      "/repo",
    );
    return {
      cases: [read("todo/add_item", ok), read("todo/broken", null)],
      config: ProjectConfigSchema.parse({}),
      reader: openCaseReader(ProjectConfigSchema.parse({}), "/repo"),
      where: ".ccqa/features",
    };
  }

  // Dropping it would take the case out of every answer the hub gives —
  // attestation, re-run, audit-need — on no evidence at all.
  test("keeps a case whose document will not read, named by its own id", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const skeleton = await buildSkeleton(localCases());
    warn.mockRestore();

    const specs = skeleton.flatMap((f) => f.specs);
    expect(specs.map((s) => s.specName).sort()).toEqual(["add_item", "broken"]);
    const broken = specs.find((s) => s.specName === "broken")!;
    expect(broken.title).toBe("broken");
    expect(broken.steps).toBeUndefined();
  });

  test("says out loud which case it could not read", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await buildSkeleton(localCases());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("todo/broken"));
    warn.mockRestore();
  });
});

describe("transcribeSteps", () => {
  test("action steps keep instruction/expected, include steps keep only the block name", () => {
    const yaml = parseYaml(
      stringifyYaml({
        title: "a case",
        steps: [
          { include: "login", params: { email: "${A_VAR}" } },
          { instruction: "open the list", expected: "the list shows" },
          { instruction: "press submit" },
          "not-a-step",
        ],
      }),
    ) as { steps: unknown };
    expect(transcribeSteps(yaml.steps)).toEqual([
      { include: "login" },
      { instruction: "open the list", expected: "the list shows" },
      { instruction: "press submit" },
    ]);
  });

  test("a case with no steps transcribes none", () => {
    expect(transcribeSteps(undefined)).toEqual([]);
    expect(transcribeSteps([])).toEqual([]);
  });
});
