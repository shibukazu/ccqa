import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTraceSteps, readZip } from "./trace-evidence.ts";
import { buildZip } from "./zip-fixture.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempFile(name: string, data: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-trace-evidence-"));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe("readZip", () => {
  it("round-trips a deflated entry and a stored entry, including a nested name", async () => {
    const deflated = Buffer.from("hello from a deflated entry");
    const stored = Buffer.from("hello from a stored entry");
    const zip = buildZip([
      { name: "resources/abc123", data: deflated, method: "deflate" },
      { name: "top-level.txt", data: stored, method: "stored" },
    ]);
    const path = await tempFile("archive.zip", zip);

    const entries = await readZip(path);

    expect(entries.names).toEqual(["resources/abc123", "top-level.txt"]);
    expect(entries.read("resources/abc123")).toEqual(deflated);
    expect(entries.read("top-level.txt")).toEqual(stored);
    expect(entries.read("absent")).toBeUndefined();
  });

  it("throws a clear error when no EOCD signature is present", async () => {
    const path = await tempFile("not-a-zip.bin", Buffer.alloc(64, 0));
    await expect(readZip(path)).rejects.toThrow(/not a zip archive/);
  });
});

/** The runner's side of a call: a step, or an API call made inside one. */
function runner(callId: string, title: string, start: number, end: number, parentId?: string) {
  return [
    { type: "before", callId, stepId: callId, startTime: start, title, ...(parentId ? { parentId } : {}) },
    { type: "after", callId, endTime: end },
  ];
}

/** The browser's side of a call, pointing at the runner call it ran in. */
function browser(callId: string, stepId: string, start: number, end: number) {
  return [
    {
      type: "before",
      callId,
      stepId,
      pageId: "page@1",
      startTime: start,
      beforeSnapshot: `before@${callId}`,
    },
    {
      type: "frame-snapshot",
      snapshot: { snapshotName: `before@${callId}`, isMainFrame: true, viewport: { width: 1280, height: 720 } },
    },
    { type: "after", callId, endTime: end, afterSnapshot: `after@${callId}` },
  ];
}

const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("parseTraceSteps", () => {
  it("brackets a step with its first call's before and its last call's after, nested steps included", () => {
    const steps = parseTraceSteps(
      jsonl([
        ...runner("s1", "step 1: Add an item", 0, 100),
        ...runner("inner", "fill the form", 5, 60, "s1"),
        ...runner("api1", "Fill", 10, 20, "inner"),
        ...browser("call@1", "api1", 11, 19),
        ...runner("exp1", "Expect toBeVisible", 70, 90, "s1"),
        ...browser("call@2", "exp1", 71, 89),
      ]),
    );

    expect(steps.find((s) => s.title === "step 1: Add an item")).toEqual({
      title: "step 1: Add an item",
      before: { pageId: "page@1", name: "before@call@1", viewport: { width: 1280, height: 720 } },
      after: { pageId: "page@1", name: "after@call@2" },
    });
    expect(steps.find((s) => s.title === "fill the form")?.after?.name).toBe("after@call@1");
  });

  // A cleanup hook runs right after the last step; what it opens must not
  // become that step's result.
  it("keeps a hook step's calls out of the step before it", () => {
    const steps = parseTraceSteps(
      jsonl([
        ...runner("s7", "step 7: Search the list", 0, 50),
        ...runner("exp", "Expect toBeVisible", 10, 40, "s7"),
        ...browser("call@1", "exp", 11, 39),
        ...runner("hook", "After Hooks", 51, 200),
        ...runner("c1", "cleanup 1: Delete the item", 52, 150, "hook"),
        ...runner("click", "Click", 60, 140, "c1"),
        ...browser("call@2", "click", 61, 139),
      ]),
    );

    expect(steps.find((s) => s.title.startsWith("step 7"))?.after?.name).toBe("after@call@1");
    expect(steps.find((s) => s.title.startsWith("cleanup 1"))?.before?.name).toBe("before@call@2");
  });

  it("leaves a step with no browser call without snapshots, and carries its error", () => {
    const steps = parseTraceSteps(
      [
        JSON.stringify({ type: "before", callId: "s1", startTime: 0, title: "step 1: Wait" }),
        "{not valid json",
        JSON.stringify({ type: "after", callId: "s1", endTime: 5, error: { message: "boom" } }),
      ].join("\n"),
    );

    expect(steps).toEqual([{ title: "step 1: Wait", error: "boom" }]);
  });
});
