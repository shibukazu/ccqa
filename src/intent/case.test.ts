import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IntentSourceSchema } from "../config/project-config.ts";
import { loadMarkdownCase } from "./case.ts";

const INTENT = IntentSourceSchema.parse({ kind: "markdown", root: "docs/testcase" });

const CASE = `## Title

Adding an item puts it on the list

## Steps

1. Open the todo list
2. Add "Buy milk"

## Expected

- The item appears on the list

## Cleanup

1. Delete the item
`;

describe("loadMarkdownCase", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ccqa-case-"));
    await mkdir(join(cwd, "docs/testcase/todo"), { recursive: true });
    await writeFile(join(cwd, "docs/testcase/todo/add_item.md"), CASE, "utf8");
  });

  it("accepts the file path a person reads, and the id ccqa uses, as the same case", async () => {
    const byPath = await loadMarkdownCase("docs/testcase/todo/add_item.md", INTENT, cwd);
    const byId = await loadMarkdownCase("todo/add_item", INTENT, cwd);
    expect(byPath.ref).toEqual(byId.ref);
    expect(byId.ref.id).toBe("todo/add_item");
    // The case keeps its own files under `.ccqa/`, not beside the project's.
    expect(byId.ref.dir).toBe(join(cwd, ".ccqa/cases/todo/add_item"));
  });

  it("numbers steps as the case does, and leaves expectations unplaced", async () => {
    const testCase = await loadMarkdownCase("todo/add_item", INTENT, cwd);
    expect(testCase.steps.map((s) => s.id)).toEqual(["step-01", "step-02"]);
    expect(testCase.steps.every((s) => "expected" in s && s.expected === "")).toBe(true);
    expect(testCase.expectations).toEqual(["The item appears on the list"]);
    expect(testCase.cleanup.map((s) => s.id)).toEqual(["cleanup-01"]);
  });

  it("says where it looked when the case is not there", async () => {
    await expect(loadMarkdownCase("todo/nope", INTENT, cwd)).rejects.toThrow(
      /docs\/testcase\/todo\/nope\.md/,
    );
  });
});
