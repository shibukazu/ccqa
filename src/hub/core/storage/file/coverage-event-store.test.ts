import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CoverageEventStore } from "../types.ts";
import { createFileCoverageEventStore, COVERAGE_RETENTION_DAYS } from "./coverage-event-store.ts";
import { coverageEventsPath } from "./paths.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type Entry = { seq: number; at: number; payload: Uint8Array };

function payload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function texts(entries: { payload: Uint8Array }[]): string[] {
  return entries.map((e) => new TextDecoder().decode(e.payload));
}

/** `scan` collected, so a test can assert on the whole stream at once. */
async function readAll(
  store: CoverageEventStore,
  project: string,
  sinceSeq: number,
): Promise<{ entries: Entry[]; lastSeq: number; skipped: number }> {
  const entries: Entry[] = [];
  const { lastSeq, skipped } = await store.scan(project, sinceSeq, (entry) => {
    entries.push(entry);
  });
  return { entries, lastSeq, skipped };
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

    const all = await readAll(store, "demo", 0);
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.lastSeq).toBe(3);
    expect(all.skipped).toBe(0);
    expect(texts(all.entries)).toEqual(["one", "two", "three"]);
    expect(all.entries.every((e) => typeof e.at === "number")).toBe(true);

    const tail = await readAll(store, "demo", 2);
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

    const result = await readAll(store, "demo", 0);
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
    const result = await readAll(store, "demo", 0);
    expect(result.entries.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(result.lastSeq).toBe(6);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coverage inbox for "demo"'));
  });

  test("byte retention drops the oldest events once the stream outgrows the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Pinned so every stored line has the same width and the cut is exact:
    // each line is 54 bytes, so a 200-byte cap prunes back to 180 = 3 lines.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const store = createFileCoverageEventStore(dataDir, { maxBytes: 200 });
    for (let i = 1; i <= 5; i++) await store.append("demo", payload(`event-${i}`));

    const result = await readAll(store, "demo", 0);
    expect(result.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(result.lastSeq).toBe(5);
    const raw = await readFile(coverageEventsPath(dataDir, "demo"), "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coverage inbox for "demo"'));
  });

  test("an append after a crashed partial write starts on a fresh line", async () => {
    const first = createFileCoverageEventStore(dataDir);
    await first.append("demo", payload("one"));
    await appendFile(coverageEventsPath(dataDir, "demo"), '{"seq":2,"at":123,"pay');

    // A fresh store, as after a crash — the state must notice the missing
    // trailing newline, or the next append welds itself onto the fragment.
    const second = createFileCoverageEventStore(dataDir);
    const stamp = await second.append("demo", payload("two"));
    expect(stamp.seq).toBe(2);

    const result = await readAll(second, "demo", 0);
    expect(texts(result.entries)).toEqual(["one", "two"]);
    expect(result.skipped).toBe(1);
  });

  test("read prunes an idle stream and never serves events past retention", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    const store = createFileCoverageEventStore(dataDir);
    await store.append("demo", payload("old-1"));
    await store.append("demo", payload("old-2"));

    // Inside the prune's hour of slack: the file still holds the events,
    // but the read already withholds them.
    now.mockReturnValue(base + COVERAGE_RETENTION_DAYS * DAY_MS + 30 * 60 * 1000);
    const withheld = await readAll(store, "demo", 0);
    expect(withheld.entries).toEqual([]);
    expect(withheld.lastSeq).toBe(2);

    // Past the slack, the read itself rewrites the file — no append needed.
    now.mockReturnValue(base + (COVERAGE_RETENTION_DAYS + 1) * DAY_MS);
    const pruned = await readAll(store, "demo", 0);
    expect(pruned.entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 2 events"));
    expect(await readFile(coverageEventsPath(dataDir, "demo"), "utf8")).toBe("");
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

    const result = await readAll(store, "demo", 0);
    expect(texts(result.entries)).toEqual(["fresh"]);
    expect(result.entries.map((e) => e.seq)).toEqual([3]);
    expect(result.lastSeq).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 2 events"));
  });
});
