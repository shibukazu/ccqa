import { describe, expect, it } from "vitest";
import { IntentFieldsSchema } from "../config/project-config.ts";
import { parseMarkdownCase, replaceSectionBody } from "./markdown.ts";

/** A project whose cases are written in its own language, as they usually are. */
const FIELDS = IntentFieldsSchema.parse({
  title: "観点",
  precondition: "条件",
  steps: "手順",
  expected: "期待結果",
  cleanup: "後処理",
  priority: "優先度",
  link: "テスト表",
  outputPath: "自動テストのパス",
});

const CASE = `# Add a todo item

## 観点

Adding an item puts it on the list

## 条件

Signed in as todo:user001

## テスト表

- URL：https://example.test/sheet
- No：1030

## 手順

1. Open the todo list
2. Type "Buy milk" into the new-item box
   and press Enter
3. Reload the page

## 期待結果

・The item appears at the top of the list
・It survives a reload

## 後処理

1. Delete the item

## 優先度

高

## 自動テストのパス

（未生成）
`;

describe("parseMarkdownCase", () => {
  const parsed = parseMarkdownCase({ id: "todo/add_item", source: CASE, fields: FIELDS });

  it("keeps the author's step numbers and folds continuation lines in", () => {
    expect(parsed.steps).toEqual([
      { number: 1, text: "Open the todo list" },
      { number: 2, text: 'Type "Buy milk" into the new-item box and press Enter' },
      { number: 3, text: "Reload the page" },
    ]);
  });

  it("reads expectations as a list, unattached to any step", () => {
    expect(parsed.expected).toEqual([
      "The item appears at the top of the list",
      "It survives a reload",
    ]);
  });

  it("reads title, priority, cleanup and the link's labelled parts", () => {
    expect(parsed.title).toBe("Adding an item puts it on the list");
    expect(parsed.priority).toBe("高");
    expect(parsed.cleanup).toEqual([{ number: 1, text: "Delete the item" }]);
    expect(parsed.link).toEqual({ url: "https://example.test/sheet", ref: "1030" });
  });

  it("carries the precondition and every unnamed section through as context", () => {
    // ccqa does nothing with a precondition, so it is not consumed here —
    // whoever runs the case has to read it, and the recorder is that reader.
    expect(parsed.other).toEqual([{ heading: "条件", body: "Signed in as todo:user001" }]);
    const extra = parseMarkdownCase({
      id: "todo/add_item",
      source: `${CASE}\n## Notes\n\nThe list is empty at start.\n`,
      fields: FIELDS,
    });
    expect(extra.other.map((s) => s.heading)).toEqual(["条件", "Notes"]);
  });

  it("keeps an expectation written as a sentence rather than a list", () => {
    const prose = parseMarkdownCase({
      id: "todo/x",
      source: "## 手順\n\n1. Open it\n\n## 期待結果\n\nThe item appears on the list.\n",
      fields: FIELDS,
    });
    expect(prose.expected).toEqual(["The item appears on the list."]);
  });

  it("refuses a case with no numbered steps", () => {
    expect(() =>
      parseMarkdownCase({ id: "todo/x", source: "## 手順\n\nclick around\n", fields: FIELDS }),
    ).toThrow(/no steps/);
  });
});

describe("cleanupExpected", () => {
  it("splits a numbered cleanup section's top-level bullets into cleanupExpected", () => {
    const source = [
      "## 手順",
      "",
      "1. Open the todo list",
      "",
      "## 後処理",
      "",
      "1. Delete the item",
      "2. Refresh the page",
      "",
      "- The item no longer appears in the list",
      "- The item count returns to zero",
    ].join("\n");
    const parsed = parseMarkdownCase({ id: "todo/x", source, fields: FIELDS });
    expect(parsed.cleanup).toEqual([
      { number: 1, text: "Delete the item" },
      { number: 2, text: "Refresh the page" },
    ]);
    expect(parsed.cleanupExpected).toEqual([
      "The item no longer appears in the list",
      "The item count returns to zero",
    ]);
  });

  it("treats a prose-only cleanup section as one step, with no separate expectation", () => {
    const source = [
      "## 手順",
      "",
      "1. Open the todo list",
      "",
      "## 後処理",
      "",
      "Nothing needs to be undone.",
    ].join("\n");
    const parsed = parseMarkdownCase({ id: "todo/x", source, fields: FIELDS });
    expect(parsed.cleanup).toEqual([{ number: 1, text: "Nothing needs to be undone." }]);
    expect(parsed.cleanupExpected).toEqual([]);
  });

  it("folds a bullet indented under a numbered step into that step's text, not an expectation", () => {
    const source = [
      "## 手順",
      "",
      "1. Open the todo list",
      "",
      "## 後処理",
      "",
      "1. Delete the item",
      "    - confirm the delete dialog",
    ].join("\n");
    const parsed = parseMarkdownCase({ id: "todo/x", source, fields: FIELDS });
    expect(parsed.cleanup).toEqual([{ number: 1, text: "Delete the item - confirm the delete dialog" }]);
    expect(parsed.cleanupExpected).toEqual([]);
  });
});

describe("replaceSectionBody — the last section", () => {
  // The write-back runs on every successful generate, so a doubled trailing
  // newline grows the project's own case file one blank line at a time.
  it("rewrites in place without growing the file", () => {
    const source = "# T\n\n## Out\n\n(none)\n";
    const once = replaceSectionBody(source, "Out", "specs/a.spec.ts")!;
    const twice = replaceSectionBody(once, "Out", "specs/a.spec.ts")!;
    expect(twice).toBe(once);
    expect(once.endsWith("specs/a.spec.ts\n")).toBe(true);
  });
});

describe("replaceSectionBody", () => {
  it("rewrites one section and leaves every other byte alone", () => {
    const out = replaceSectionBody(CASE, "自動テストのパス", "specs/todo/add_item.spec.ts");
    expect(out).toContain("## 自動テストのパス\n\nspecs/todo/add_item.spec.ts");
    expect(out).not.toContain("（未生成）");
    expect(out!.replace(/## 自動テストのパス[\s\S]*$/, "")).toBe(
      CASE.replace(/## 自動テストのパス[\s\S]*$/, ""),
    );
  });

  it("answers null when the section is not there to rewrite", () => {
    expect(replaceSectionBody(CASE, "Nope", "x")).toBeNull();
  });
});
