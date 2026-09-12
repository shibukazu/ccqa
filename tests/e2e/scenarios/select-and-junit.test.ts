import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { fixturePath, makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noAuthEnv, noColorEnv, stripAnsi, stubSecurityBinary } from "../_helpers/env.ts";
import { execFileP } from "../../../src/drift/affected.ts";
import { DEFAULT_REPORT_DIR } from "../../../src/run/report-constants.ts";
import { RunReportDataSchema, type RunReportData } from "../../../src/report/schema.ts";

// Two features that both landed hub-free: `select-specs` can now decide
// what to run from a local `ccqa run --coverage` report instead of a hub,
// and `ccqa run` can hand its results to CI as JUnit XML. Neither has an
// existing e2e cover, and both are wiring risks — the interesting failure
// mode for each is "the CLI plumbing drops the new input/output", not the
// selection or rendering logic itself, which already has unit coverage.

const git = (cwd: string, ...args: string[]) => execFileP("git", args, { cwd });

async function initGitRepo(cwd: string): Promise<void> {
  await git(cwd, "init", "--initial-branch=main");
  await git(cwd, "config", "user.email", "e2e@example.com");
  await git(cwd, "config", "user.name", "e2e");
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "fixture", "--no-gpg-sign");
}

/** One `results` row, built through the real schema so a drifted fixture fails to parse rather than drifting silently. */
function coverageRow(feature: string, spec: string, files: string[]): RunReportData["results"][number] {
  return {
    feature,
    spec,
    title: null,
    status: "passed",
    testCounts: null,
    durationMs: 1000,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
    coverage: {
      files,
      frontendFiles: files.length,
      backendFiles: 0,
      backendReported: false,
      frontendReported: true,
      frontendStopped: false,
      actorWindows: [],
      excludedDependencies: 0,
      gaps: {
        unattributed: 0,
        unmappedScripts: 0,
        unmappedRanges: 0,
        outsideProject: 0,
        unresolvedSources: 0,
      outsideProjectSamples: [],
      unresolvedSamples: [],
        uninstrumentedFiles: 0,
        uninstrumentedProcesses: 0,
        droppedPushes: 0,
        unmappedActorEvents: 0,
        outsideWindowEvents: 0,
      },
    },
  };
}

async function writeLocalReport(cwd: string, results: RunReportData["results"]): Promise<void> {
  const data = RunReportDataSchema.parse({
    schemaVersion: 1,
    kind: "run",
    createdAt: "2026-06-10T00:00:00.000Z",
    runId: null,
    git: { head: "abc1234", base: null },
    model: null,
    promptVersion: "1",
    results,
  });
  const reportDir = join(cwd, DEFAULT_REPORT_DIR);
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, "report.json"), JSON.stringify(data, null, 2), "utf8");
}

describe("ccqa select-specs --format paths (no hub)", () => {
  let project: FakeProject | null = null;
  let productDir: string | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
    if (productDir) {
      await rm(productDir, { recursive: true, force: true });
      productDir = null;
    }
  });

  test("selects the spec whose last measured reach includes a changed file, printing bare paths only", async () => {
    project = await makeFakeProject("multi-spec");
    await mkdir(join(project.cwd, "src"), { recursive: true });
    await writeFile(join(project.cwd, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await writeFile(join(project.cwd, "src", "beta.ts"), "export const beta = 1;\n", "utf8");
    await initGitRepo(project.cwd);
    const { stdout: baseSha } = await git(project.cwd, "rev-parse", "HEAD");
    const base = baseSha.trim();

    // Only alpha/one's measured file moves; beta/two's stays untouched, so it
    // must clear as notNeeded and stay out of --format paths.
    await writeFile(join(project.cwd, "src", "alpha.ts"), "export const alpha = 2;\n", "utf8");
    await git(project.cwd, "add", "-A");
    await git(project.cwd, "commit", "-m", "change alpha", "--no-gpg-sign");

    await writeLocalReport(project.cwd, [
      coverageRow("alpha", "one", ["src/alpha.ts"]),
      coverageRow("beta", "two", ["src/beta.ts"]),
    ]);

    const result = await runCcqa(["select-specs", "--against", `${base}..HEAD`, "--format", "paths"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(stripAnsi(result.stdout)).toBe(".ccqa/features/alpha/test-cases/one/test.spec.ts\n");
  });

  // The shape a project whose tests and application are separate checkouts has:
  // the measured reach is a markdown case's, the diff is taken in the
  // application's repository, and `coverage.projectRoot` points outside cwd —
  // which used to be refused outright.
  test("selects a markdown case from a change in the application's own checkout", async () => {
    project = await makeFakeProject("external-target");
    productDir = await mkdtemp(join(tmpdir(), "ccqa-e2e-product-"));
    await cp(fixturePath("todo-product"), productDir, { recursive: true });
    await initGitRepo(productDir);
    const { stdout: baseSha } = await git(productDir, "rev-parse", "HEAD");
    const base = baseSha.trim();

    await writeFile(
      join(project.cwd, ".ccqa", "config.yaml"),
      [
        await readFile(join(project.cwd, ".ccqa", "config.yaml"), "utf8"),
        "coverage:",
        "  instrumentedOrigins: [https://example.test]",
        `  projectRoot: ${productDir}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await initGitRepo(project.cwd);

    await writeFile(
      join(productDir, "src", "todo-list.ts"),
      `${await readFile(join(productDir, "src", "todo-list.ts"), "utf8")}\n// changed\n`,
      "utf8",
    );
    await git(productDir, "add", "-A");
    await git(productDir, "commit", "-m", "change the list", "--no-gpg-sign");

    // The case id is the row's feature/spec pair, the way a markdown case is
    // addressed everywhere else.
    await writeLocalReport(project.cwd, [coverageRow("todo", "add_item", ["src/todo-list.ts"])]);

    const result = await runCcqa(
      ["select-specs", "--against", `${base}..HEAD`, "--repo", productDir, "--format", "paths"],
      { cwd: project.cwd, env: noColorEnv() },
    );
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    // The path the project's own runner is handed, from its `testPath` template.
    expect(stripAnsi(result.stdout)).toBe("specs/todo/add_item.spec.ts\n");
  });

  test("--against without a `..` is a usage error, not a git failure", async () => {
    project = await makeFakeProject("multi-spec");
    const result = await runCcqa(["select-specs", "--against", "main", "--format", "paths"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/invalid --against/);
  });
});

describe("ccqa run --report-junit", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("writes JUnit XML alongside report.json, one testcase per spec row", async () => {
    project = await makeFakeProject("multi-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "--report-junit", "ci/junit.xml"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const xml = await readFile(join(project.cwd, "ci", "junit.xml"), "utf8");
    expect(xml).toContain("<testsuites>");
    expect(xml).toMatch(/<testsuite name="ccqa" tests="2" failures="0" skipped="0" time="[\d.]+">/);
    expect(xml.match(/<testcase /g) ?? []).toHaveLength(2);
    expect(xml).toContain('classname="alpha/one"');
    expect(xml).toContain('classname="beta/two"');
  });

  test("is still written when the run fails, with a <failure> on the failing row", async () => {
    project = await makeFakeProject("failing-spec", { linkCcqa: true });
    // No --failure-analysis: keep this a run/report-writing assertion, not an
    // analysis one. Force the auth probe to fail so no real Claude call happens.
    const result = await runCcqa(["run", "--report-junit", "ci/junit.xml"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);

    const xml = await readFile(join(project.cwd, "ci", "junit.xml"), "utf8");
    expect(xml).toMatch(/<testsuite name="ccqa" tests="1" failures="1" skipped="0" time="[\d.]+">/);
    expect(xml).toMatch(/<testcase[^>]*classname="demo\/boom"[^>]*>[\s\S]*<failure/);
  });
});
