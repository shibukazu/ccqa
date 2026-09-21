import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RecordedAction } from "../ir/types.ts";
import type { DriftDiagnosis } from "../report/schema.ts";
import { saveRecording, specCase, stampGeneratedTest } from "../store/index.ts";
import { writeAuditBriefs, type AuditBrief } from "./brief.ts";
import type { AuditedRename } from "./renames.ts";
import type { SpecResult, SpecTarget } from "./types.ts";

const SPEC = "title: Sample\nsteps:\n  - instruction: Open the app\n    expected: The home screen is visible\n";
const NAVIGATE: RecordedAction = { action: "navigate", value: "https://example.test" };
/** A recording that addresses the element the audit says was renamed. */
const NAMES_IT: RecordedAction = { action: "click", locator: { by: "text", value: "Submit" } };

const held: AuditedRename = { from: "Submit", to: "Send", inDocument: true };
const unheld: AuditedRename = { from: "Submit", to: "Send", inDocument: false };

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-brief-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function drift(overrides: Partial<DriftDiagnosis> = {}): DriftDiagnosis {
  return {
    label: "TEST_DRIFT",
    confidence: 0.8,
    surface: "generated",
    subDiagnosis: "SELECTOR_DRIFT",
    headline: "aria-label renamed",
    recommendation: "Update the selector",
    evidence: [],
    reasoning: "the source now renders a different label",
    ...overrides,
  };
}

/**
 * One audited case. `renames` arrives already sanitized and checked against
 * the document (`auditedRenames`, covered in renames.test.ts), so these are
 * routing inputs.
 */
function result(
  target: SpecTarget,
  overrides: Partial<DriftDiagnosis> = {},
  renames: AuditedRename[] = [],
): SpecResult {
  const { featureName, specName } = target;
  return {
    target,
    ok: false,
    drift: drift(overrides),
    documentPath: `.ccqa/features/${featureName}/test-cases/${specName}/spec.yaml`,
    renames,
  };
}

/** Writes a case's spec.yaml and its generated test.spec.ts, at the path its target resolves to. */
async function makeCase(feature: string, spec: string): Promise<string> {
  const dir = join(cwd, ".ccqa/features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec.yaml"), SPEC, "utf8");
  const testAbs = join(dir, "test.spec.ts");
  await writeFile(testAbs, "test('flow', () => {});\n", "utf8");
  return testAbs;
}

/** A case with a recording ccqa generated its current test from. */
async function makeStampedCase(
  feature: string,
  spec: string,
  actions: RecordedAction[] = [NAVIGATE],
): Promise<string> {
  const testAbs = await makeCase(feature, spec);
  const ref = specCase(feature, spec, cwd);
  await saveRecording(ref, actions);
  await stampGeneratedTest(ref, testAbs);
  return testAbs;
}

/** The one brief a single-finding sweep writes. */
async function briefFor(results: SpecResult[]): Promise<AuditBrief> {
  const [path] = await writeAuditBriefs({ results, cwd, dir: join(cwd, "briefs") });
  return JSON.parse(await readFile(path!, "utf8")) as AuditBrief;
}

describe("writeAuditBriefs", () => {
  test("a label naming no mechanical repair is external, live case or not", async () => {
    await makeCase("demo", "spec-change");

    const brief = await briefFor([
      {
        ...result({ featureName: "demo", specName: "spec-change" }, { label: "SPEC_CHANGE" }, [held]),
        live: true,
      },
    ]);
    expect(brief.repair.route).toBe("external");
    expect(brief.repair.reason).toContain("SPEC_CHANGE names no repair a machine can make");
    expect(brief.repair.rewrite).toEqual([]);
  });

  test("a live case whose document holds the renamed string is repaired by rewriting it", async () => {
    await makeCase("demo", "livecase");

    const brief = await briefFor([
      { ...result({ featureName: "demo", specName: "livecase" }, { surface: "spec" }, [held]), live: true },
    ]);
    expect(brief.repair.route).toBe("rewrite");
    expect(brief.repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
    expect(brief.repair.reason).toContain("then run the case to verify");
    // No compiled code to regenerate, so no stamp was ever required.
    expect(brief.test).toBeNull();
  });

  test("a live case naming nothing its document holds is external", async () => {
    await makeCase("demo", "liveunheld");

    const brief = await briefFor([
      { ...result({ featureName: "demo", specName: "liveunheld" }, { surface: "spec" }, [unheld]), live: true },
    ]);
    expect(brief.repair.route).toBe("external");
    expect(brief.repair.rewrite).toEqual([]);
  });

  test("a case that resolves to no generated test is external", async () => {
    const brief = await briefFor([result({ featureName: "demo", specName: "missing" })]);
    expect(brief.repair.route).toBe("external");
    expect(brief.test).toBeNull();
  });

  test("a case with no recording routes to external", async () => {
    await makeCase("demo", "norecording");

    const brief = await briefFor([result({ featureName: "demo", specName: "norecording" })]);
    expect(brief.repair.route).toBe("external");
    expect(brief.repair.reason).toContain("no generation stamp");
  });

  test("a stamped test edited afterwards is external, still carrying the pairs", async () => {
    const testAbs = await makeStampedCase("demo", "edited", [NAMES_IT]);
    await writeFile(testAbs, "test('flow', () => { /* edited by hand */ });\n", "utf8");

    const brief = await briefFor([
      result({ featureName: "demo", specName: "edited" }, { surface: "spec" }, [held]),
    ]);
    expect(brief.repair.route).toBe("external");
    expect(brief.repair.reason).toContain("edited since it was generated");
    // Rewriting the document rebuilds nothing, so the person taking this over
    // can still use them.
    expect(brief.repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
  });

  test("a recording that names the renamed string has to be recorded again", async () => {
    await makeStampedCase("demo", "recorded", [NAMES_IT]);

    const brief = await briefFor([
      result({ featureName: "demo", specName: "recorded" }, {}, [unheld]),
    ]);
    expect(brief.repair.route).toBe("rerecord");
    // Nothing to edit first: the document never quoted it.
    expect(brief.repair.rewrite).toEqual([]);
    expect(brief.repair.reason).not.toContain("Apply 'rewrite'");
  });

  test("a string in both the recording and the document is rewritten, then recorded again", async () => {
    await makeStampedCase("demo", "both", [NAMES_IT]);

    const brief = await briefFor([
      result({ featureName: "demo", specName: "both" }, { surface: "spec" }, [held]),
    ]);
    expect(brief.repair.route).toBe("rerecord");
    expect(brief.repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
    expect(brief.repair.reason).toContain("Apply 'rewrite' to 'document' first");
  });

  test("a generated-surface finding the recording does not name is regenerated", async () => {
    await makeStampedCase("demo", "regen");

    const brief = await briefFor([result({ featureName: "demo", specName: "regen" })]);
    expect(brief.repair.route).toBe("regenerate");
    expect(brief.repair.rewrite).toEqual([]);
    expect(brief.repair.reason).not.toContain("Apply 'rewrite'");
    expect(brief.document).toBe(".ccqa/features/demo/test-cases/regen/spec.yaml");
  });

  test("a document-only rename is regenerated after the rewrite", async () => {
    await makeStampedCase("demo", "on-the-document");

    const brief = await briefFor([
      result({ featureName: "demo", specName: "on-the-document" }, { surface: "spec" }, [held]),
    ]);
    expect(brief.repair.route).toBe("regenerate");
    expect(brief.repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
    expect(brief.repair.reason).toContain("Apply 'rewrite' to 'document' first");
  });

  test("a spec-surface finding with nothing to rewrite is external", async () => {
    await makeStampedCase("demo", "imported");

    const brief = await briefFor([
      result({ featureName: "demo", specName: "imported" }, { surface: "spec" }),
    ]);
    expect(brief.repair.route).toBe("external");
  });

  test("writes to <dir>/<caseId>.json, creating nested directories", async () => {
    await makeStampedCase("demo", "regen");

    const [path] = await writeAuditBriefs({
      results: [result({ featureName: "demo", specName: "regen" })],
      cwd,
      dir: join(cwd, "briefs"),
    });
    expect(path).toBe(join(cwd, "briefs", "demo", "regen.json"));
  });
});
