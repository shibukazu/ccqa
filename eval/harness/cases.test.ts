import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { listFixtureSpecKeys, loadCases } from "./cases.ts";
import { DEFAULT_APP_DIR, DEFAULT_CASES_DIR } from "./results.ts";
import { buildCaseRepo } from "./fixture-repo.ts";

const execFileP = promisify(execFile);

describe("the committed cases against the committed baseline", () => {
  // The standing guard: every case file parses, names only real specs, and
  // every mutation still applies to today's baseline (rationale on
  // `applyMutations`). A rotted case fails here, in CI.
  it("every case loads and every mutation still applies", async () => {
    const specKeys = await listFixtureSpecKeys(DEFAULT_APP_DIR);
    expect(specKeys.length).toBeGreaterThan(0);
    const cases = await loadCases(DEFAULT_CASES_DIR, specKeys);
    expect(cases.length).toBeGreaterThan(0);
    for (const evalCase of cases) {
      const repo = await buildCaseRepo(DEFAULT_APP_DIR, evalCase.mutations);
      await repo.cleanup();
    }
  }, 120_000);

  // Closes the loop the mutation guards only start: the declared change is
  // not just written to disk but present in the commit the eval measures.
  it("a mutation reaches the head commit", async () => {
    const specKeys = await listFixtureSpecKeys(DEFAULT_APP_DIR);
    const cases = await loadCases(DEFAULT_CASES_DIR, specKeys);
    const evalCase = cases.find((c) => c.mutations.length === 1 && "search" in c.mutations[0]!);
    if (!evalCase) throw new Error("no single-search-mutation case committed");
    const mutation = evalCase.mutations[0]! as { file: string; search: string };

    const repo = await buildCaseRepo(DEFAULT_APP_DIR, evalCase.mutations);
    try {
      const { stdout: diff } = await execFileP(
        "git",
        ["diff", "--name-only", repo.baseSha, repo.headSha],
        { cwd: repo.dir },
      );
      expect(diff.trim().split("\n")).toEqual([mutation.file]);
      const { stdout: atHead } = await execFileP(
        "git",
        ["show", `${repo.headSha}:${mutation.file}`],
        { cwd: repo.dir },
      );
      expect(atHead).not.toContain(mutation.search);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it("rejects an expectation for a spec the fixture does not have", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-eval-cases-"));
    try {
      await writeFile(
        join(dir, "typo.yaml"),
        'title: typo\nmutations: []\nexpect:\n  audit:\n    tasks/does-not-exist: { label: TEST_DRIFT }\n',
        "utf8",
      );
      await expect(loadCases(dir, ["tasks/add-task"])).rejects.toThrow(/unknown spec/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
