import { describe, expect, it } from "vitest";
import { buildEvidenceSteps, renderEvidence, sourceNeedles } from "./table.ts";
import type { EvidenceInput } from "./table.ts";
import type { SourceAnchors } from "./source-anchors.ts";
import type { TestCase } from "../intent/case.ts";

const TEST_CASE: TestCase = {
  ref: { id: "todo/add_item", dir: "/repo/.ccqa/cases/todo/add_item" },
  title: "Adding an item puts it on the list",
  mode: "deterministic",
  steps: [
    { id: "step-01", source: "case", instruction: "Open the todo list", expected: "" },
    { id: "step-02", source: "case", instruction: 'Add "Buy milk"', expected: "" },
  ],
  cleanup: [],
  expectations: ["The item appears on the list"],
  cleanupExpectations: [],
  context: [],
  fields: {},
  source: {
    kind: "markdown",
    path: "/repo/docs/testcase/todo/add_item.md",
    text: "",
    parsed: {} as never,
  },
};

const GENERATED = `import { test, expect } from "@playwright/test";

test("Adding an item puts it on the list @high", async ({ page }) => {
  // step: step-01 [case]
  await page.goto("https://example.test/todos");

  // step: step-02 [case]
  await page.getByLabel("Title").fill("Buy milk");
  await expect(page.getByText("Buy milk")).toBeVisible();
});
`;

describe("renderEvidence", () => {
  const markdown = renderEvidence({
    testCase: TEST_CASE,
    recording: {
      recordedAt: "2026-02-01T00:00:00.000Z",
      origin: "${BASE_URL}/todos",
      actions: [
        { action: "navigate", value: "https://example.test/todos", stepId: "step-01" },
        { action: "fill", locator: { by: "label", value: "Title" }, value: "Buy milk", stepId: "step-02" },
      ],
    },
    test: { path: "specs/todo/add_item.spec.ts", source: GENERATED },
    screenshots: new Map([["step-02", ["runs/1/step-02.png"]]]),
    review: [],
  });

  it("puts one row per step of the case, in the case's own words", () => {
    expect(markdown).toContain("| step-01 | Open the todo list |");
    expect(markdown).toContain('Add "Buy milk"');
  });

  it("shows what the generated test decides for each step", () => {
    expect(markdown).toContain('await expect(page.getByText("Buy milk")).toBeVisible();');
  });

  it("says plainly when a step decides nothing, rather than leaving a blank", () => {
    // step-01 navigates and asserts nothing: the hole a reviewer must see.
    const row = markdown.split("\n").find((l) => l.startsWith("| step-01 |"))!;
    expect(row).toContain("**nothing**");
  });

  it("links the step's screenshot and dates the route it came from", () => {
    expect(markdown).toContain("![step-02](runs/1/step-02.png)");
    expect(markdown).toContain("Recorded: 2026-02-01T00:00:00.000Z");
    expect(markdown).toContain("`${BASE_URL}/todos`");
  });

  it("lists what the case expects, so a missing check is visible against it", () => {
    expect(markdown).toContain("The item appears on the list");
  });

  // The summary read "every step is decided" while the table above it showed
  // **nothing** for step-01. It is derived from the same rows now, so the two
  // cannot disagree.
  it("summarises the table it just wrote, not a review that saw another file", () => {
    expect(markdown).toContain("step step-01: nothing in the generated test is visibly deciding");
    expect(markdown).not.toContain("Every step's outcome is decided");
  });

  it("says every step is decided only when the table shows one for each", () => {
    const decided = renderEvidence({
      testCase: { ...TEST_CASE, steps: [TEST_CASE.steps[1]!] },
      recording: { actions: [] },
      test: { path: "specs/todo/add_item.spec.ts", source: GENERATED },
      screenshots: new Map(),
      review: [],
    });
    expect(decided).toContain("Every step's outcome is decided by the generated test.");
  });
});

describe("sourceNeedles", () => {
  it("pulls testid, accessible name, placeholder and label values, and an asserted text literal", () => {
    expect(
      sourceNeedles([
        { action: "click", locator: { by: "testid", value: "submit-button" } },
        { action: "click", locator: { by: "role", value: "button", name: "Save" } },
        { action: "fill", locator: { by: "placeholder", value: "Search…" }, value: "milk" },
        { action: "fill", locator: { by: "label", value: "Title" }, value: "Buy milk" },
        { action: "assert", assert: "text_visible", value: "Buy milk" },
      ]),
    ).toEqual([
      { value: "submit-button", kind: "testid" },
      { value: "Save", kind: "text" },
      { value: "Search…", kind: "text" },
      { value: "Title", kind: "text" },
      { value: "Buy milk", kind: "text" },
    ]);
  });

  it("skips a value with a ${...} interpolation — it has no literal counterpart in the source", () => {
    expect(
      sourceNeedles([{ action: "fill", locator: { by: "testid", value: "${RUN_ID}-field" } }]),
    ).toEqual([]);
  });

  it("ignores locator strategies not worth anchoring, and dedupes repeats", () => {
    expect(
      sourceNeedles([
        { action: "click", locator: { by: "css", value: "[data-x]" } },
        { action: "click", locator: { by: "text", value: "Go" } },
        { action: "click", locator: { by: "testid", value: "submit-button" } },
        { action: "click", locator: { by: "testid", value: "submit-button" } },
      ]),
    ).toEqual([{ value: "submit-button", kind: "testid" }]);
  });
});

describe("renderEvidence's source-anchor column", () => {
  const anchors: SourceAnchors = {
    found: new Map([["Title", { needle: "Title", places: ["src/components/Form.tsx:12"] }]]),
    unsearched: new Set<string>(),
  };
  const base: EvidenceInput = {
    testCase: TEST_CASE,
    recording: {
      recordedAt: "2026-02-01T00:00:00.000Z",
      actions: [
        { action: "navigate", value: "https://example.test/todos", stepId: "step-01" },
        {
          action: "fill",
          locator: { by: "label", value: "Title" },
          value: "Buy milk",
          stepId: "step-02",
        },
      ],
    },
    test: { path: "specs/todo/add_item.spec.ts", source: GENERATED },
    screenshots: new Map<string, string[]>(),
  };

  it("omits the column entirely when anchors is undefined", () => {
    const markdown = renderEvidence(base);
    const header = markdown.split("\n").find((l) => l.startsWith("| Step |"))!;
    const separator = markdown.split("\n")[markdown.split("\n").indexOf(header) + 1]!;
    expect(header).not.toContain("Where the source says so");
    expect(header.split("|").length).toBe(separator.split("|").length);
    for (const row of markdown.split("\n").filter((l) => l.startsWith("| step-"))) {
      expect(row.split("|").length).toBe(header.split("|").length);
    }
  });

  it("adds the column between what the test decides and the screenshots, resolving and reporting each needle", () => {
    const markdown = renderEvidence({ ...base, anchors });
    const lines = markdown.split("\n");
    const header = lines.find((l) => l.startsWith("| Step |"))!;
    const separator = lines[lines.indexOf(header) + 1]!;
    expect(header).toBe(
      "| Step | What the case says | What was recorded | What the test decides | Where the source says so | Screens |",
    );
    expect(header.split("|").length).toBe(separator.split("|").length);
    for (const row of lines.filter((l) => l.startsWith("| step-"))) {
      expect(row.split("|").length).toBe(header.split("|").length);
    }

    const row2 = lines.find((l) => l.startsWith("| step-02 |"))!;
    expect(row2).toContain("`Title` — src/components/Form.tsx:12");
    const row1 = lines.find((l) => l.startsWith("| step-01 |"))!;
    // step-01 only navigates: no needles, so the cell is the same em dash as an empty column.
    expect(buildEvidenceSteps(base)[0]!.needles).toEqual([]);
    expect(row1.split("|")[5]!.trim()).toBe("—");
  });

  it("says a needle was not searched rather than not found when the scan skipped it", () => {
    const markdown = renderEvidence({
      ...base,
      anchors: { found: new Map(), unsearched: new Set(["Title"]) },
    });
    const row2 = markdown.split("\n").find((l) => l.startsWith("| step-02 |"))!;
    expect(row2).toContain("`Title` — not searched");
    expect(row2).not.toContain("not found");
  });
});

describe("renderEvidence's source-anchor column, when a needle has more than one home", () => {
  // Naming one of several equal candidates reads as "this is where it comes
  // from" — a claim the scan cannot make, and the reason the column exists.
  it("says the answer is ambiguous and shows two of them", () => {
    const markdown = renderEvidence({
      testCase: TEST_CASE,
      recording: {
        actions: [
          { action: "fill", locator: { by: "label", value: "Title" }, value: "x", stepId: "step-02" },
        ],
      },
      test: { path: "specs/todo/add_item.spec.ts", source: GENERATED },
      screenshots: new Map<string, string[]>(),
      anchors: {
        found: new Map([
          ["Title", { needle: "Title", places: ["src/A.tsx:1", "src/B.tsx:4"] }],
        ]),
        unsearched: new Set<string>(),
      },
    });
    const row = markdown.split("\n").find((l) => l.startsWith("| step-02 |"))!;
    expect(row).toContain("`Title` — ambiguous: src/A.tsx:1, src/B.tsx:4");
  });
});
