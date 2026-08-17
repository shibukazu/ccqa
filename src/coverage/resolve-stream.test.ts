import { describe, expect, test } from "vitest";

import type { StoredEvent } from "./events.ts";
import type { CoveragePush } from "./resolver.ts";
import { GRACE_MS, listRunIds, resolveStream } from "./resolve-stream.ts";

/**
 * The stream interpretation alone, on synthetic stored events with hand-picked
 * stamps — the same stance as resolver.test.ts, one level up: what separates
 * one run's view from another's inside a single interleaved stream.
 */

const RUN_A = "run-a";
const RUN_B = "run-b";
const SPEC_A = `${RUN_A}.feat/spec-a`;
const SPEC_B = `${RUN_B}.feat/spec-b`;

function stream(...bodies: [number, StoredEvent["body"]][]): StoredEvent[] {
  return bodies.map(([at, body], i) => ({ seq: i + 1, at, body }));
}

function push(at: number, overrides: Partial<CoveragePush>): [number, CoveragePush] {
  return [
    at,
    {
      protocol: 1,
      pid: 1,
      startedAt: 1,
      unattributed: 0,
      specs: {},
      boot: [],
      uninstrumentedFiles: 0,
      uninstrumentedProcess: false,
      droppedPushes: 0,
      actors: [],
      ...overrides,
    },
  ];
}

describe("resolveStream", () => {
  test("two interleaved runs each keep only the pushes their markers bound", () => {
    const events = stream(
      [1_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
      push(3_000, { specs: { [SPEC_A]: ["src/a.ts"] } }),
      [5_000, { kind: "spec-close", runId: RUN_A, specId: SPEC_A }],
      [100_000, { kind: "spec-open", runId: RUN_B, specId: SPEC_B }],
      // Arrives during B's span carrying A's id — a stale cookie. It is
      // outside A's span (so A never sees it) and not issued by B (rejected).
      push(101_000, { specs: { [SPEC_A]: ["src/late.ts"], [SPEC_B]: ["src/b.ts"] } }),
      [102_000, { kind: "spec-close", runId: RUN_B, specId: SPEC_B }],
    );

    const a = resolveStream(events, RUN_A);
    expect(a.specs).toEqual([{ specId: SPEC_A, files: ["src/a.ts"], actorEvents: {} }]);
    expect(a.health.rejectedPushes).toBe(0);
    expect(a.health.pushesDuringRun).toBe(1);
    expect(a.asOf).toBe(5_000);

    const b = resolveStream(events, RUN_B);
    expect(b.specs).toEqual([{ specId: SPEC_B, files: ["src/b.ts"], actorEvents: {} }]);
    expect(b.health.rejectedPushes).toBe(1);
    expect(b.health.pushesDuringRun).toBe(1);
    expect(b.lastSeq).toBe(6);
  });

  test("a push acked before the run began still supplies boot and process health", () => {
    // An always-on collector never re-sends what an earlier run acked, so on
    // a long-lived hub the boot set and health figures predate every run.
    const events = stream(
      push(100, {
        boot: ["src/boot.ts"],
        specs: { [SPEC_A]: ["src/stale.ts"] },
        uninstrumentedProcess: true,
      }),
      [50_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
      [51_000, { kind: "spec-close", runId: RUN_A, specId: SPEC_A }],
    );
    const resolved = resolveStream(events, RUN_A);
    expect(resolved.boot).toEqual(["src/boot.ts"]);
    expect(resolved.health.heardFromApplication).toBe(true);
    expect(resolved.health.uninstrumentedProcesses).toBe(1);
    // The attribution half was another run's audience: stripped, not claimed.
    expect(resolved.specs[0]?.files).toEqual([]);
    expect(resolved.health.rejectedPushes).toBe(0);
    expect(resolved.health.pushesDuringRun).toBe(0);
    expect(resolved.asOf).toBe(51_000);
  });

  test("a late push lands inside the grace and not one tick past it", () => {
    const base = stream(
      [1_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
      [5_000, { kind: "spec-close", runId: RUN_A, specId: SPEC_A }],
      push(5_000 + GRACE_MS, { specs: { [SPEC_A]: ["src/tail.ts"] } }),
      push(5_000 + GRACE_MS + 1, { specs: { [SPEC_A]: ["src/next.ts"] } }),
    );
    const resolved = resolveStream(base, RUN_A);
    expect(resolved.specs[0]?.files).toEqual(["src/tail.ts"]);
    expect(resolved.asOf).toBe(5_000 + GRACE_MS);
  });

  test("a spec's files are the union of its server and browser halves", () => {
    const resolved = resolveStream(
      stream(
        [1_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
        push(2_000, { specs: { [SPEC_A]: ["src/b.ts", "src/a.ts"] }, boot: ["src/boot.ts"] }),
        [3_000, { kind: "browser", runId: RUN_A, specId: SPEC_A, files: ["src/web.ts", "src/a.ts"] }],
        [4_000, { kind: "spec-close", runId: RUN_A, specId: SPEC_A }],
      ),
      RUN_A,
    );
    expect(resolved.specs[0]?.files).toEqual(["src/a.ts", "src/b.ts", "src/web.ts"]);
    expect(resolved.boot).toEqual(["src/boot.ts"]);
    expect(resolved.health.heardFromApplication).toBe(true);
    expect(resolved.health.specsMeasured).toBe(1);
  });

  test("the universe rides the run's own event, not another run's", () => {
    const events = stream(
      [500, { kind: "universe", runId: RUN_B, include: ["other/**"], files: ["other/x.ts"] }],
      [1_000, { kind: "universe", runId: RUN_A, include: ["src/**"], files: ["src/a.ts", "src/b.ts"] }],
      [2_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
    );
    expect(resolveStream(events, RUN_A).universe).toEqual({
      include: ["src/**"],
      files: ["src/a.ts", "src/b.ts"],
    });
    expect(resolveStream(stream([1_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }]), RUN_A).universe).toBeUndefined();
  });

  test("actor events join on the windows the run's markers describe", () => {
    const key = "demo:${USER}";
    const tag = "demo:U1";
    const resolved = resolveStream(
      stream(
        [1_000, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
        [1_100, { kind: "window-open", runId: RUN_A, tag, key, specId: SPEC_A }],
        push(2_000, {
          actors: [
            { tag, at: 1_500, files: ["src/hook.ts"] },
            // Well before the window opened: a declared identity acting
            // outside every turn it was given — counted, not attributed.
            { tag, at: -10_000, files: ["src/other.ts"] },
          ],
        }),
        [3_000, { kind: "window-close", runId: RUN_A, tag }],
        [3_100, { kind: "spec-close", runId: RUN_A, specId: SPEC_A }],
      ),
      RUN_A,
    );
    expect(resolved.specs[0]?.files).toEqual(["src/hook.ts"]);
    expect(resolved.specs[0]?.actorEvents).toEqual({ [key]: 1 });
    expect(resolved.health.outsideWindowEvents).toEqual({ [key]: 1 });
  });

  test("a run-link ties the answer to its hub run record, per run", () => {
    const events = stream(
      [1, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
      [2, { kind: "run-link", runId: RUN_A, hubRunId: "hub-record-a" }],
      [3, { kind: "spec-open", runId: RUN_B, specId: SPEC_B }],
    );
    expect(resolveStream(events, RUN_A).hubRunId).toBe("hub-record-a");
    expect(resolveStream(events, RUN_B).hubRunId).toBeUndefined();
  });
});

describe("listRunIds", () => {
  test("most recently heard-from first, one entry per run", () => {
    const events = stream(
      [1, { kind: "spec-open", runId: RUN_A, specId: SPEC_A }],
      [2, { kind: "spec-open", runId: RUN_B, specId: SPEC_B }],
      [3, { kind: "spec-open", runId: RUN_A, specId: `${RUN_A}.feat/spec-c` }],
      // Non-open markers do not move a run up: opening is what "measuring" means.
      [4, { kind: "spec-close", runId: RUN_B, specId: SPEC_B }],
    );
    expect(listRunIds(events)).toEqual([RUN_A, RUN_B]);
    expect(listRunIds([])).toEqual([]);
  });
});
