import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandRunner } from "./run-command-runner.ts";
import { TargetConfigSchema } from "../config/project-config.ts";
import { SPEC_DIR_TEMPLATE } from "../store/index.ts";
import type { RunnerOptions } from "./types.ts";
import type { SpecRef } from "../store/index.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-runcmd-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const REF: SpecRef = { featureName: "demo", specName: "x" };

// Beside the spec by default, same as every built-in target's own default —
// the resolved absolute path is `.ccqa/features/demo/test-cases/x/test.spec.ts`.
const DEFAULT_TEST_PATH = `${SPEC_DIR_TEMPLATE}/test.spec.ts`;

async function writeSpecFiles(opts: { withTestFile?: boolean } = {}): Promise<void> {
  const dir = join(cwd, ".ccqa/features/demo/test-cases/x");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "spec.yaml"),
    "title: Sample flow\nsteps:\n  - instruction: open the page\n    expected: the form is shown\n",
    "utf8",
  );
  if (opts.withTestFile ?? true) {
    await writeFile(join(dir, "test.spec.ts"), "// generated test\n", "utf8");
  }
}

function runnerOpts(
  runCommand?: string,
  extra: Partial<RunnerOptions> = {},
): RunnerOptions {
  return {
    cwd,
    reportDir: join(cwd, "report"),
    concurrency: 1,
    resources: () => [],
    targetId: "ext-run",
    targetConfig: TargetConfigSchema.parse(runCommand !== undefined ? { runCommand } : {}),
    defaultTestPath: DEFAULT_TEST_PATH,
    stepEvidence: { supported: false, reason: "test target" },
    browserCoverage: { browser: "none", reason: "test target" },
    onSpecComplete: async () => {},
    ...extra,
  };
}

describe("runCommandRunner", () => {
  it("fails with 'ccqa generate' guidance when no generated test exists at the resolved testPath", async () => {
    await writeSpecFiles({ withTestFile: false });
    const [row] = await runCommandRunner.run([REF], runnerOpts("echo {files}"));
    expect(row!.status).toBe("failed");
    expect(row!.title).toBe("Sample flow");
    expect(row!.failureLogExcerpt).toContain("no generated test at");
    expect(row!.failureLogExcerpt).toContain("ccqa generate demo/x");
    // A pre-execution failure is marked "did not execute" so the classifier
    // skips it — an empty script + "run ccqa generate" log is not a real
    // failure to triage, and a junk label would pollute the learning corpus.
    expect(row!.analysisSkipped).toContain("spec did not execute");
    expect(row!.analysisSkipped).toContain("no generated tests");
  });

  it("expands {files} to the resolved testPath and passes on exit 0", async () => {
    await writeSpecFiles();
    const capture =
      `node -e "require('fs').writeFileSync('args.txt', process.argv.slice(1).join(' '))" {files}`;
    const [row] = await runCommandRunner.run([REF], runnerOpts(capture));
    expect(row!.status).toBe("passed");
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
    expect(row!.failureLogExcerpt).toBeNull();
    // The command ran in `cwd` with {files} expanded to the spec's testPath.
    expect(await readFile(join(cwd, "args.txt"), "utf8")).toBe(
      ".ccqa/features/demo/test-cases/x/test.spec.ts",
    );
  });

  it("reports a failing command with its exit code and output tail", async () => {
    await writeSpecFiles();
    const failing = `node -e "console.error('boom detail'); process.exit(3)"`;
    const [row] = await runCommandRunner.run([REF], runnerOpts(failing));
    expect(row!.status).toBe("failed");
    expect(row!.failureLogExcerpt).toContain("exit 3");
    expect(row!.failureLogExcerpt).toContain("boom detail");
    expect(row!.specYaml).toContain("Sample flow");
    // The runner never decides about analysis; the pipeline classifies the row.
    expect(row!.analysisSkipped).toBeNull();
    // Even a failed run keeps its full output as an artifact.
    expect(row!.artifacts).toEqual([
      expect.objectContaining({ name: "output.log", kind: "text" }),
    ]);
  });

  it("expands {artifactsDir}, injects CCQA_ARTIFACTS_DIR, and collects artifacts + output.log", async () => {
    await writeSpecFiles();
    const artifactsDir = join(cwd, "report", "artifacts", "demo__x");
    // A stale file from a previous run must not leak into this row.
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "stale.txt"), "old", "utf8");
    // Writes via the template arg AND the env var, and prints to stdout.
    const script =
      "const fs=require('fs');const dir=process.argv[1];" +
      "fs.writeFileSync(dir+'/shot.png','png-bytes');" +
      "fs.mkdirSync(dir+'/sub');fs.writeFileSync(dir+'/sub/result.json','{}');" +
      "fs.writeFileSync(process.env.CCQA_ARTIFACTS_DIR+'/env.txt','from-env');" +
      "console.log('hello artifacts')";
    const [row] = await runCommandRunner.run(
      [REF],
      runnerOpts(`node -e "${script}" {artifactsDir}`),
    );
    expect(row!.status).toBe("passed");
    expect(row!.target).toBe("ext-run");
    expect(row!.artifacts).toEqual([
      { name: "output.log", path: "artifacts/demo__x/output.log", kind: "text", sizeBytes: expect.any(Number) },
      { name: "env.txt", path: "artifacts/demo__x/env.txt", kind: "text", sizeBytes: 8 },
      { name: "shot.png", path: "artifacts/demo__x/shot.png", kind: "image", sizeBytes: 9 },
      { name: "sub/result.json", path: "artifacts/demo__x/sub/result.json", kind: "json", sizeBytes: 2 },
    ]);
    // output.log is a shell transcript: the command line, then its output.
    const outputLog = await readFile(join(artifactsDir, "output.log"), "utf8");
    expect(outputLog).toMatch(/^\$ node /);
    expect(outputLog).toContain("hello artifacts");
  });

  it("keeps output.log even when the command wipes the artifacts dir (playwright --output style)", async () => {
    await writeSpecFiles();
    // Simulate `playwright test --output <dir>`: delete + recreate the dir at
    // startup, then write an artifact into it.
    const script =
      "const fs=require('fs');const dir=process.env.CCQA_ARTIFACTS_DIR;" +
      "fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});" +
      "fs.writeFileSync(dir+'/trace.txt','t');console.log('wiped and wrote')";
    const [row] = await runCommandRunner.run([REF], runnerOpts(`node -e "${script}"`));
    expect(row!.status).toBe("passed");
    expect(row!.artifacts).toEqual([
      expect.objectContaining({ name: "output.log", kind: "text" }),
      expect.objectContaining({ name: "trace.txt", kind: "text" }),
    ]);
    const outputLog = await readFile(
      join(cwd, "report", "artifacts", "demo__x", "output.log"),
      "utf8",
    );
    expect(outputLog).toContain("wiped and wrote");
  });

  it("reports each spec through onSpecComplete as it finishes", async () => {
    await writeSpecFiles();
    const streamed: string[] = [];
    const [row] = await runCommandRunner.run(
      [REF],
      runnerOpts(`node -e "process.exit(0)"`, {
        onSpecComplete: async (r) => {
          streamed.push(`${r.feature}/${r.spec}`);
        },
      }),
    );
    expect(row!.status).toBe("passed");
    expect(streamed).toEqual(["demo/x"]);
  });

  it("never rejects the pool when onSpecComplete throws (would race the final report write)", async () => {
    await writeSpecFiles();
    // A throwing incremental push (e.g. a hub PATCH failure) must not escape the
    // worker — otherwise runPool rejects and sibling workers keep running
    // detached, clobbering the authoritative final report.
    const rows = await runCommandRunner.run(
      [REF],
      runnerOpts(`node -e "process.exit(0)"`, {
        onSpecComplete: () => Promise.reject(new Error("hub push exploded")),
      }),
    );
    expect(rows.map((r) => `${r.feature}/${r.spec}:${r.status}`)).toEqual(["demo/x:passed"]);
  });

  it("loads step evidence + injects CCQA_EVIDENCE_DIR when the target supports it", async () => {
    await writeSpecFiles();
    // Simulate a generated test's ccqa/step-evidence calls: write the <id>.png
    // + <id>.json pair into CCQA_EVIDENCE_DIR the runner points us at.
    const script =
      "const fs=require('fs');const dir=process.env.CCQA_EVIDENCE_DIR;" +
      "fs.writeFileSync(dir+'/step-01.png','png');" +
      "fs.writeFileSync(dir+'/step-01.json',JSON.stringify({stepId:'step-01',source:'spec',pngFile:'step-01.png',url:null,title:null,capturedAt:null}));";
    const [row] = await runCommandRunner.run(
      [REF],
      runnerOpts(`node -e "${script}"`, { stepEvidence: { supported: true } }),
    );
    expect(row!.status).toBe("passed");
    expect(row!.evidence).toEqual([expect.objectContaining({ stepId: "step-01", pngPath: expect.stringContaining("step-01.png") })]);
    expect(row!.evidenceUnavailable).toBeUndefined();
  });

  it("records evidenceUnavailable when a supported target captured nothing", async () => {
    await writeSpecFiles();
    const [row] = await runCommandRunner.run(
      [REF],
      runnerOpts(`node -e "process.exit(0)"`, { stepEvidence: { supported: true } }),
    );
    expect(row!.evidence).toBeNull();
    expect(row!.evidenceUnavailable).toContain("ccqa/step-evidence");
  });

  it("records the target's reason as evidenceUnavailable when it can't capture", async () => {
    await writeSpecFiles();
    const [row] = await runCommandRunner.run(
      [REF],
      runnerOpts(`node -e "process.exit(0)"`, {
        stepEvidence: { supported: false, reason: "no screen to capture" },
      }),
    );
    expect(row!.evidence).toBeNull();
    expect(row!.evidenceUnavailable).toBe("no screen to capture");
  });
});
