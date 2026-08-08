import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { listFixtureSpecKeys, loadCases, type EvalCase } from "./cases.ts";
import { DEFAULT_APP_DIR, DEFAULT_CASES_DIR } from "./results.ts";
import { buildCaseRepo } from "./fixture-repo.ts";
import { validateMutations } from "./mutate.ts";

const execFileP = promisify(execFile);

describe("the committed cases against the committed baseline", () => {
  let specKeys: string[];
  let cases: EvalCase[];

  beforeAll(async () => {
    specKeys = await listFixtureSpecKeys(DEFAULT_APP_DIR);
    cases = await loadCases(DEFAULT_CASES_DIR, specKeys);
  });

  function caseByName(name: string): EvalCase {
    const found = cases.find((c) => c.name === name);
    if (!found) throw new Error(`committed case ${name} not found`);
    return found;
  }

  // The standing guard: every case file parses, names only real specs, and
  // every mutation still applies to today's baseline (rationale on
  // `applyMutations`). A rotted case fails here, in CI. Validation runs
  // read-only against the app dir itself — no per-case checkout.
  it("every case loads and every mutation still applies", async () => {
    expect(specKeys.length).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThan(0);
    for (const evalCase of cases) {
      await validateMutations(DEFAULT_APP_DIR, evalCase.mutations);
    }
  });

  // Closes the loop the mutation guards only start: the declared change is
  // not just written to disk but present in the commit the eval measures.
  it("a mutation reaches the head commit", async () => {
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

  // Two cases enumerate "the specs that include the login block" by hand.
  // Derive the true membership from the spec tree (`include: login` steps)
  // and hold the declarations to it, so an eleventh spec cannot silently rot
  // the ground truth. (`api-shared-change` is deliberately not pinned here:
  // its ground truth is "specs that go through the shared fetch layer", which
  // only coincides with block membership in today's tree.)
  it("hand-declared login-block membership matches the spec tree", async () => {
    const includers = new Set<string>();
    for (const key of specKeys) {
      const [feature, spec] = key.split("/");
      const raw = await readFile(
        join(DEFAULT_APP_DIR, ".ccqa", "features", feature!, "test-cases", spec!, "spec.yaml"),
        "utf8",
      );
      const doc = parse(raw) as { steps?: Array<Record<string, unknown>> };
      if ((doc.steps ?? []).some((step) => step.include === "login")) includers.add(key);
    }
    expect(includers.size).toBeGreaterThan(0);
    expect(includers.size).toBeLessThan(specKeys.length);

    // Audit case: exactly the including specs drift; the rest stay clean by omission.
    const markup = caseByName("login-block-markup-drift");
    expect(new Set(Object.keys(markup.expect.audit ?? {}))).toEqual(includers);

    // Select case: every spec is declared, and `needed` is exactly the including set.
    const select = caseByName("block-spec-file-change").expect.select ?? {};
    expect(new Set(Object.keys(select))).toEqual(new Set(specKeys));
    const needed = Object.keys(select).filter((key) => select[key] === "needed");
    expect(new Set(needed)).toEqual(includers);
  });

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
