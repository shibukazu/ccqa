import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DriftDiagnosis } from "../report/schema.ts";
import { saveRecording, specCase, stampGeneratedTest } from "../store/index.ts";
import { writeAuditBriefs, type AuditBrief } from "./brief.ts";
import type { SpecResult, SpecTarget } from "./types.ts";

const SPEC = "title: Sample\nsteps:\n  - instruction: Open the app\n    expected: The home screen is visible\n";

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

function result(target: SpecTarget, overrides: Partial<DriftDiagnosis> = {}): SpecResult {
  return { target, ok: false, drift: drift(overrides) };
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
async function makeStampedCase(feature: string, spec: string): Promise<string> {
  const testAbs = await makeCase(feature, spec);
  const ref = specCase(feature, spec, cwd);
  await saveRecording(ref, [{ action: "navigate", value: "https://example.test" }]);
  await stampGeneratedTest(ref, testAbs);
  return testAbs;
}

async function readBrief(path: string): Promise<AuditBrief> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("writeAuditBriefs", () => {
  test("a generated test unchanged since its recording's stamp routes to regenerate", async () => {
    await makeStampedCase("demo", "regen");

    const [path] = await writeAuditBriefs({
      results: [result({ featureName: "demo", specName: "regen" })],
      cwd,
      dir: join(cwd, "briefs"),
    });
    expect((await readBrief(path!)).repair.route).toBe("regenerate");
  });

  test("a stamped test edited afterwards routes to external", async () => {
    const testAbs = await makeStampedCase("demo", "edited");
    await writeFile(testAbs, "test('flow', () => { /* edited by hand */ });\n", "utf8");

    const [path] = await writeAuditBriefs({
      results: [result({ featureName: "demo", specName: "edited" })],
      cwd,
      dir: join(cwd, "briefs"),
    });
    expect((await readBrief(path!)).repair.route).toBe("external");
  });

  test("a finding a regeneration would reproduce routes to external, stamp or no stamp", async () => {
    await makeStampedCase("demo", "spec-change");
    await makeStampedCase("demo", "on-the-document");

    const [changed, onDocument] = await writeAuditBriefs({
      results: [
        // The document is stale, so recompiling it produces the same stale test.
        result({ featureName: "demo", specName: "spec-change" }, { label: "SPEC_CHANGE" }),
        // Test drift, but on the surface a regeneration reads rather than writes.
        result({ featureName: "demo", specName: "on-the-document" }, { surface: "spec" }),
      ],
      cwd,
      dir: join(cwd, "briefs"),
    });

    expect((await readBrief(changed!)).repair.route).toBe("external");
    expect((await readBrief(onDocument!)).repair.route).toBe("external");
  });

  test("a case with no recording routes to external", async () => {
    await makeCase("demo", "norecording");

    const [path] = await writeAuditBriefs({
      results: [result({ featureName: "demo", specName: "norecording" })],
      cwd,
      dir: join(cwd, "briefs"),
    });
    expect((await readBrief(path!)).repair.route).toBe("external");
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
