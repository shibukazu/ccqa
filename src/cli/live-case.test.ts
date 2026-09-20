import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseFromDocument, caseFromSpec, type TestCase } from "../cases/case.ts";
import { liveCaseFrom, runsLive } from "./live-case.ts";

const cwd = "/repo";

/** A case as a project's own reader answers for one. */
function ownCase(overrides: Partial<Parameters<typeof caseFromDocument>[0]> = {}): TestCase {
  return caseFromDocument(
    {
      id: "todo/add_item",
      path: join(cwd, "docs/testcase/todo/add_item.md"),
      text: "the document, verbatim",
      title: "Adding an item puts it on the list",
      mode: "deterministic",
      steps: [{ instruction: "Open the todo list" }, { instruction: 'Add "Buy milk"' }],
      cleanup: [{ instruction: "Delete the item" }],
      expectations: ["The item appears on the list", "The count reads 1"],
      ...overrides,
    },
    cwd,
  );
}

describe("liveCaseFrom", () => {
  it("attaches the case's expectations to the last step that is not cleanup", () => {
    expect(liveCaseFrom(ownCase()).steps.map((s) => s.expected)).toEqual([
      "",
      "The item appears on the list\nThe count reads 1",
      "",
    ]);
  });

  it("leaves a step that states its own expectation alone", () => {
    const stated = ownCase({
      steps: [{ instruction: "Open the todo list" }, { instruction: "Add it", expected: "the list shows it" }],
    });
    expect(liveCaseFrom(stated).steps[1]!.expected).toBe("the list shows it");
  });

  it("runs cleanup after the case's steps, as steps of its own", () => {
    const c = liveCaseFrom(ownCase());
    expect(c.steps.map((s) => [s.id, s.source])).toEqual([
      ["step-01", "case"],
      ["step-02", "case"],
      ["cleanup-01", "cleanup"],
    ]);
    // The boundary the runner needs: from here on, a step runs even after a failure.
    expect(c.cleanupFrom).toBe(2);
  });

  it("carries the document verbatim, whichever kind states the case", () => {
    expect(liveCaseFrom(ownCase()).document).toBe("the document, verbatim");
  });

  it("restores both what the case names and what the project saved", () => {
    const spec = caseFromSpec(
      "todo",
      "add_item",
      "title: t\nmode: live\nsession: admin\nsteps:\n  - instruction: open it\n    expected: it opens\n",
      new Map(),
      cwd,
    );
    expect(liveCaseFrom(spec, { cwd, sessionState: ".ccqa/state.json" }).session).toEqual({
      names: ["admin"],
      savedStatePath: join(cwd, ".ccqa/state.json"),
    });
  });

  it("refuses a claim the browser agent cannot judge", () => {
    const spec = caseFromSpec(
      "todo",
      "add_item",
      "title: t\nmode: live\nsteps:\n  - judgeByLlm: the list reads sensibly\n",
      new Map(),
      cwd,
    );
    expect(() => liveCaseFrom(spec)).toThrow(/judgeByLlm/);
  });
});

describe("runsLive", () => {
  // The default matters: a source that says nothing about how a case runs has
  // not asked for a model to drive the product.
  it("is false for a case that does not say live", () => {
    expect(runsLive(ownCase())).toBe(false);
    expect(runsLive(ownCase({ mode: "live" }))).toBe(true);
  });
});
