import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentSourceSchema } from "../config/project-config.ts";
import * as log from "../cli/logger.ts";
import { caseIdFor, listMarkdownCases, loadMarkdownCase } from "./case.ts";

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

describe("listMarkdownCases", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ccqa-case-"));
    await mkdir(join(cwd, "docs/testcase/todo/nested"), { recursive: true });
    await mkdir(join(cwd, "docs/testcase/.archive"), { recursive: true });
    await writeFile(join(cwd, "docs/testcase/todo/add_item.md"), CASE, "utf8");
    await writeFile(join(cwd, "docs/testcase/todo/nested/remove_item.md"), CASE, "utf8");
    await writeFile(join(cwd, "docs/testcase/todo/readme.txt"), "not a case", "utf8");
    await writeFile(join(cwd, "docs/testcase/.archive/old.md"), CASE, "utf8");
  });

  it("returns sorted ids for nested directories, skipping non-.md files and dot-directories", async () => {
    expect(await listMarkdownCases(INTENT, cwd)).toEqual(["todo/add_item", "todo/nested/remove_item"]);
  });

  it("skips a .md that is not a case, so a README beside the cases is not audited", async () => {
    await writeFile(join(cwd, "docs/testcase/README.md"), "# How we write test cases\n", "utf8");
    expect(await listMarkdownCases(INTENT, cwd)).toEqual(["todo/add_item", "todo/nested/remove_item"]);
  });
});

describe("caseIdFor", () => {
  // Pure path arithmetic — no file needs to exist for either form to resolve.
  const cwd = "/project";

  it("accepts a path below the root and a bare id as the same case", () => {
    expect(caseIdFor("docs/testcase/todo/add_item.md", INTENT, cwd)).toBe("todo/add_item");
    expect(caseIdFor("todo/add_item", INTENT, cwd)).toBe("todo/add_item");
  });
});

describe("a markdown case's mode", () => {
  const STEPS_ONLY = "## Steps\n\n1. Open the app\n";
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ccqa-case-"));
    await mkdir(join(cwd, "docs/testcase"), { recursive: true });
  });

  async function writeCase(body: string): Promise<void> {
    await writeFile(join(cwd, "docs/testcase/case.md"), body, "utf8");
  }

  it("is deterministic when the field map does not name a mode heading", async () => {
    await writeCase(`${STEPS_ONLY}\n## Mode\n\nlive\n`);
    expect((await loadMarkdownCase("case", INTENT, cwd)).mode).toBe("deterministic");
  });

  it("is live when the mapped heading's body says live, case-insensitively", async () => {
    const withMode = IntentSourceSchema.parse({
      kind: "markdown",
      root: "docs/testcase",
      fields: { mode: "Mode" },
    });
    await writeCase(`${STEPS_ONLY}\n## Mode\n\nLIVE\n`);
    expect((await loadMarkdownCase("case", withMode, cwd)).mode).toBe("live");
  });

  it("is deterministic when the mapped heading says anything else, or is absent", async () => {
    const withMode = IntentSourceSchema.parse({
      kind: "markdown",
      root: "docs/testcase",
      fields: { mode: "Mode" },
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await writeCase(`${STEPS_ONLY}\n## Mode\n\nmanual\n`);
    expect((await loadMarkdownCase("case", withMode, cwd)).mode).toBe("deterministic");
    // A project that wrote something there meant it; reading it as "record and
    // generate" without a word is how a case gets automated nobody meant to.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mode "manual"'));

    warn.mockClear();
    await writeCase(STEPS_ONLY);
    expect((await loadMarkdownCase("case", withMode, cwd)).mode).toBe("deterministic");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
