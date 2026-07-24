import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySpecRow } from "../report/spec-row.ts";
import type { ReportSpecResult } from "../report/schema.ts";
import type { DiffProvider, SpecDiffResult } from "./diff-provider.ts";
import type { FailureAnalysisDeps } from "./failure-analysis.ts";

vi.mock("../report/analyze.ts", () => ({ analyzeFailure: vi.fn() }));
vi.mock("../drift/analyze.ts", () => ({ analyzeDrift: vi.fn() }));

const { analyzeFailure } = await import("../report/analyze.ts");
const { analyzeDrift } = await import("../drift/analyze.ts");
const { ANALYSIS_DISABLED, analyzeExternalRows, beginFailureAnalysis } = await import(
  "./failure-analysis.ts"
);

/** Open the run's analysis phase for exactly the failed external rows, then analyze them. */
async function analyze(
  rows: ReportSpecResult[],
  d: FailureAnalysisDeps,
): Promise<ReportSpecResult[]> {
  const failed = rows
    .filter((r) => r.status === "failed" && r.analysisSkipped === null)
    .map((r) => ({ featureName: r.feature, specName: r.spec }));
  const run = await beginFailureAnalysis(failed, d);
  return analyzeExternalRows(rows, run);
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-analysis-"));
  vi.mocked(analyzeFailure).mockReset();
  vi.mocked(analyzeDrift).mockReset();
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const GENERATED_TEST = "test('flow', async () => { await page.click('Submit'); });\n";

/** A generated.json manifest plus the test file it points at. */
async function writeGeneratedTest(): Promise<void> {
  const specDir = join(cwd, ".ccqa/features/demo/test-cases/x");
  await mkdir(specDir, { recursive: true });
  await mkdir(join(cwd, "e2e"), { recursive: true });
  await writeFile(join(cwd, "e2e/x.spec.ts"), GENERATED_TEST, "utf8");
  await writeFile(
    join(specDir, "generated.json"),
    JSON.stringify({
      target: "ext-run",
      generatedAt: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "e2e/x.spec.ts", kind: "test", sha256: "0".repeat(64) },
        { path: "e2e/pages/helper.ts", kind: "support", sha256: "0".repeat(64) },
      ],
    }),
    "utf8",
  );
}

function failedRow(spec: string, extra: Partial<ReportSpecResult> = {}): ReportSpecResult {
  return {
    ...emptySpecRow({ feature: "demo", spec, title: "Sample flow", status: "failed" }),
    target: "ext-run",
    failureLogExcerpt: "command failed (exit 1)",
    specYaml: "title: Sample flow\n",
    ...extra,
  };
}

function diffProviderReturning(result: SpecDiffResult): DiffProvider {
  return { forSpec: () => Promise.resolve(result) };
}

const RESOLVED_DIFF: SpecDiffResult = {
  ok: true,
  base: { ref: "origin/main", sha: "abc123", source: "explicit" },
  patch: "--- a/src/app.tsx\n+++ b/src/app.tsx\n",
  nameStatus: "M\tsrc/app.tsx",
  error: null,
  range: { commitCount: 2, days: 1 },
  fileDiff: () => null,
};

function deps(overrides: Partial<FailureAnalysisDeps> = {}): FailureAnalysisDeps {
  return {
    diffProvider: diffProviderReturning(RESOLVED_DIFF),
    auth: { ok: true },
    cwd,
    reportDir: join(cwd, "report"),
    customPrompt: null,
    triageUserPrompt: null,
    ...overrides,
  };
}

const ANALYSIS = {
  label: "TEST_DRIFT" as const,
  confidence: 0.9,
  subDiagnosis: "SELECTOR_DRIFT" as const,
  headline: "the Submit button was renamed",
  recommendation: "Update the selector",
  evidence: [],
  reasoning: "",
};

describe("analyzeExternalRows", () => {
  it("classifies a failed row with the drift audit and generated test as evidence", async () => {
    await writeGeneratedTest();
    vi.mocked(analyzeDrift).mockResolvedValue([
      {
        target: { featureName: "demo", specName: "x" },
        ok: true,
        issues: [{ severity: "ERROR", category: "assertable", stepId: null, message: "label gone" }],
      },
    ]);
    vi.mocked(analyzeFailure).mockResolvedValue({ analysis: ANALYSIS, raw: "", sdkError: false });

    const passed = emptySpecRow({ feature: "demo", spec: "ok", title: null, status: "passed" });
    // A row that never executed keeps the reason the pipeline already gave it.
    const crashed = failedRow("crashed", { analysisSkipped: "spec did not execute (runner crashed)" });
    const rows = await analyze([failedRow("x"), passed, crashed], deps());

    const analyzed = rows.find((r) => r.spec === "x")!;
    expect(analyzed.analysis?.label).toBe("TEST_DRIFT");
    expect(analyzed.analysisSkipped).toBeNull();
    expect(analyzed.analysisBase).toEqual({ ref: "origin/main", sha: "abc123" });
    expect(analyzed.diffExcerpt).toBe(RESOLVED_DIFF.patch);
    expect(analyzed.driftIssues).toHaveLength(1);
    expect(rows.find((r) => r.spec === "ok")).toBe(passed);
    // A pre-execution failure keeps its recorded reason and is never classified.
    expect(rows.find((r) => r.spec === "crashed")).toBe(crashed);

    // Only the manifest's `kind: "test"` files feed the prompt's script block,
    // and the spec's artifacts dir is named so the model can read run context.
    expect(vi.mocked(analyzeFailure)).toHaveBeenCalledTimes(1);
    const promptInput = vi.mocked(analyzeFailure).mock.calls[0]![0];
    expect(promptInput.script).toContain(GENERATED_TEST);
    expect(promptInput.script).not.toContain("helper.ts");
    expect(promptInput.failureLog).toBe("command failed (exit 1)");
    expect(promptInput.driftIssues).toHaveLength(1);
    expect(promptInput.artifactsDir).toBe("report/artifacts/demo__x");
  });

  it("classifies without a baseline: no diff evidence, no analysisBase on the row", async () => {
    await writeGeneratedTest();
    vi.mocked(analyzeDrift).mockResolvedValue([
      { target: { featureName: "demo", specName: "x" }, ok: true, issues: [] },
    ]);
    vi.mocked(analyzeFailure).mockResolvedValue({ analysis: ANALYSIS, raw: "", sdkError: false });
    const [row] = await analyze(
      [failedRow("x")],
      deps({ diffProvider: diffProviderReturning({ ok: false, skip: "no recorded green yet" }) }),
    );
    expect(row!.analysisSkipped).toBeNull();
    expect(row!.analysis?.label).toBe("TEST_DRIFT");
    expect(row!.analysisBase).toBeUndefined();
    expect(row!.diffExcerpt).toBeNull();

    const promptInput = vi.mocked(analyzeFailure).mock.calls[0]![0];
    expect(promptInput.baselineMissing).toBe("no recorded green yet");
    expect(promptInput.diffPatch).toBeNull();
    expect(promptInput.baseRef).toBeNull();
  });

  it("records the disabled reason and makes no Claude calls without --failure-analysis", async () => {
    const [row] = await analyze([failedRow("x")], deps({ diffProvider: null }));
    expect(row!.analysisSkipped).toBe(ANALYSIS_DISABLED);
    expect(vi.mocked(analyzeDrift)).not.toHaveBeenCalled();
    expect(vi.mocked(analyzeFailure)).not.toHaveBeenCalled();
  });
});
