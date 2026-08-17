import { describe, expect, test } from "vitest";

import { ACTOR_WINDOW_TOLERANCE_MS } from "./actors.ts";
import { CoverageResolver, type CoverageEvent, type CoveragePush } from "./resolver.ts";

/**
 * The resolver alone, on synthetic event streams with hand-picked stamps.
 * The transport (HTTP, real clocks) is exercised by sink.test.ts; here every
 * timestamp is chosen, which is what makes the boundary cases assertable.
 */

const SPEC = "run-1.feat/spec-a";
const KEY = "demo:${USER}";
const TAG = "demo:U1";

function push(overrides: Partial<CoveragePush> & Pick<CoveragePush, "pid" | "startedAt">): CoveragePush {
  return {
    protocol: 1,
    unattributed: 0,
    specs: {},
    boot: [],
    uninstrumentedFiles: 0,
    uninstrumentedProcess: false,
    droppedPushes: 0,
    actors: [],
    ...overrides,
  };
}

function pushed(at: number, overrides: Partial<CoveragePush> & Pick<CoveragePush, "pid" | "startedAt">): CoverageEvent {
  return { kind: "push", at, push: push(overrides) };
}

function resolver(tagToKey: ReadonlyMap<string, string> = new Map([[TAG, KEY]])): CoverageResolver {
  return new CoverageResolver(new Set([SPEC]), tagToKey);
}

describe("CoverageResolver", () => {
  test("gates pushes on the issued spec ids, and counts what it refused", () => {
    const r = resolver();
    r.apply(pushed(1_000, { pid: 1, startedAt: 1, specs: { [SPEC]: ["src/a.ts"] } }));
    r.apply(pushed(2_000, { pid: 1, startedAt: 1, specs: { "other.feat/spec-x": ["src/x.ts"] } }));
    expect(r.filesFor(SPEC)).toEqual(new Set(["src/a.ts"]));
    expect(r.filesFor("other.feat/spec-x")).toBeUndefined();
    expect(r.rejectedPushes()).toBe(1);
  });

  test("baselines a process's running total at the spec's first sighting", () => {
    const r = resolver();
    // Process 1 arrives already carrying 5 gaps, then adds 4 while the spec is
    // open; process 2 arrives carrying 3 and adds nothing. Only the 4 count.
    r.apply(pushed(1_000, { pid: 1, startedAt: 1, unattributed: 5 }));
    r.apply(pushed(2_000, { pid: 1, startedAt: 1, unattributed: 7, specs: { [SPEC]: ["src/a.ts"] } }));
    r.apply(pushed(3_000, { pid: 1, startedAt: 1, unattributed: 9, specs: { [SPEC]: ["src/a.ts"] } }));
    r.apply(pushed(4_000, { pid: 2, startedAt: 2, unattributed: 3, specs: { [SPEC]: ["src/b.ts"] } }));
    expect(r.unattributedFor(SPEC)).toBe(4);
  });

  test("a window's opening edge reaches exactly the tolerance backwards", () => {
    const r = resolver();
    r.apply({ kind: "window-open", at: 10_000, tag: TAG, key: KEY, specId: SPEC });
    const inside = 10_000 - ACTOR_WINDOW_TOLERANCE_MS;
    r.apply(
      pushed(11_000, {
        pid: 1,
        startedAt: 1,
        actors: [
          { tag: TAG, at: inside, files: ["src/a.ts"] },
          { tag: TAG, at: inside - 1, files: ["src/b.ts"] },
        ],
      }),
    );
    expect(r.filesFor(SPEC)).toEqual(new Set(["src/a.ts"]));
    expect(r.actorEventsFor(SPEC).get(KEY)).toBe(1);
    expect(r.outsideWindowEvents().get(KEY)).toBe(1);
  });

  test("an event past the closing edge and its tolerance belongs to nobody", () => {
    const r = resolver();
    r.apply({ kind: "window-open", at: 10_000, tag: TAG, key: KEY, specId: SPEC });
    r.apply({ kind: "window-close", at: 20_000, tag: TAG });
    const late = 20_000 + ACTOR_WINDOW_TOLERANCE_MS + 1;
    r.apply(pushed(21_000, { pid: 1, startedAt: 1, actors: [{ tag: TAG, at: late, files: ["src/a.ts"] }] }));
    expect(r.filesFor(SPEC)).toBeUndefined();
    expect(r.outsideWindowEvents().get(KEY)).toBe(1);
    expect(r.lastClosedAt(TAG)).toBe(20_000);
  });

  test("an identity the project never declared is counted, never named", () => {
    const r = resolver(new Map());
    r.apply(pushed(11_000, { pid: 1, startedAt: 1, actors: [{ tag: "demo:U9", at: 10_500, files: ["src/x.ts"] }] }));
    expect(r.filesFor(SPEC)).toBeUndefined();
    expect(r.unmappedActorEvents()).toBe(1);
    expect(JSON.stringify([...r.outsideWindowEvents()])).not.toContain("U9");
  });
});
