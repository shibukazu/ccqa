import { describe, expect, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  extractNotes,
  labelsFor,
  mergePerspectives,
  parseSummaries,
  renderFeatureMarkdown,
  renderIndexMarkdown,
  renderSpecMarkdown,
  statusLabel,
  withoutGeneratedAt,
  type SummaryEntry,
} from "./perspectives.ts";
import { PerspectivesSchema, type PerspectiveFeature, type PerspectiveSpec } from "../types.ts";

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
  test("recovers notes from a previously written perspectives.yaml", () => {
    const prior = stringifyYaml({
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
    });
    const notes = extractNotes(prior);
    expect(notes.get("tasks/search-tasks")).toBe("deliberately kept by a human");
  });

  test("regression: a fresh skeleton + extracted notes keeps the human note", () => {
    const prior = stringifyYaml({
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
    });
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

  test("returns an empty map for empty or unparsable input", () => {
    expect(extractNotes("").size).toBe(0);
    expect(extractNotes(": : not yaml : :").size).toBe(0);
  });
});

describe("renderSpecMarkdown", () => {
  const fullSpec: PerspectiveSpec = {
    specName: "create-and-complete",
    title: "項目を作成して完了にできる",
    summary: "項目を新規作成し、一覧・詳細に反映され、最後に削除されることを確認する。",
    startScreen: "一覧画面 (/items)",
    testCondition: "管理者でログイン済み",
    preconditions: ["管理者でログイン"],
    relatedPaths: ["src/features/items/**"],
    status: { mode: "deterministic", traced: true, generated: true },
    note: "手動確認のみ",
  };

  test("emits the mode and status rows exactly once, positioned between the spec link and the related-code paths", () => {
    const md = renderSpecMarkdown(fullSpec).join("\n");
    // Regression guard for a bug that shipped in 0.8.2 where the mode and
    // status rows were inserted in the new position without removing the
    // old (top-of-table) ones, doubling each row in every detail table.
    const modeMatches = md.match(/\| モード \|/g);
    const statusMatches = md.match(/\| 状態 \|/g);
    expect(modeMatches?.length).toBe(1);
    expect(statusMatches?.length).toBe(1);
    // And they should land between spec and 関連コード, in that order.
    const idxSpec = md.indexOf("| spec |");
    const idxMode = md.indexOf("| モード |");
    const idxStatus = md.indexOf("| 状態 |");
    const idxRelated = md.indexOf("| 関連コード |");
    expect(idxSpec).toBeGreaterThan(-1);
    expect(idxMode).toBeGreaterThan(idxSpec);
    expect(idxStatus).toBeGreaterThan(idxMode);
    expect(idxRelated).toBeGreaterThan(idxStatus);
  });

  test("leads with 検証内容 then 前提条件, drops テスト条件/実装状況, links spec relative to the category file", () => {
    const md = renderSpecMarkdown(fullSpec).join("\n");
    expect(md).toContain("## 項目を作成して完了にできる");
    // 検証内容 comes before 前提条件, which comes before 開始画面.
    const idxSummary = md.indexOf("| 検証内容 |");
    const idxPre = md.indexOf("| 前提条件 |");
    const idxStart = md.indexOf("| 開始画面 |");
    expect(idxSummary).toBeGreaterThan(-1);
    expect(idxSummary).toBeLessThan(idxPre);
    expect(idxPre).toBeLessThan(idxStart);
    expect(md).toContain(
      "| 検証内容 | 項目を新規作成し、一覧・詳細に反映され、最後に削除されることを確認する。 |",
    );
    expect(md).toContain("| 前提条件 | 管理者でログイン |");
    expect(md).toContain("| 開始画面 | 一覧画面 (/items) |");
    // テスト条件 (redundant with 前提条件) and 実装状況 are no longer shown.
    expect(md).not.toContain("テスト条件");
    expect(md).not.toContain("実装状況");
    // spec link is relative to the category file (test-cases/<spec>/...), so
    // it resolves on GitHub and locally.
    expect(md).toContain(
      "| spec | [test-cases/create-and-complete/spec.yaml](test-cases/create-and-complete/spec.yaml) |",
    );
    expect(md).toContain("| 📝 note | 手動確認のみ |");
  });

  test("renders related-code paths as inline code, not links (base is not reliably recoverable)", () => {
    const spec: PerspectiveSpec = {
      specName: "s",
      title: "t",
      summary: "",
      relatedPaths: ["src/features/tasks/**", "src/components/Sidebar.tsx"],
      status: { mode: "deterministic", traced: true, generated: true },
    };
    const md = renderSpecMarkdown(spec).join("\n");
    expect(md).toContain("| 関連コード | `src/features/tasks/**`<br>`src/components/Sidebar.tsx` |");
    // Not linked.
    expect(md).not.toContain("](../../../");
  });

  test("emits everything inside the table — no prose blocks around it", () => {
    const md = renderSpecMarkdown(fullSpec).join("\n");
    expect(md).not.toContain("**前提条件**");
    expect(md).not.toContain("**検証内容**");
    expect(md).not.toContain("> 📝");
  });

  test("does NOT restate detailed steps or per-step expected results", () => {
    const md = renderSpecMarkdown(fullSpec).join("\n");
    expect(md).not.toContain("テスト手順");
    expect(md).not.toContain("期待結果");
  });

  test("omits optional rows when the spec lacks them", () => {
    const minimal: PerspectiveSpec = {
      specName: "s",
      title: "t",
      summary: "",
      status: { mode: "deterministic", traced: false, generated: false },
    };
    const md = renderSpecMarkdown(minimal).join("\n");
    expect(md).not.toContain("検証内容");
    expect(md).not.toContain("前提条件");
    expect(md).not.toContain("開始画面");
    expect(md).not.toContain("note");
    // spec link is always present, relative to the category file.
    expect(md).toContain("| spec | [test-cases/s/spec.yaml]");
  });

  test("escapes pipes so a value stays in one table cell", () => {
    const spec: PerspectiveSpec = {
      specName: "s",
      title: "t",
      summary: "a | b",
      status: { mode: "deterministic", traced: true, generated: true },
    };
    const md = renderSpecMarkdown(spec).join("\n");
    expect(md).toContain("a \\| b");
  });
});

describe("renderIndexMarkdown", () => {
  test("groups cases under each category heading with title and a spec link", () => {
    const md = renderIndexMarkdown({
      generatedAt: "2026-05-25T00:00:00.000Z",
      features: [
        {
          featureName: "tasks",
          specs: [
            {
              specName: "search-tasks",
              title: "検索できる",
              summary: "検索の確認",
              status: { mode: "deterministic", traced: true, generated: true },
            },
            {
              specName: "create-content",
              title: "作成できる",
              summary: "作成の確認",
              status: { mode: "deterministic", traced: true, generated: false },
            },
          ],
        },
      ],
    });
    expect(md).toContain("# テスト観点インデックス (perspectives)");
    // Category heading links to its own detail file, which is written under
    // .ccqa/features/<feature>/perspectives.md — so the link must include the
    // `features/` segment to resolve from the root .ccqa/perspectives.md.
    expect(md).toContain("## [tasks](features/tasks/perspectives.md)");
    // One row per case: title + mode + status + spec link. The mode column
    // declares deterministic vs live; the status column is the runnable
    // verdict so reviewers can scan for what is or isn't ready to run.
    expect(md).toContain(
      "| 検索できる | deterministic | ✅ 実行可能 | [spec](features/tasks/test-cases/search-tasks/spec.yaml) |",
    );
    expect(md).toContain(
      "| 作成できる | deterministic | ⚠️ 未record | [spec](features/tasks/test-cases/create-content/spec.yaml) |",
    );
    // Raw boolean field names should not leak into the user-facing index.
    expect(md).not.toContain("traced:");
    expect(md).not.toContain("generated:");
    // The index is meta only — no per-case summary text leaks in.
    expect(md).not.toContain("検索の確認");
    expect(md).not.toContain("作成の確認");
  });

  test("live specs are always shown as runnable regardless of trace/generate flags", () => {
    const md = renderIndexMarkdown({
      generatedAt: "2026-06-16T00:00:00.000Z",
      features: [
        {
          featureName: "slack",
          specs: [
            {
              specName: "report-bug",
              title: "バグ報告できる",
              summary: "",
              status: { mode: "live", traced: false, generated: false },
            },
          ],
        },
      ],
    });
    // Live specs skip codegen entirely, so a missing test.spec.ts is not a
    // problem — they are always runnable from the reviewer's perspective.
    expect(md).toContain("| バグ報告できる | live | ✅ 実行可能 | [spec](features/slack/test-cases/report-bug/spec.yaml) |");
    expect(md).not.toContain("未record");
  });

  test("deterministic specs without test.spec.ts are shown as not recorded", () => {
    const md = renderIndexMarkdown({
      generatedAt: "2026-06-16T00:00:00.000Z",
      features: [
        {
          featureName: "tasks",
          specs: [
            {
              specName: "skeleton-only",
              title: "骨組みだけ",
              summary: "",
              status: { mode: "deterministic", traced: false, generated: false },
            },
          ],
        },
      ],
    });
    expect(md).toContain("⚠️ 未record");
  });
});

describe("renderFeatureMarkdown", () => {
  test("renders the category heading and one table per case (no boilerplate note)", () => {
    const md = renderFeatureMarkdown({
      featureName: "tasks",
      specs: [
        {
          specName: "search-tasks",
          title: "検索できる",
          summary: "検索の確認",
          status: { mode: "deterministic", traced: true, generated: true },
        },
        {
          specName: "create-content",
          title: "作成できる",
          summary: "作成の確認",
          status: { mode: "deterministic", traced: true, generated: false },
        },
      ],
    });
    expect(md).toContain("# tasks");
    expect(md).toContain("spec.yaml"); // present as the spec link, not a steps restatement
    expect(md).toContain("## 検索できる");
    expect(md).toContain("## 作成できる");
    expect(md).toContain("| 検証内容 | 検索の確認 |");
    expect(md).toContain("| 検証内容 | 作成の確認 |");
    // No boilerplate disclaimer line.
    expect(md).not.toContain(">");
  });
});

describe("labelsFor + English labels", () => {
  test("only an explicit English tag switches labels to English", () => {
    expect(labelsFor("en").summary).toBe("Verifies");
    expect(labelsFor("en-US").itemCol).toBe("Item");
    // auto / ja / undefined keep Japanese.
    expect(labelsFor("auto").summary).toBe("検証内容");
    expect(labelsFor("ja").summary).toBe("検証内容");
    expect(labelsFor(undefined).itemCol).toBe("項目");
  });

  test("renderSpecMarkdown emits English labels when given the English set", () => {
    const spec: PerspectiveSpec = {
      specName: "access-admin-page",
      title: "管理者ページにアクセスできる",
      summary: "Verifies the page renders for an admin user.",
      preconditions: ["Logged in as an admin"],
      startScreen: "Admin page (/admin)",
      relatedPaths: ["src/features/admin/**"],
      status: { mode: "deterministic", traced: true, generated: true },
    };
    const md = renderSpecMarkdown(spec, labelsFor("en")).join("\n");
    expect(md).toContain("| Item | Value |");
    expect(md).toContain("| Verifies | Verifies the page renders for an admin user. |");
    expect(md).toContain("| Preconditions | Logged in as an admin |");
    expect(md).toContain("| Start screen | Admin page (/admin) |");
    expect(md).toContain("| Related code | `src/features/admin/**` |");
    // The case title stays verbatim from spec.yaml even under English labels.
    expect(md).toContain("## 管理者ページにアクセスできる");
    // Japanese labels must not leak in.
    expect(md).not.toContain("検証内容");
    expect(md).not.toContain("前提条件");
  });

  test("renderIndexMarkdown uses the English index title and case column", () => {
    const md = renderIndexMarkdown(
      {
        features: [
          {
            featureName: "admin",
            specs: [
              { specName: "s", title: "t", summary: "x", status: { mode: "deterministic", traced: true, generated: true } },
            ],
          },
        ],
      },
      labelsFor("en"),
    );
    expect(md).toContain("# Test Perspectives (perspectives)");
    expect(md).toContain("| Case | Mode | Status | spec |");
    expect(md).not.toContain("テスト観点");
    expect(md).not.toContain("ケース");
  });
});

describe("statusLabel", () => {
  const ja = labelsFor("ja");
  const en = labelsFor("en");

  test("live specs are always shown as runnable — codegen does not apply", () => {
    expect(statusLabel({ mode: "live", traced: false, generated: false }, ja)).toBe("✅ 実行可能");
    expect(statusLabel({ mode: "live", traced: true, generated: true }, ja)).toBe("✅ 実行可能");
    expect(statusLabel({ mode: "live", traced: false, generated: false }, en)).toBe("✅ runnable");
  });

  test("deterministic + generated is runnable", () => {
    expect(statusLabel({ mode: "deterministic", traced: true, generated: true }, ja)).toBe(
      "✅ 実行可能",
    );
    expect(statusLabel({ mode: "deterministic", traced: true, generated: true }, en)).toBe(
      "✅ runnable",
    );
  });

  test("deterministic without test.spec.ts is not runnable — both partial states collapse to the same warning", () => {
    expect(statusLabel({ mode: "deterministic", traced: true, generated: false }, ja)).toBe(
      "⚠️ 未record",
    );
    expect(statusLabel({ mode: "deterministic", traced: false, generated: false }, ja)).toBe(
      "⚠️ 未record",
    );
    expect(statusLabel({ mode: "deterministic", traced: false, generated: false }, en)).toBe(
      "⚠️ not recorded",
    );
  });
});
