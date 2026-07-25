import { describe, expect, test } from "vitest";
import type { DeployEntry, DeployInput, DeployLog } from "../contract/schema.ts";
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

  test("changedPaths beyond the retained bound are cut and the entry is marked truncated", () => {
    const paths = Array.from({ length: MAX_RETAINED_CHANGED_PATHS + 5 }, (_, i) => `src/f${i}.ts`);
    const entry = appendOne(null, { changedPaths: paths });
    expect(entry.truncated).toBe(true);
    expect(entry.changedPaths).toHaveLength(MAX_RETAINED_CHANGED_PATHS);

    // Exactly at the bound nothing is lost.
    expect(appendOne(null, { changedPaths: paths.slice(0, MAX_RETAINED_CHANGED_PATHS) }).truncated).toBe(false);
  });

  test("a deploy that reported no paths is stored as null, not as an empty change set", () => {
    const entry = appendOne(null, { changedPaths: null });
    expect(entry.changedPaths).toBeNull();
    expect(entry.truncated).toBe(false);
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

  test("records the deploy for specs whose relatedPaths match, with a sample of what matched", () => {
    const index = foldTouchIndex({}, entry, ["src/a.ts", "docs/x.md"], [
      { key: "f/hit", relatedPaths: ["src/**"] },
      { key: "f/miss", relatedPaths: ["lib/**"] },
    ]);
    expect(index["f/hit"]).toEqual({
      lastTouchedIndex: 0,
      lastTouchedSha: "sha-a",
      lastTouchedAt: entry.at,
      matchedPaths: ["src/a.ts"],
    });
    expect(index["f/miss"]).toBeUndefined();
  });

  test("a deploy that reported no paths touches every scoped spec, and no unscoped one", () => {
    const index = foldTouchIndex({}, entry, null, [
      { key: "f/scoped", relatedPaths: ["lib/**"] },
      { key: "f/unscoped", relatedPaths: [] },
    ]);
    expect(index["f/scoped"]?.matchedPaths).toEqual([]);
    // An unscoped spec is `unknown`, so recording a touch would dress that up
    // as a definite answer.
    expect(index["f/unscoped"]).toBeUndefined();
  });

  test("the matched sample is bounded", () => {
    const many = Array.from({ length: MAX_TOUCHED_BY + 5 }, (_, i) => `src/f${i}.ts`);
    const index = foldTouchIndex({}, entry, many, [{ key: "f/s", relatedPaths: ["src/**"] }]);
    expect(index["f/s"]?.matchedPaths).toHaveLength(MAX_TOUCHED_BY);
  });

  test("a later deploy overwrites an earlier touch, and untouched specs keep theirs", () => {
    const targets = [
      { key: "f/a", relatedPaths: ["src/**"] },
      { key: "f/b", relatedPaths: ["lib/**"] },
    ];
    const first = foldTouchIndex({}, entry, ["src/a.ts"], targets);
    const second = appendOne({ nextIndex: 1, entries: [] }, { sha: "sha-b", changedPaths: ["lib/b.ts"] });
    const merged = foldTouchIndex(first, second, ["lib/b.ts"], targets);
    expect(merged["f/a"]?.lastTouchedSha).toBe("sha-a");
    expect(merged["f/b"]?.lastTouchedSha).toBe("sha-b");
  });
});
