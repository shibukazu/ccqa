import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RecordedAction } from "../ir/types.ts";
import type { DriftDiagnosis } from "../report/schema.ts";
import { saveRecording, specCase, stampGeneratedTest } from "../store/index.ts";
import { loadSpecArtifactsContext } from "./artifacts.ts";
import {
  AUDIT_REPORT_FILE,
  buildAuditReport,
  writeAuditReport,
  type AuditReport,
  type AuditReportRow,
  type Repair,
} from "./audit-report.ts";
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
  cwd = await mkdtemp(join(tmpdir(), "ccqa-audit-report-"));
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

async function reportFor(results: SpecResult[]): Promise<AuditReport> {
  return buildAuditReport(results, cwd, await loadSpecArtifactsContext(cwd));
}

/** The single row a one-result sweep produced. */
async function rowFor(results: SpecResult[]): Promise<AuditReportRow> {
  const [row] = (await reportFor(results)).specs;
  return row!;
}

/** The same row's repair, which only a finding has. */
async function repairFor(results: SpecResult[]): Promise<Repair> {
  const { repair } = await rowFor(results);
  if (repair === undefined) throw new Error("expected a finding row to carry a repair");
  return repair;
}

describe("buildAuditReport — routing", () => {
  test("a label naming no mechanical repair is external, live case or not", async () => {
    await makeCase("demo", "spec-change");

    const repair = await repairFor([
      {
        ...result({ featureName: "demo", specName: "spec-change" }, { label: "SPEC_CHANGE" }, [held]),
        live: true,
      },
    ]);
    expect(repair.route).toBe("external");
    expect(repair.reason).toContain("SPEC_CHANGE names no repair a machine can make");
    expect(repair.rewrite).toEqual([]);
  });

  test("a live case whose document holds the renamed string is repaired by rewriting it", async () => {
    await makeCase("demo", "livecase");

    const row = await rowFor([
      { ...result({ featureName: "demo", specName: "livecase" }, { surface: "spec" }, [held]), live: true },
    ]);
    expect(row.repair!.route).toBe("rewrite");
    expect(row.repair!.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
    expect(row.repair!.reason).toContain("then run the case to verify");
    // No compiled code to regenerate, so no stamp was ever required.
    expect(row.test).toBeNull();
  });

  test("a live case naming nothing its document holds is external", async () => {
    await makeCase("demo", "liveunheld");

    const repair = await repairFor([
      { ...result({ featureName: "demo", specName: "liveunheld" }, { surface: "spec" }, [unheld]), live: true },
    ]);
    expect(repair.route).toBe("external");
    expect(repair.rewrite).toEqual([]);
  });

  test("a case that resolves to no generated test is external", async () => {
    const row = await rowFor([result({ featureName: "demo", specName: "missing" })]);
    expect(row.repair!.route).toBe("external");
    expect(row.test).toBeNull();
  });

  test("a case with no recording routes to external", async () => {
    await makeCase("demo", "norecording");

    const repair = await repairFor([result({ featureName: "demo", specName: "norecording" })]);
    expect(repair.route).toBe("external");
    expect(repair.reason).toContain("no generation stamp");
  });

  test("a stamped test edited afterwards is external, still carrying the pairs", async () => {
    const testAbs = await makeStampedCase("demo", "edited", [NAMES_IT]);
    await writeFile(testAbs, "test('flow', () => { /* edited by hand */ });\n", "utf8");

    const repair = await repairFor([
      result({ featureName: "demo", specName: "edited" }, { surface: "spec" }, [held]),
    ]);
    expect(repair.route).toBe("external");
    expect(repair.reason).toContain("edited since it was generated");
    // Rewriting the document rebuilds nothing, so the person taking this over
    // can still use them.
    expect(repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
  });

  test("a recording that names the renamed string has to be recorded again", async () => {
    await makeStampedCase("demo", "recorded", [NAMES_IT]);

    const repair = await repairFor([
      result({ featureName: "demo", specName: "recorded" }, {}, [unheld]),
    ]);
    expect(repair.route).toBe("rerecord");
    // Nothing to edit first: the document never quoted it.
    expect(repair.rewrite).toEqual([]);
    expect(repair.reason).not.toContain("Apply 'rewrite'");
  });

  test("a string in both the recording and the document is rewritten, then recorded again", async () => {
    await makeStampedCase("demo", "both", [NAMES_IT]);

    const repair = await repairFor([
      result({ featureName: "demo", specName: "both" }, { surface: "spec" }, [held]),
    ]);
    expect(repair.route).toBe("rerecord");
    expect(repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
    expect(repair.reason).toContain("Apply 'rewrite' to 'document' first");
  });

  test("a generated-surface finding the recording does not name is regenerated", async () => {
    await makeStampedCase("demo", "regen");

    const row = await rowFor([result({ featureName: "demo", specName: "regen" })]);
    expect(row.repair!.route).toBe("regenerate");
    expect(row.repair!.rewrite).toEqual([]);
    expect(row.repair!.reason).not.toContain("Apply 'rewrite'");
    expect(row.document).toBe(".ccqa/features/demo/test-cases/regen/spec.yaml");
  });

  test("a document-only rename is regenerated after the rewrite", async () => {
    await makeStampedCase("demo", "on-the-document");

    const repair = await repairFor([
      result({ featureName: "demo", specName: "on-the-document" }, { surface: "spec" }, [held]),
    ]);
    expect(repair.route).toBe("regenerate");
    expect(repair.rewrite).toEqual([{ from: "Submit", to: "Send" }]);
    expect(repair.reason).toContain("Apply 'rewrite' to 'document' first");
  });

  test("a spec-surface finding with nothing to rewrite is external", async () => {
    await makeStampedCase("demo", "imported");

    const repair = await repairFor([
      result({ featureName: "demo", specName: "imported" }, { surface: "spec" }),
    ]);
    expect(repair.route).toBe("external");
  });

});

describe("buildAuditReport — the payload", () => {
  const target: SpecTarget = { featureName: "demo", specName: "clean" };

  test("a clean row names the case and carries nothing about repairing it", async () => {
    const row = await rowFor([{ target, ok: true, drift: null }]);
    expect(row).toEqual({ feature: "demo", spec: "clean", case: "demo/clean", ok: true, drift: null });
  });

  test("an errored row carries the error and still no repair", async () => {
    const row = await rowFor([{ target, ok: false, drift: null, error: "Claude returned an error result" }]);
    expect(row.error).toBe("Claude returned an error result");
    expect(row.repair).toBeUndefined();
  });

  test("a finding row adds the test, the document and the repair", async () => {
    await makeStampedCase("demo", "regen");

    const row = await rowFor([result({ featureName: "demo", specName: "regen" })]);
    expect(row.case).toBe("demo/regen");
    expect(row.drift?.label).toBe("TEST_DRIFT");
    expect(row.test).toBe(".ccqa/features/demo/test-cases/regen/test.spec.ts");
    expect(row.document).toBe(".ccqa/features/demo/test-cases/regen/spec.yaml");
    expect(row.repair?.route).toBe("regenerate");
  });

  // A finding row does real work — resolving its test, reading its recording —
  // while a clean one returns at once, so order has to be kept rather than
  // falling out of how fast each row happened to finish.
  test("rows come back in the order the sweep produced them", async () => {
    await makeStampedCase("demo", "finding");

    const report = await reportFor([
      result({ featureName: "demo", specName: "finding" }),
      { target, ok: true, drift: null },
    ]);
    expect(report.specs.map((r) => r.spec)).toEqual(["finding", "clean"]);
  });
});

describe("writeAuditReport", () => {
  test("writes the report below the directory, creating it", async () => {
    const dir = join(cwd, "nested", "report");
    const path = await writeAuditReport({ specs: [] }, dir);

    expect(path).toBe(join(dir, AUDIT_REPORT_FILE));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ specs: [] });
  });
});
