import { AsyncLocalStorage } from "node:async_hooks";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { installRuntime, type CoverageRuntime, type CoverageStore } from "./core.ts";
import {
  collectorOptionsFromEnv,
  createCollectorState,
  DEFAULT_ENDPOINT,
  diff,
  evict,
  startCollector,
  type CollectorState,
  type CoveragePush,
} from "./collector.ts";
import { ENV_HEADER } from "./wire.ts";

const RUNTIME_KEY = Symbol.for("ccqa.coverage.runtime");

/** installRuntime() is a process-wide singleton; each test needs a clean slate. */
beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
  delete (globalThis as Record<string, unknown>).__ccqaCoverage;
});

function install(): CoverageRuntime {
  return installRuntime(new AsyncLocalStorage<CoverageStore>());
}

/** What startCollector's success handler does: ack everything diff() just returned. */
function ack(state: CollectorState, payload: CoveragePush): void {
  for (const [specId, files] of Object.entries(payload.specs)) {
    const acked = state.sent.get(specId) ?? new Set<string>();
    for (const file of files) acked.add(file);
    state.sent.set(specId, acked);
  }
  for (const file of payload.boot) state.sentBoot.add(file);
  state.lastSentUnattributed = payload.unattributed;
  state.lastSentUninstrumentedFiles = payload.uninstrumentedFiles;
  state.lastSentUninstrumentedProcess = payload.uninstrumentedProcess;
}

describe("diff", () => {
  it("pushes a process that instrumented nothing, which has nothing else to send", () => {
    // No files, no boot set, and `record` never ran so `unattributed` is 0.
    // Gating the push on those alone left this process unable to report the
    // one thing it knows: that everything it ran went unmeasured.
    const runtime = install();
    runtime.uninstrumentedProcess = true;
    const state = createCollectorState();

    const first = diff(runtime, state);
    expect(first?.uninstrumentedProcess).toBe(true);
    ack(state, first!);
    expect(diff(runtime, state)).toBeUndefined();
  });

  it("pushes on an unattributed change alone, once file sets have converged", () => {
    const runtime = install();
    runtime.buckets.set("run1.spec-a", new Set(["src/a.ts"]));
    const state = createCollectorState();

    ack(state, diff(runtime, state)!);
    expect(diff(runtime, state)).toBeUndefined();

    runtime.unattributed++;
    const heartbeat = diff(runtime, state);
    expect(heartbeat?.unattributed).toBe(1);
    expect(heartbeat?.specs).toEqual({});
  });

  it("resends the same delta after a failed push, since nothing was acked", () => {
    const runtime = install();
    runtime.buckets.set("run1.spec-a", new Set(["src/a.ts"]));
    const state = createCollectorState();

    const first = diff(runtime, state);
    const retry = diff(runtime, state);
    expect(retry).toEqual(first);
  });

  it("never resends a file once its spec has acked it", () => {
    const runtime = install();
    const files = new Set(["src/a.ts"]);
    runtime.buckets.set("run1.spec-a", files);
    const state = createCollectorState();

    ack(state, diff(runtime, state)!);
    files.add("src/b.ts");
    const second = diff(runtime, state);

    expect(second?.specs["run1.spec-a"]).toEqual(["src/b.ts"]);
  });
});

describe("evict", () => {
  it("keeps a bucket past its TTL when it still has unacked files", () => {
    const runtime = install();
    runtime.buckets.set("run1.spec-a", new Set(["src/a.ts"]));
    const state = createCollectorState();
    diff(runtime, state); // arms lastChange without acking anything
    state.lastChange.set("run1.spec-a", Date.now() - 1_000_000);

    evict(runtime, state, 120_000);

    expect(runtime.buckets.has("run1.spec-a")).toBe(true);
  });
});

describe("exit flush", () => {
  it("gives up once a push fails, so a process with no sink can still exit", async () => {
    // `beforeExit` fires again whenever its listener leaves async work behind,
    // and a failed push acks nothing — so retrying the same delta there keeps
    // the loop alive forever and the process never exits.
    const runtime = install();
    runtime.buckets.set("run1.spec-a", new Set(["src/a.ts"]));
    let attempts = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => {
        attempts++;
        return Promise.reject(new Error("ECONNREFUSED"));
      });
    const before = process.listeners("beforeExit").length;
    const stop = startCollector({ endpoint: "http://127.0.0.1:1/", intervalMs: 3_600_000 });
    const onBeforeExit = process.listeners("beforeExit")[before] as () => Promise<void>;

    for (let i = 0; i < 5; i++) await onBeforeExit();

    stop();
    fetchSpy.mockRestore();
    expect(attempts).toBe(1);
  });
});

describe("collectorOptionsFromEnv", () => {
  it("defaults the endpoint to the loopback inbox when none is set", () => {
    expect(collectorOptionsFromEnv({}).endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it("parses the extra header on the first colon, trimming both sides", () => {
    const options = collectorOptionsFromEnv({ [ENV_HEADER]: " x-gate : a:b " });
    expect(options.header).toEqual({ name: "x-gate", value: "a:b" });
  });

  it("warns about a header with no name instead of dropping it silently", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const options = collectorOptionsFromEnv({ [ENV_HEADER]: ":secret" });

    expect(options.header).toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
    write.mockRestore();
  });
});

describe("push", () => {
  it("sends the configured extra header alongside the token", async () => {
    const runtime = install();
    runtime.buckets.set("run1.spec-a", new Set(["src/a.ts"]));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const before = process.listeners("beforeExit").length;
    const stop = startCollector({
      endpoint: "http://127.0.0.1:1/",
      token: "tok",
      header: { name: "x-gate", value: "open" },
      intervalMs: 3_600_000,
    });
    const onBeforeExit = process.listeners("beforeExit")[before] as () => Promise<void>;

    await onBeforeExit();

    stop();
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    fetchSpy.mockRestore();
    expect(headers["x-gate"]).toBe("open");
    expect(headers.authorization).toBe("Bearer tok");
  });
});

describe("blind process", () => {
  it("re-announces itself, so a later run is not told nothing reported", () => {
    // It has no files and no attributions, so its delta is empty forever after
    // the first success — and the run that heard it is already over.
    const runtime = install();
    runtime.uninstrumentedProcess = true;
    const state = createCollectorState();

    ack(state, diff(runtime, state)!);
    expect(diff(runtime, state)).toBeUndefined();

    state.lastSentAt -= 60_000;
    expect(diff(runtime, state)?.uninstrumentedProcess).toBe(true);
  });
});
