import { afterEach, describe, expect, test } from "vitest";
import { ACTOR_WINDOW_TOLERANCE_MS, type ActorWindow } from "./actors.ts";
import { CoverageSink } from "./sink.ts";

let sink: CoverageSink | undefined;

afterEach(async () => {
  await sink?.close();
  sink = undefined;
});

interface Push {
  protocol: 1;
  pid: number;
  startedAt: number;
  unattributed: number;
  specs: Record<string, string[]>;
  boot: string[];
  uninstrumentedFiles?: number;
  uninstrumentedProcess?: boolean;
  droppedPushes?: number;
  actors?: Array<{ tag: string; at: number; files: string[] }>;
}

function push(overrides: Partial<Push> & Pick<Push, "pid" | "startedAt">): Push {
  return { protocol: 1, unattributed: 0, specs: {}, boot: [], ...overrides };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}

const SPEC = "run-1.feat/spec-a";

describe("CoverageSink", () => {
  test("unions pushes to a known spec id across processes", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    await post(sink.url, push({ pid: 1, startedAt: 1000, specs: { [SPEC]: ["src/a.ts"] } }));
    await post(sink.url, push({ pid: 2, startedAt: 2000, specs: { [SPEC]: ["src/b.ts"] } }));
    expect(sink.filesFor(SPEC)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  test("drops a push naming a spec id this run never issued, and counts it as rejected", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    await post(sink.url, push({ pid: 1, startedAt: 1000, specs: { "other.feat/spec-x": ["src/x.ts"] } }));
    expect(sink.filesFor("other.feat/spec-x")).toBeUndefined();
    expect(sink.rejectedPushes()).toBe(1);
  });

  test("counts a push it cannot read, so a wire-format drift is not silence", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    await post(sink.url, { protocol: 2, pid: 1 });
    expect(sink.malformedPushes()).toBe(1);
  });

  test("attributes only what a process counted while the spec was open", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    // The push carries a process-wide running total, and the process outlives
    // the run: neither the 5 gaps counted before this spec opened nor the 3 a
    // second process arrived already carrying may land on it. Only the 4 the
    // first process added afterwards belong here.
    await post(sink.url, push({ pid: 1, startedAt: 1000, unattributed: 5, boot: ["src/boot.ts"] }));
    const specs = { [SPEC]: ["src/a.ts"] };
    await post(sink.url, push({ pid: 1, startedAt: 1000, unattributed: 7, specs }));
    await post(sink.url, push({ pid: 1, startedAt: 1000, unattributed: 9, specs }));
    await post(sink.url, push({ pid: 2, startedAt: 2000, unattributed: 3, specs }));
    expect(sink.unattributedFor(SPEC)).toBe(4);
  });

  test("counts only what a process dropped once this run's sink was up", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    // The application has been pushing into nothing since long before the run
    // and arrives carrying 1400 failures no sink existed to receive. Only the
    // 2 after that happened while there was one to miss.
    await post(sink.url, push({ pid: 1, startedAt: 1000, droppedPushes: 1400 }));
    await post(sink.url, push({ pid: 1, startedAt: 1000, droppedPushes: 1402 }));
    expect(sink.droppedPushes()).toBe(2);
  });

  test("keeps a process that instrumented nothing apart from a count of files", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    // Two processes rewrote nothing at all — every file they ran is missing.
    // Folded into the file count that whole failure would read as "3 files".
    await post(sink.url, push({ pid: 1, startedAt: 1000, uninstrumentedProcess: true }));
    await post(sink.url, push({ pid: 2, startedAt: 2000, uninstrumentedProcess: true }));
    await post(sink.url, push({ pid: 3, startedAt: 3000, uninstrumentedFiles: 3 }));
    expect(sink.uninstrumentedProcesses()).toBe(2);
    expect(sink.uninstrumentedFiles()).toBe(3);
  });

  test("credits an identity's work to whoever held its turn at the time", async () => {
    const window: ActorWindow = { key: "demo:${USER}", tag: "demo:U1", specs: [SPEC] };
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]), new Map([[window.tag, window.key]]));
    sink.openWindow(window, SPEC);
    const at = Date.now();
    // Two pushes of one request as it reaches more files: one event, not two.
    await post(sink.url, push({ pid: 1, startedAt: 1, actors: [{ tag: window.tag, at, files: ["src/a.ts"] }] }));
    await post(sink.url, push({ pid: 1, startedAt: 1, actors: [{ tag: window.tag, at, files: ["src/b.ts"] }] }));
    expect(sink.filesFor(SPEC)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    expect(sink.actorEventsFor(SPEC).get(window.key)).toBe(1);
  });

  test("an event after the turn closed belongs to nobody, and says so", async () => {
    const window: ActorWindow = { key: "demo:${USER}", tag: "demo:U1", specs: [SPEC] };
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]), new Map([[window.tag, window.key]]));
    sink.openWindow(window, SPEC);
    sink.closeWindow(window.tag);
    // Past the tolerance the closing edge allows for the two clocks involved.
    const at = Date.now() + ACTOR_WINDOW_TOLERANCE_MS + 1_000;
    await post(sink.url, push({ pid: 1, startedAt: 1, actors: [{ tag: window.tag, at, files: ["src/a.ts"] }] }));
    expect(sink.filesFor(SPEC)).toBeUndefined();
    expect(sink.outsideWindowEvents().get(window.key)).toBe(1);
  });

  test("an identity the project never declared is counted, never named", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]), new Map());
    // Somebody else on a shared environment. Their reach goes nowhere and their
    // identity is dropped rather than recorded.
    await post(sink.url, push({ pid: 1, startedAt: 1, actors: [{ tag: "demo:U9", at: 5, files: ["src/x.ts"] }] }));
    expect(sink.filesFor(SPEC)).toBeUndefined();
    expect(sink.unmappedActorEvents()).toBe(1);
    expect(JSON.stringify([...sink.outsideWindowEvents()])).not.toContain("U9");
  });

  test("boot files land in boot() rather than any spec bucket", async () => {
    sink = await CoverageSink.start("127.0.0.1", 0, new Set([SPEC]));
    await post(sink.url, push({ pid: 1, startedAt: 1000, boot: ["src/boot.ts"] }));
    expect(sink.boot()).toEqual(new Set(["src/boot.ts"]));
    expect(sink.filesFor(SPEC)).toBeUndefined();
    // The same push satisfies "an application reported" while attributing
    // nothing — which is what a spec cookie that never arrives looks like.
    expect(sink.heardFromApplication()).toBe(true);
    expect(sink.attributedSpecs()).toBe(0);
  });
});
