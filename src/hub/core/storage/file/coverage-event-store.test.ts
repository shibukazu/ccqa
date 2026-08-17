import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFileCoverageEventStore, COVERAGE_RETENTION_DAYS } from "./coverage-event-store.ts";
import { coverageEventsPath } from "./paths.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function payload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function texts(entries: { payload: Uint8Array }[]): string[] {
  return entries.map((e) => new TextDecoder().decode(e.payload));
}

describe("coverage event store", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-coverage-store-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("stamps appends with a monotonic seq and serves them back after sinceSeq", async () => {
    const store = createFileCoverageEventStore(dataDir);
    for (const p of ["one", "two", "three"]) await store.append("demo", payload(p));

    const all = await store.read("demo", 0);
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.lastSeq).toBe(3);
    expect(all.skipped).toBe(0);
    expect(texts(all.entries)).toEqual(["one", "two", "three"]);
    expect(all.entries.every((e) => typeof e.at === "number")).toBe(true);

    const tail = await store.read("demo", 2);
    expect(tail.entries.map((e) => e.seq)).toEqual([3]);
    expect(tail.lastSeq).toBe(3);
  });

  test("seq resumes past the highest stored value after a restart", async () => {
    const first = createFileCoverageEventStore(dataDir);
    await first.append("demo", payload("one"));
    await first.append("demo", payload("two"));

    const second = createFileCoverageEventStore(dataDir);
    const stamp = await second.append("demo", payload("three"));
    expect(stamp.seq).toBe(3);
  });

  test("a partial line is skipped and counted, never fatal", async () => {
    const store = createFileCoverageEventStore(dataDir);
    await store.append("demo", payload("one"));
    await store.append("demo", payload("two"));
    await appendFile(coverageEventsPath(dataDir, "demo"), '{"seq":3,"at":123,"pay');

    const result = await store.read("demo", 0);
    expect(result.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(result.lastSeq).toBe(2);
    expect(result.skipped).toBe(1);
  });

  test("count retention drops the oldest events and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createFileCoverageEventStore(dataDir, { maxEvents: 4 });
    for (let i = 1; i <= 6; i++) await store.append("demo", payload(`event-${i}`));

    // The 5th append breaches the cap and prunes one batch below it (batch=1
    // at this cap), so seqs 1-2 are gone; the 6th lands back under the cap.
    const result = await store.read("demo", 0);
    expect(result.entries.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(result.lastSeq).toBe(6);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coverage inbox for "demo"'));
  });

  test("age retention drops events past the retention window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    const store = createFileCoverageEventStore(dataDir);
    await store.append("demo", payload("old-1"));
    await store.append("demo", payload("old-2"));

    now.mockReturnValue(base + (COVERAGE_RETENTION_DAYS + 1) * DAY_MS);
    await store.append("demo", payload("fresh"));

    const result = await store.read("demo", 0);
    expect(texts(result.entries)).toEqual(["fresh"]);
    expect(result.entries.map((e) => e.seq)).toEqual([3]);
    expect(result.lastSeq).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 2 events"));
  });
});
