import { describe, expect, test } from "vitest";
import type { DeployEntry, DeployInput, DeployLog, SpecTouchIndex } from "../contract/schema.ts";
import {
  appendDeploy,
  foldTouchIndex,
  MAX_RETAINED_CHANGED_PATHS,
  MAX_RETAINED_DEPLOYS,
  MAX_TOUCHED_BY,
} from "./deploy-log.ts";

function input(overrides: Partial<DeployInput> = {}): DeployInput {
  return {
    sha: "sha-1",
    previousSha: null,
    at: "2026-07-25T00:00:00Z",
    changedPaths: ["src/a.ts"],
    hasSelection: false,
    ...overrides,
  };
}

function appendOne(current: DeployLog | null, overrides: Partial<DeployInput> = {}): DeployEntry {
  const log = appendDeploy(current, input(overrides));
  return log.entries[log.entries.length - 1]!;
}

/** Append `count` chained deploys, so every entry but the first has a verified predecessor. */
function chain(count: number): DeployLog {
  let log: DeployLog = { nextIndex: 0, entries: [] };
  for (let i = 0; i < count; i++) {
    log = appendDeploy(log, input({ sha: `sha-${i}`, previousSha: i === 0 ? null : `sha-${i - 1}` }));
  }
  return log;
}

describe("appendDeploy", () => {
  test("positions are monotonic and the first entry is not a gap", () => {
    const log = chain(3);
    expect(log.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(log.entries.map((e) => e.gapBefore)).toEqual([false, false, false]);
    expect(log.nextIndex).toBe(3);
  });

  test("a previousSha that does not chain onto the head records a gap", () => {
    const chained = chain(2);
    expect(appendOne(chained, { sha: "sha-9", previousSha: "sha-unrelated" }).gapBefore).toBe(true);
    // An omitted previousSha cannot be verified either, so it is also a gap.
    expect(appendOne(chained, { sha: "sha-9", previousSha: null }).gapBefore).toBe(true);
  });

  test("changedPaths beyond the retained bound are cut to the bound", () => {
    const paths = Array.from({ length: MAX_RETAINED_CHANGED_PATHS + 5 }, (_, i) => `src/f${i}.ts`);
    const entry = appendOne(null, { changedPaths: paths });
    expect(entry.changedPaths).toHaveLength(MAX_RETAINED_CHANGED_PATHS);

    // Exactly at the bound nothing is lost.
    const atBound = appendOne(null, { changedPaths: paths.slice(0, MAX_RETAINED_CHANGED_PATHS) });
    expect(atBound.changedPaths).toHaveLength(MAX_RETAINED_CHANGED_PATHS);
  });

  test("a deploy that reported no paths is stored as null, not as an empty change set", () => {
    const entry = appendOne(null, { changedPaths: null });
    expect(entry.changedPaths).toBeNull();
  });

  test("the ring buffer evicts the oldest entries and leaves a synthetic gap at the boundary", () => {
    const full = chain(MAX_RETAINED_DEPLOYS);
    expect(full.entries[0]?.gapBefore).toBe(false);

    const log = appendDeploy(
      full,
      input({ sha: "sha-new", previousSha: `sha-${MAX_RETAINED_DEPLOYS - 1}` }),
    );
    expect(log.entries).toHaveLength(MAX_RETAINED_DEPLOYS);
    // Positions keep increasing across an eviction, so a stored baseline can
    // never silently re-match a different deploy.
    expect(log.entries[0]?.index).toBe(1);
    expect(log.entries[0]?.gapBefore).toBe(true);
    expect(log.entries[MAX_RETAINED_DEPLOYS - 1]).toMatchObject({
      index: MAX_RETAINED_DEPLOYS,
      gapBefore: false,
    });
  });
});

describe("foldTouchIndex", () => {
  const entry = appendOne(null, { sha: "sha-a", changedPaths: ["src/a.ts", "docs/x.md"] });

  test("needed records the deploy's position with a sample of touchedBy", () => {
    const index = foldTouchIndex({}, entry, {
      "f/hit": { verdict: "needed", reason: "matched", touchedBy: ["src/a.ts"] },
    });
    expect(index["f/hit"]).toEqual({
      needed: { index: 0, sha: "sha-a", at: entry.at, matchedPaths: ["src/a.ts"] },
    });
  });

  test("the matched sample is bounded", () => {
    const many = Array.from({ length: MAX_TOUCHED_BY + 5 }, (_, i) => `src/f${i}.ts`);
    const index = foldTouchIndex({}, entry, { "f/s": { verdict: "needed", reason: "many", touchedBy: many } });
    expect(index["f/s"]?.needed?.matchedPaths).toHaveLength(MAX_TOUCHED_BY);
  });

  test("notNeeded writes nothing, leaving an existing entry untouched", () => {
    const withNeeded: SpecTouchIndex = {
      "f/s": { needed: { index: 0, sha: "sha-a", at: entry.at, matchedPaths: ["src/a.ts"] } },
    };
    const index = foldTouchIndex(withNeeded, entry, { "f/s": { verdict: "notNeeded", reason: "no match" } });
    expect(index["f/s"]).toBe(withNeeded["f/s"]);
    // Same for a spec with no prior entry: nothing is created.
    expect(foldTouchIndex({}, entry, { "f/new": { verdict: "notNeeded", reason: "no match" } })["f/new"]).toBeUndefined();
  });

  test("unknown sets undecidedIndex without disturbing an existing needed", () => {
    const withNeeded: SpecTouchIndex = {
      "f/s": { needed: { index: 0, sha: "sha-a", at: entry.at, matchedPaths: ["src/a.ts"] } },
    };
    const later = appendOne({ nextIndex: 1, entries: [entry] }, { sha: "sha-b" });
    const index = foldTouchIndex(withNeeded, later, { "f/s": { verdict: "unknown", reason: "could not tell" } });
    expect(index["f/s"]).toEqual({
      needed: { index: 0, sha: "sha-a", at: entry.at, matchedPaths: ["src/a.ts"] },
      undecidedIndex: 1,
    });
  });

  test("positions only advance: needed at #7 survives notNeeded at #9", () => {
    const e7: DeployEntry = { ...entry, index: 7, sha: "sha-7" };
    const e9: DeployEntry = { ...entry, index: 9, sha: "sha-9" };
    const afterNeeded = foldTouchIndex({}, e7, { "f/s": { verdict: "needed", reason: "x", touchedBy: ["src/a.ts"] } });
    const afterNotNeeded = foldTouchIndex(afterNeeded, e9, { "f/s": { verdict: "notNeeded", reason: "y" } });
    expect(afterNotNeeded["f/s"]?.needed?.index).toBe(7);
  });
});
