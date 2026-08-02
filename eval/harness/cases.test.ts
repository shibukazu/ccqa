import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFixtureSpecKeys, loadCases } from "./cases.ts";
import { DEFAULT_APP_DIR, DEFAULT_CASES_DIR } from "./results.ts";
import { buildCaseRepo } from "./fixture-repo.ts";

describe("the committed cases against the committed baseline", () => {
  // The standing guard: every case file parses, names only real specs, and
  // every mutation still applies to today's baseline. A case that rotted
  // fails here, in CI, instead of quietly scoring as "clean and correct".
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
