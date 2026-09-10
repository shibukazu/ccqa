import { describe, expect, it } from "vitest";
import { renderEvidence } from "./table.ts";
import type { TestCase } from "../intent/case.ts";

const TEST_CASE: TestCase = {
  ref: { id: "todo/add_item", dir: "/repo/.ccqa/cases/todo/add_item" },
  title: "Adding an item puts it on the list",
  steps: [
    { id: "step-01", source: "case", instruction: "Open the todo list", expected: "" },
    { id: "step-02", source: "case", instruction: 'Add "Buy milk"', expected: "" },
  ],
  cleanup: [],
  expectations: ["The item appears on the list"],
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
    unchecked: [],
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
    expect(markdown).toContain("Every step's outcome is decided by the generated test.");
  });
});
