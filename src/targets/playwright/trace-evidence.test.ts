import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frameAt, parseTraceEvents, readZip } from "./trace-evidence.ts";
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

describe("parseTraceEvents", () => {
  // Merged `.trace` members arrive interleaved, so the frames are sorted here
  // rather than by every caller that searches them.
  it("reads screencast frames in timestamp order and skips a malformed line", () => {
    const jsonl = [
      JSON.stringify({ type: "screencast-frame", sha1: "b", timestamp: 20 }),
      "{not valid json",
      JSON.stringify({ type: "screencast-frame", sha1: "a", timestamp: 10 }),
    ].join("\n");

    const { frames } = parseTraceEvents(jsonl);

    expect(frames).toEqual([
      { sha1: "a", timestamp: 10 },
      { sha1: "b", timestamp: 20 },
    ]);
  });

  it("pairs before/after by callId and accepts a merged action entry, sorted by startTime", () => {
    const jsonl = [
      JSON.stringify({ type: "before", callId: "1", startTime: 5, apiName: "click" }),
      JSON.stringify({ type: "after", callId: "1", endTime: 15 }),
      JSON.stringify({
        type: "action",
        callId: "2",
        startTime: 1,
        endTime: 3,
        title: "goto",
        apiName: "goto",
      }),
    ].join("\n");

    const { steps } = parseTraceEvents(jsonl);

    expect(steps).toEqual([
      { title: "goto", startTime: 1, endTime: 3 },
      { title: "click", startTime: 5, endTime: 15 },
    ]);
  });

  it("closes an unterminated before at the last timestamp in the file", () => {
    const jsonl = [
      JSON.stringify({ type: "before", callId: "1", startTime: 5, apiName: "wait" }),
      JSON.stringify({ type: "screencast-frame", sha1: "z", timestamp: 42 }),
    ].join("\n");

    const { steps } = parseTraceEvents(jsonl);

    expect(steps).toEqual([{ title: "wait", startTime: 5, endTime: 42 }]);
  });
});

describe("frameAt", () => {
  const frames = [
    { sha1: "a", timestamp: 10 },
    { sha1: "b", timestamp: 20 },
    { sha1: "c", timestamp: 30 },
  ];

  it("picks the last frame at or before the time", () => {
    expect(frameAt(frames, 25)).toEqual({ sha1: "b", timestamp: 20 });
  });

  // The step began before the screencast captured anything — the earliest
  // available frame is the closest evidence there is.
  it("falls back to the first later frame when nothing is captured yet", () => {
    expect(frameAt(frames, 5)).toEqual({ sha1: "a", timestamp: 10 });
  });

  it("returns null when there are no frames at all", () => {
    expect(frameAt([], 10)).toBeNull();
  });
});
