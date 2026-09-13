import { describe, expect, it } from "vitest";
import { IntentSourceSchema } from "../config/project-config.ts";
import { caseFromMarkdown, caseFromSpec, type TestCase } from "../intent/case.ts";
import { liveCaseFrom, runsLive } from "./live-case.ts";

const INTENT = IntentSourceSchema.parse({ kind: "markdown", root: "docs/testcase" });
/** The same project, having said which heading declares a case's mode. */
const INTENT_WITH_MODE = IntentSourceSchema.parse({
  kind: "markdown",
  root: "docs/testcase",
  fields: { mode: "Mode" },
});

const CASE = `## Title

Adding an item puts it on the list

## Steps

1. Open the todo list
2. Add "Buy milk"

## Expected

- The item appears on the list
- The count reads 1

## Cleanup

1. Delete the item
`;

function markdownCase(source: string, intent = INTENT): TestCase {
  return caseFromMarkdown({
    id: "todo/add_item",
    path: "/repo/docs/testcase/todo/add_item.md",
    source,
    intent,
    cwd: "/repo",
  });
}

describe("liveCaseFrom", () => {
  it("attaches the case's expectations to the last step that is not cleanup", () => {
    const steps = liveCaseFrom(markdownCase(CASE)).steps;
    expect(steps.map((s) => s.expected)).toEqual([
      "",
      "The item appears on the list\nThe count reads 1",
      "",
    ]);
  });

  it("leaves a step that states its own expectation alone", () => {
    const parsed = markdownCase(CASE);
    const stated = {
      ...parsed,
      steps: parsed.steps.map((s, i) => (i === 1 ? { ...s, expected: "the list shows it" } : s)),
    };
    expect(liveCaseFrom(stated).steps[1]!.expected).toBe("the list shows it");
  });

  it("runs cleanup after the case's steps, as steps of its own", () => {
    const c = liveCaseFrom(markdownCase(CASE));
    expect(c.steps.map((s) => [s.id, s.source])).toEqual([
      ["step-01", "case"],
      ["step-02", "case"],
      ["cleanup-01", "cleanup"],
    ]);
    // The boundary the runner needs: from here on, a step runs even after a failure.
    expect(c.cleanupFrom).toBe(2);
  });

  it("restores both what the case names and what the project saved", () => {
    const spec = caseFromSpec(
      "todo",
      "add_item",
      "title: t\nmode: live\nsession: admin\nsteps:\n  - instruction: open it\n    expected: it opens\n",
      new Map(),
      "/repo",
    );
    expect(liveCaseFrom(spec, { cwd: "/repo", sessionState: ".ccqa/state.json" }).session).toEqual({
      names: ["admin"],
      savedStatePath: "/repo/.ccqa/state.json",
    });
  });

  it("refuses a claim the browser agent cannot judge", () => {
    const spec = caseFromSpec(
      "todo",
      "add_item",
      "title: t\nmode: live\nsteps:\n  - judgeByLlm: the list reads sensibly\n",
      new Map(),
      "/repo",
    );
    expect(() => liveCaseFrom(spec)).toThrow(/judgeByLlm/);
  });
});

describe("runsLive", () => {
  it("is false for a case with no mode section, whatever the project mapped", () => {
    expect(runsLive(markdownCase(CASE))).toBe(false);
    expect(runsLive(markdownCase(CASE, INTENT_WITH_MODE))).toBe(false);
  });

  it("is true only where the project named the heading and the case said live", () => {
    const declared = `${CASE}\n## Mode\n\nlive\n`;
    expect(runsLive(markdownCase(declared, INTENT_WITH_MODE))).toBe(true);
    // The same document in a project that never mapped a mode heading: the
    // section is prose for the recorder, not an instruction to drive live.
    expect(runsLive(markdownCase(declared))).toBe(false);
  });
});
