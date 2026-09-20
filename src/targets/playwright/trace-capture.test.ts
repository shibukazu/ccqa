import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { amendForTrace, captureStepEvidence } from "./trace-capture.ts";
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

/** A trace whose one named step brackets two frames, as `--trace on` leaves it. */
function trace(extra: { after?: Record<string, unknown> }): string {
  return [
    { type: "screencast-frame", sha1: "frame-a", timestamp: 100 },
    { type: "before", callId: "c1", startTime: 110, apiName: "step 1: Open the list" },
    { type: "screencast-frame", sha1: "frame-b", timestamp: 120 },
    { type: "after", callId: "c1", endTime: 130, ...extra.after },
    // Playwright records its own API calls as steps too; only the ones the case
    // named have evidence rows, so the rest are passed over rather than filtered
    // upstream where a version's naming could quietly exclude a real step.
    { type: "action", callId: "c2", startTime: 140, endTime: 150, title: "page.goto" },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
}

async function writeArchive(
  artifactsDir: string,
  extra: { after?: Record<string, unknown> } = {},
): Promise<void> {
  const zip = buildZip([
    { name: "test.trace", data: Buffer.from(trace(extra)), method: "deflate" },
    { name: "resources/frame-a", data: Buffer.from("entry frame"), method: "stored" },
    { name: "resources/frame-b", data: Buffer.from("closing frame"), method: "stored" },
  ]);
  // Playwright nests one directory per test under the output dir, so the
  // archive is only ever found by looking below it.
  const nested = join(artifactsDir, "todos-add-an-item");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "trace.zip"), zip);
}

describe("captureStepEvidence", () => {
  it("writes the frames that bracket each step the case named", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir);

    expect(await captureStepEvidence({ artifactsDir, evidenceDir })).toBeNull();
    expect((await readdir(evidenceDir)).sort()).toEqual([
      "step-01.before.jpeg",
      "step-01.jpeg",
      "step-01.json",
    ]);
    expect(await readFile(join(evidenceDir, "step-01.before.jpeg"), "utf8")).toBe("entry frame");
    expect(await readFile(join(evidenceDir, "step-01.jpeg"), "utf8")).toBe("closing frame");
    const meta = JSON.parse(await readFile(join(evidenceDir, "step-01.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      stepId: "step-01",
      source: "case",
      pngFile: "step-01.jpeg",
      beforePngFile: "step-01.before.jpeg",
    });
  });

  // Without this the frames of a failed run read as a run that went fine: the
  // evidence table marks a step failed from `failureSummary` and nothing else.
  it("marks the step a failed run died in", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir, {
      after: { error: { message: "expected the banner to be visible" } },
    });

    expect(await captureStepEvidence({ artifactsDir, evidenceDir })).toBeNull();
    const meta = JSON.parse(await readFile(join(evidenceDir, "step-01.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(meta.failureSummary).toBe("expected the banner to be visible");
  });

  // The report renders the reason instead of an empty section, so it has to say
  // which of the two things went wrong — no trace at all, or a trace with no
  // step the case can be matched to.
  it("says the run left no trace when it did not", async () => {
    const reason = await captureStepEvidence({
      artifactsDir: await tempDir(),
      evidenceDir: await tempDir(),
    });
    expect(reason).toContain("no Playwright trace");
  });

  // A trace kept without its screencast names no step either, and sending a
  // reader to re-record a spec whose titles were never touched wastes the run.
  it("tells a trace with no screenshots apart from one whose steps do not match", async () => {
    const artifactsDir = await tempDir();
    const nested = join(artifactsDir, "todos-add-an-item");
    await mkdir(nested, { recursive: true });
    const stepOnly = JSON.stringify({
      type: "action",
      callId: "c1",
      startTime: 10,
      endTime: 20,
      apiName: "step 1: Open the list",
    });
    await writeFile(
      join(nested, "trace.zip"),
      buildZip([{ name: "test.trace", data: Buffer.from(stepOnly), method: "deflate" }]),
    );

    const reason = await captureStepEvidence({ artifactsDir, evidenceDir: await tempDir() });

    expect(reason).toContain("no screenshots");
  });

  // What the test wrote itself is a full screenshot per boundary, not a frame
  // of the trace's downscaled screencast.
  it("leaves evidence the test wrote itself alone", async () => {
    const artifactsDir = await tempDir();
    const evidenceDir = await tempDir();
    await writeArchive(artifactsDir);
    await writeFile(join(evidenceDir, "step-01.png"), "the test's own shot");

    expect(await captureStepEvidence({ artifactsDir, evidenceDir })).toBeNull();
    expect(await readdir(evidenceDir)).toEqual(["step-01.png"]);
  });
});
