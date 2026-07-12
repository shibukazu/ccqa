import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupSpecsByTarget, runExternalSpecs, type TargetDispatch } from "./target-dispatch.ts";
import { createIncrementalReport, type ReportEnvelope } from "./incremental-report.ts";
import { resolveTargetFrom } from "../targets/registry.ts";
import { agentBrowserTarget } from "../targets/agent-browser/index.ts";
import type { GenerateResult, RunnerOptions, TargetPlugin, TestRunner } from "../targets/types.ts";
import { emptySpecRow } from "../report/spec-row.ts";
import { ProjectConfigSchema, type ProjectConfig } from "../config/project-config.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import type { ReportSpecResult, RunReportData } from "../report/schema.ts";
import type { SpecRef } from "../store/index.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-dispatch-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeSpec(feature: string, spec: string, yaml: string): Promise<SpecRef> {
  const dir = join(cwd, ".ccqa/features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec.yaml"), yaml, "utf8");
  return { featureName: feature, specName: spec };
}

function specYaml(extra = ""): string {
  return [
    "title: Sample flow",
    ...(extra ? [extra] : []),
    "steps:",
    "  - instruction: open the page",
    "    expected: the form is shown",
    "",
  ].join("\n");
}

const noopRunner: TestRunner = {
  run: () => Promise.resolve([]),
};

function fakePlugin(id: string, runner?: TestRunner): TargetPlugin {
  return {
    id,
    input: "spec",
    generate: (): Promise<GenerateResult> => {
      throw new Error("not under test");
    },
    ...(runner ? { runner } : {}),
  };
}

/** Injectable resolver backed by agent-browser + the given fake targets. */
function resolverWith(...plugins: TargetPlugin[]) {
  const registry = new Map([agentBrowserTarget, ...plugins].map((p) => [p.id, p]));
  return (spec: TestSpec, config: ProjectConfig) => resolveTargetFrom(spec, config, registry);
}

describe("groupSpecsByTarget", () => {
  it("routes agent-browser (default target) specs to the det/live path", async () => {
    const a = await writeSpec("demo", "a", specYaml());
    const b = await writeSpec("demo", "b", specYaml("target: agent-browser"));
    const dispatch = await groupSpecsByTarget([a, b], ProjectConfigSchema.parse({}), cwd);
    expect(dispatch.agentBrowser).toEqual([a, b]);
    expect(dispatch.external).toEqual([]);
    expect(dispatch.skipped).toEqual([]);
    expect(dispatch.unresolved).toEqual([]);
  });

  it("groups runnable external-target specs per target with their config", async () => {
    const ab = await writeSpec("demo", "ab", specYaml());
    const x = await writeSpec("demo", "x", specYaml("target: ext-run"));
    const y = await writeSpec("demo", "y", specYaml("target: ext-run"));
    const config = ProjectConfigSchema.parse({
      targets: { "ext-run": { runCommand: "echo {files}" } },
    });
    const dispatch = await groupSpecsByTarget(
      [ab, x, y],
      config,
      cwd,
      resolverWith(fakePlugin("ext-run", noopRunner)),
    );
    expect(dispatch.agentBrowser).toEqual([ab]);
    expect(dispatch.external).toHaveLength(1);
    const group = dispatch.external[0]!;
    expect(group.targetId).toBe("ext-run");
    expect(group.targetConfig.runCommand).toBe("echo {files}");
    expect(group.specs.map((s) => s.specName)).toEqual(["x", "y"]);
    expect(group.specs[0]!.title).toBe("Sample flow");
  });

  it("skips generate-only targets (no runner)", async () => {
    const ref = await writeSpec("demo", "gen", specYaml("target: gen-only"));
    const dispatch = await groupSpecsByTarget(
      [ref],
      ProjectConfigSchema.parse({ targets: { "gen-only": { runCommand: "echo {files}" } } }),
      cwd,
      resolverWith(fakePlugin("gen-only")),
    );
    expect(dispatch.external).toEqual([]);
    expect(dispatch.skipped).toHaveLength(1);
    expect(dispatch.skipped[0]!.reason).toContain("generate-only");
  });

  it("skips runner targets whose config has no runCommand", async () => {
    const ref = await writeSpec("demo", "norun", specYaml("target: ext-run"));
    const dispatch = await groupSpecsByTarget(
      [ref],
      ProjectConfigSchema.parse({}),
      cwd,
      resolverWith(fakePlugin("ext-run", noopRunner)),
    );
    expect(dispatch.skipped).toHaveLength(1);
    expect(dispatch.skipped[0]!.reason).toContain("runCommand");
  });

  it("records unknown-target specs as unresolved instead of throwing", async () => {
    const bad = await writeSpec("demo", "bad", specYaml("target: no-such-target"));
    const ok = await writeSpec("demo", "ok", specYaml());
    const dispatch = await groupSpecsByTarget([bad, ok], ProjectConfigSchema.parse({}), cwd);
    expect(dispatch.unresolved).toHaveLength(1);
    expect(dispatch.unresolved[0]!.reason).toContain('unknown target "no-such-target"');
    expect(dispatch.agentBrowser).toEqual([ok]);
  });

  it("falls back to agent-browser when spec.yaml is missing or unparseable", async () => {
    const broken = await writeSpec("demo", "broken", "title: [unclosed");
    const missing: SpecRef = { featureName: "demo", specName: "missing" };
    const dispatch = await groupSpecsByTarget([broken, missing], ProjectConfigSchema.parse({}), cwd);
    expect(dispatch.agentBrowser).toEqual([broken, missing]);
  });
});

const ENVELOPE: ReportEnvelope = {
  schemaVersion: 1,
  kind: "run",
  createdAt: "2026-01-01T00:00:00.000Z",
  runId: null,
  git: { head: null, base: null },
  model: null,
  language: null,
  promptVersion: "test",
  customPromptVersion: null,
};

function emptyDispatch(): TargetDispatch {
  return { agentBrowser: [], external: [], skipped: [], unresolved: [] };
}

async function readReportJson(reportDir: string): Promise<RunReportData> {
  return JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as RunReportData;
}

describe("runExternalSpecs", () => {
  it("emits failed rows for unresolved specs and skipped rows with reasons, and flushes them", async () => {
    const reportDir = join(cwd, "report");
    const dispatch: TargetDispatch = {
      ...emptyDispatch(),
      unresolved: [
        { featureName: "demo", specName: "bad", title: "Bad", reason: 'unknown target "nope"', targetId: "nope" },
      ],
      skipped: [
        { featureName: "demo", specName: "gen", title: "Gen", reason: "target is generate-only", targetId: "gen-only" },
      ],
    };
    const rows = await runExternalSpecs(dispatch, {
      cwd,
      reportDir,
      concurrency: 1,
      report: createIncrementalReport(reportDir, ENVELOPE),
    });

    expect(rows).toHaveLength(2);
    const failed = rows.find((r) => r.spec === "bad")!;
    expect(failed.status).toBe("failed");
    expect(failed.failureLogExcerpt).toContain('unknown target "nope"');
    expect(failed.target).toBe("nope");
    const skipped = rows.find((r) => r.spec === "gen")!;
    expect(skipped.status).toBe("skipped");
    expect(skipped.skipReason).toBe("target is generate-only");
    expect(skipped.target).toBe("gen-only");

    // The rows were upserted incrementally: report.json already holds them.
    const onDisk = await readReportJson(reportDir);
    expect(onDisk.results.map((r) => `${r.spec}:${r.status}`)).toEqual([
      "bad:failed",
      "gen:skipped",
    ]);
  });

  it("runs each group through its runner with targetId/targetConfig and merges the rows", async () => {
    const reportDir = join(cwd, "report");
    const seen: Array<{ specs: SpecRef[]; opts: RunnerOptions }> = [];
    const runner: TestRunner = {
      run: (specs, opts) => {
        seen.push({ specs, opts });
        return Promise.resolve(
          specs.map((s) =>
            emptySpecRow({ feature: s.featureName, spec: s.specName, title: null, status: "passed" }),
          ),
        );
      },
    };
    const dispatch: TargetDispatch = {
      ...emptyDispatch(),
      external: [
        {
          targetId: "ext-run",
          runner,
          targetConfig: { runCommand: "echo {files}", resources: [], conventions: { guides: [], examples: [] } },
          specs: [{ featureName: "demo", specName: "x", title: "X" }],
        },
      ],
    };
    const rows = await runExternalSpecs(dispatch, {
      cwd,
      reportDir,
      concurrency: 2,
      report: createIncrementalReport(reportDir, ENVELOPE),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.opts.targetId).toBe("ext-run");
    expect(seen[0]!.opts.targetConfig.runCommand).toBe("echo {files}");
    expect(seen[0]!.opts.concurrency).toBe(2);
    expect(rows.map((r) => `${r.spec}:${r.status}`)).toEqual(["x:passed"]);
    const onDisk = await readReportJson(reportDir);
    expect(onDisk.results).toHaveLength(1);
  });

  it("converts a crashing runner into failed rows for its specs", async () => {
    const reportDir = join(cwd, "report");
    const runner: TestRunner = {
      run: () => Promise.reject(new Error("runner exploded")),
    };
    const dispatch: TargetDispatch = {
      ...emptyDispatch(),
      external: [
        {
          targetId: "ext-run",
          runner,
          targetConfig: { resources: [], conventions: { guides: [], examples: [] } },
          specs: [
            { featureName: "demo", specName: "x", title: null },
            { featureName: "demo", specName: "y", title: null },
          ],
        },
      ],
    };
    const rows = await runExternalSpecs(dispatch, {
      cwd,
      reportDir,
      concurrency: 1,
      report: createIncrementalReport(reportDir, ENVELOPE),
    });
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(rows[0]!.failureLogExcerpt).toContain("runner exploded");
  });

  it("upserts external rows through the sink so --push-report sees each row", async () => {
    const reportDir = join(cwd, "report");
    const pushed: ReportSpecResult[] = [];
    const report = createIncrementalReport(reportDir, ENVELOPE, {
      onUpsert: (row) => {
        pushed.push(row);
      },
    });
    const dispatch: TargetDispatch = {
      ...emptyDispatch(),
      skipped: [{ featureName: "demo", specName: "gen", title: null, reason: "generate-only", targetId: "gen-only" }],
    };
    await runExternalSpecs(dispatch, { cwd, reportDir, concurrency: 1, report });
    expect(pushed.map((r) => r.spec)).toEqual(["gen"]);
  });
});
