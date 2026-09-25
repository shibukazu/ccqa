import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { amendForTrace, captureStepEvidence } from "./trace-capture.ts";
import type { SnapshotRenderer } from "./trace-snapshot.ts";
import { buildZip } from "./zip-fixture.ts";

const RUN = "pnpm exec playwright test e2e/todos/add.spec.ts";

describe("amendForTrace", () => {
  it("asks for the trace and directs it where ccqa reads it", () => {
    const amended = amendForTrace(RUN, "/tmp/artifacts");
    expect(amended).toEqual({ command: `${RUN} --trace=on --output=/tmp/artifacts` });
  });

  // A script that wraps `playwright test` may swallow the flags, and a command
  // reaching a second program would take them instead. Both cost the run its
  // screenshots, which is a far better outcome than a mangled command.
  it.each([
    ["pnpm test:e2e {files}", "playwright test"],
    ["pnpm exec playwright test {files} | tee out.log", "shell operators"],
  ])("refuses to amend %s, handing back what the project configured", (command, reason) => {
    const amended = amendForTrace(command, "/tmp/artifacts");
    expect(amended.skip).toContain(reason);
    expect(amended.command).toBe(command);
  });

  // The project chose its own trace mode, and any of them leaves an archive.
  it("leaves a command that already asks for a trace to its own setting", () => {
    const own = `${RUN} --trace=retain-on-failure`;
    expect(amendForTrace(own, "/tmp/artifacts")).toEqual({
      command: `${own} --output=/tmp/artifacts`,
    });
  });

  it("accepts an --output already pointing at the artifacts dir, and refuses one that is not", () => {
    const pointed = `${RUN} --output=/tmp/artifacts`;
    expect(amendForTrace(pointed, "/tmp/artifacts")).toEqual({
      command: `${pointed} --trace=on`,
    });
    const elsewhere = amendForTrace(`${RUN} --output=build/results`, "/tmp/artifacts");
    expect(elsewhere.skip).toContain("--output");
  });
});

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-trace-capture-"));
  dirs.push(dir);
  return dir;
}

interface Fixture {
  after?: Record<string, unknown>;
  snapshots?: boolean;
  /** False when a rewrite reshaped the step titles out of the case's labels. */
  labelled?: boolean;
  /** The test's output directory; Playwright adds `-retry<n>` for a retry. */
  dir?: string;
}

const label = (extra: Fixture, prefix: string) => (extra.labelled === false ? "" : prefix);

/** A trace with one named step around one browser call, as `--trace on` leaves it. */
function trace(extra: Fixture): string {
  const snapshots = extra.snapshots ?? true;
  return [
    { type: "before", callId: "s1", startTime: 110, title: `${label(extra, "step 1: ")}Open the list` },
    {
      type: "before",
      callId: "call@1",
      stepId: "s1",
      pageId: "page@1",
      startTime: 120,
      ...(snapshots ? { beforeSnapshot: "before@call@1" } : {}),
    },
    { type: "after", callId: "call@1", endTime: 190, ...(snapshots ? { afterSnapshot: "after@call@1" } : {}) },
    { type: "after", callId: "s1", endTime: 200, ...extra.after },
    // Playwright records its own API calls as steps too; only the ones the case
    // named have evidence rows.
    { type: "before", callId: "c2", startTime: 240, title: "page.goto" },
    { type: "after", callId: "c2", endTime: 250 },
    // A named step with no browser call in it.
    { type: "before", callId: "s2", startTime: 260, title: `${label(extra, "step 2: ")}Wait for the sync` },
    { type: "after", callId: "s2", endTime: 270 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
}

async function writeArchive(artifactsDir: string, extra: Fixture = {}): Promise<void> {
  const zip = buildZip([{ name: "test.trace", data: Buffer.from(trace(extra)), method: "deflate" }]);
  // Playwright nests one directory per test under the output dir, so the
  // archive is only ever found by looking below it.
  const nested = join(artifactsDir, extra.dir ?? "todos-add-an-item");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "trace.zip"), zip);
}

/** Renders each snapshot as its own name, so a test can read which one landed where. */
const fakeRenderer = async (): Promise<SnapshotRenderer> => ({
  render: async (snapshot) => Buffer.from(snapshot.name),
  close: async () => {},
});

async function capture(
  artifactsDir: string,
  evidenceDir: string,
  options: { warnings?: string[]; renderer?: () => Promise<SnapshotRenderer> } = {},
) {
  return captureStepEvidence({
    artifactsDir,
    evidenceDir,
    playwrightFrom: [artifactsDir],
    warn: (message) => options.warnings?.push(message),
    openRenderer: options.renderer ?? fakeRenderer,
  });
}

async function readMeta(evidenceDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(evidenceDir, "step-01.json"), "utf8")) as Record<string, unknown>;
}

describe("captureStepEvidence", () => {
  it("renders the snapshots that bracket each step the case named, and says which step got none", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir);
    const warnings: string[] = [];

    expect(await capture(artifactsDir, evidenceDir, { warnings })).toBeNull();
    expect((await readdir(evidenceDir)).sort()).toEqual([
      "step-01.before.jpeg",
      "step-01.jpeg",
      "step-01.json",
    ]);
    expect(await readFile(join(evidenceDir, "step-01.before.jpeg"), "utf8")).toBe("before@call@1");
    expect(await readFile(join(evidenceDir, "step-01.jpeg"), "utf8")).toBe("after@call@1");
    expect(await readMeta(evidenceDir)).toMatchObject({
      stepId: "step-01",
      source: "case",
      pngFile: "step-01.jpeg",
      beforePngFile: "step-01.before.jpeg",
    });
    expect(warnings).toEqual([expect.stringMatching(/^step-02: no screenshot/)]);
  });

  // Without this the pictures of a failed run read as a run that went fine: the
  // evidence table marks a step failed from `failureSummary` and nothing else.
  it("marks the step a failed run died in", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir, { after: { error: { message: "expected the banner to be visible" } } });

    expect(await capture(artifactsDir, evidenceDir)).toBeNull();
    expect((await readMeta(evidenceDir)).failureSummary).toBe("expected the banner to be visible");
  });

  // The row reports the retry that passed; the failed first attempt must not
  // overwrite it or repeat its warnings.
  it("renders only each test's last attempt", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir, { after: { error: { message: "first attempt failed" } } });
    await writeArchive(artifactsDir, { dir: "todos-add-an-item-retry1" });
    const warnings: string[] = [];

    expect(await capture(artifactsDir, evidenceDir, { warnings })).toBeNull();
    expect((await readMeta(evidenceDir)).failureSummary).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  // The report renders the reason instead of an empty section, so it has to say
  // which thing went wrong.
  it("says the run left no trace when it did not", async () => {
    expect(await capture(await tempDir(), await tempDir())).toContain("no Playwright trace");
  });

  it("tells a trace without snapshots apart from one whose steps do not match", async () => {
    const withoutSnapshots = await tempDir();
    await writeArchive(withoutSnapshots, { snapshots: false });
    expect(await capture(withoutSnapshots, await tempDir())).toContain("no DOM snapshot");

    const renamed = await tempDir();
    await writeArchive(renamed, { labelled: false });
    expect(await capture(renamed, await tempDir())).toContain("no step the case names");
  });

  it("gives the render error when nothing could be rendered", async () => {
    const opening = await tempDir();
    await writeArchive(opening);
    expect(
      await capture(opening, await tempDir(), {
        renderer: () => Promise.reject(new Error("Playwright is not installed")),
      }),
    ).toBe("ccqa could not render the trace's snapshots: Playwright is not installed");

    const rendering = await tempDir();
    await writeArchive(rendering);
    const blank = async (): Promise<SnapshotRenderer> => ({ render: async () => null, close: async () => {} });
    expect(await capture(rendering, await tempDir(), { renderer: blank })).toBe(
      "ccqa could not render the trace's snapshots: snapshot rendered blank",
    );
  });

  // Every test starts on a blank document, so its first step's before is one.
  it("leaves out a blank before without a warning", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir);
    const warnings: string[] = [];
    const blankBefore = async (): Promise<SnapshotRenderer> => ({
      render: async (snapshot) => (snapshot.name.startsWith("before") ? null : Buffer.from(snapshot.name)),
      close: async () => {},
    });

    expect(await capture(artifactsDir, evidenceDir, { warnings, renderer: blankBefore })).toBeNull();
    expect(await readdir(evidenceDir)).not.toContain("step-01.before.jpeg");
    expect(warnings.filter((w) => w.startsWith("step-01"))).toEqual([]);
  });

  it("keeps what it wrote when closing the viewer fails", async () => {
    const artifactsDir = await tempDir();
    await writeArchive(artifactsDir);
    const warnings: string[] = [];
    const unclosable = async (): Promise<SnapshotRenderer> => ({
      ...(await fakeRenderer()),
      close: () => Promise.reject(new Error("browser gone")),
    });

    expect(await capture(artifactsDir, await tempDir(), { warnings, renderer: unclosable })).toBeNull();
    expect(warnings).toContainEqual(expect.stringContaining("browser gone"));
  });

  // What the test wrote itself is its own screenshot per boundary.
  it("leaves evidence the test wrote itself alone", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir);
    await writeFile(join(evidenceDir, "step-01.png"), "the test's own shot");

    expect(await capture(artifactsDir, evidenceDir)).toBeNull();
    expect(await readdir(evidenceDir)).toEqual(["step-01.png"]);
  });
});
