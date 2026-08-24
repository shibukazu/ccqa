import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CdpTransport, EventHandler } from "./cdp.ts";
import { assetPathOf, startBrowserCoverage, type BrowserCoverageHandle } from "./engine.ts";

/**
 * The engine's state machine against a scripted transport — the paths the
 * real-browser e2e cannot exercise on CI, and the ones a wrong answer turns
 * into a hang or a silently smaller file set: the navigation hold and what
 * may clear it, duplicate-session handling, and stop()'s truthfulness.
 */

class FakeTransport implements CdpTransport {
  readonly sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  private readonly handlers = new Map<string, EventHandler[]>();
  /** Coverage entries the next take on any session answers with. */
  takeResult: { url: string; functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[] =
    [];

  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.sent.push({ method, params: params ?? {}, ...(sessionId === undefined ? {} : { sessionId }) });
    if (method === "Target.getTargets") return Promise.resolve({ targetInfos: [] } as T);
    if (method === "Profiler.takePreciseCoverage") {
      return Promise.resolve({ result: this.takeResult } as T);
    }
    return Promise.resolve({} as T);
  }

  on(method: string, handler: EventHandler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  private readonly closeHandlers: ((reason: string) => void)[] = [];

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  closed = false;

  // The real client's close() always ends in drop(); a no-op here would hide
  // every "who closes what after a failure" bug from these tests.
  close(): void {
    this.closed = true;
    this.drop("connection closed");
  }

  /** Simulates the transport dying, as the real client's drop() does. */
  drop(reason: string): void {
    for (const handler of this.closeHandlers.splice(0)) handler(reason);
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  sentTo(method: string, sessionId?: string): number {
    return this.sent.filter((s) => s.method === method && s.sessionId === sessionId).length;
  }
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function armedEngine(fake: FakeTransport): Promise<{
  engine: BrowserCoverageHandle;
  dir: string;
  warnings: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "ccqa-engine-"));
  dirs.push(dir);
  const warnings: string[] = [];
  const engine = await startBrowserCoverage({
    cdpUrl: "ws://127.0.0.1:1/devtools/browser/fake",
    specId: "run1.f/s",
    origins: ["http://127.0.0.1:1"],
    coverageDir: dir,
    roots: { base: dir, root: dir },
    warn: (text) => warnings.push(text),
    connect: async () => fake,
  });
  return { engine, dir, warnings };
}

function attachPage(fake: FakeTransport, sessionId: string, targetId: string): void {
  fake.emit("Target.attachedToTarget", {
    sessionId,
    targetInfo: { targetId, type: "page", url: "about:blank" },
    waitingForDebugger: false,
  });
}

/** Lets the attach handler's fire-and-await batch settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const COVERED = [{ url: "webpack://app/./src/hit.ts", functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }];

describe("engine state machine (scripted transport)", () => {
  it("arms a page once and detaches a duplicate session for the same target", async () => {
    const fake = new FakeTransport();
    const { engine } = await armedEngine(fake);
    attachPage(fake, "S1", "T1");
    attachPage(fake, "S2", "T1");
    await settle();
    expect(fake.sentTo("Profiler.startPreciseCoverage", "S1")).toBe(1);
    expect(fake.sentTo("Profiler.startPreciseCoverage", "S2")).toBe(0);
    expect(fake.sent.some((s) => s.method === "Target.detachFromTarget")).toBe(true);
    await engine.stop();
  });

  it("holds takes while the main frame navigates; a subframe commit does not clear the hold", async () => {
    const fake = new FakeTransport();
    const { engine, dir } = await armedEngine(fake);
    attachPage(fake, "S1", "T1");
    await settle();
    // Main frame learned from its first commit.
    fake.emit("Page.frameNavigated", { frame: { id: "MAIN" } }, "S1");
    fake.emit("Page.frameStartedNavigating", { frameId: "MAIN" }, "S1");
    // A subframe committing must not lift the main frame's hold...
    fake.emit("Page.frameNavigated", { frame: { id: "SUB", parentId: "MAIN" } }, "S1");
    fake.takeResult = COVERED;
    // ...so stop() (which lifts the hold itself, browser about to go) is the
    // first take allowed through.
    await engine.stop();
    const written = JSON.parse(readFileSync(join(dir, "coverage-frontend.json"), "utf8")) as {
      files: string[];
    };
    expect(written.files).toEqual(["src/hit.ts"]);
    // Exactly one take: the final one. None leaked through during the hold.
    expect(fake.sentTo("Profiler.takePreciseCoverage", "S1")).toBe(1);
  });

  it("marks the result stopped when a page never armed", async () => {
    const fake = new FakeTransport();
    // startPreciseCoverage never answers: the page attaches but never arms.
    const original = fake.send.bind(fake);
    fake.send = <T>(method: string, params?: Record<string, unknown>, sessionId?: string) =>
      method === "Profiler.startPreciseCoverage"
        ? new Promise<T>(() => {})
        : original<T>(method, params, sessionId);
    const { engine, dir } = await armedEngine(fake);
    attachPage(fake, "S1", "T1");
    await settle();
    await engine.stop();
    const written = JSON.parse(readFileSync(join(dir, "coverage-frontend.json"), "utf8")) as {
      stopped: boolean;
    };
    expect(written.stopped).toBe(true);
  });

  it("reconnects after a drop, re-arms on the new transport, and keeps the gap marked", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const queue = [first, second];
    const dir = mkdtempSync(join(tmpdir(), "ccqa-engine-"));
    dirs.push(dir);
    const warnings: string[] = [];
    const engine = await startBrowserCoverage({
      cdpUrl: "ws://127.0.0.1:1/devtools/browser/fake",
      specId: "run1.f/s",
      origins: ["http://127.0.0.1:1"],
      coverageDir: dir,
      roots: { base: dir, root: dir },
      warn: (text) => warnings.push(text),
      connect: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("no more transports");
        return next;
      },
    });
    attachPage(first, "S1", "T1");
    await settle();
    first.drop("transport failed: test breakage");
    expect(warnings.some((w) => w.includes("test breakage") && w.includes("reconnecting"))).toBe(true);
    // Past the first backoff step (200ms) the engine must be armed anew.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(second.sentTo("Target.setAutoAttach", undefined)).toBe(1);
    attachPage(second, "S2", "T2");
    await settle();
    expect(second.sentTo("Profiler.startPreciseCoverage", "S2")).toBe(1);
    await engine.stop();
    const written = JSON.parse(readFileSync(join(dir, "coverage-frontend.json"), "utf8")) as {
      stopped: boolean;
    };
    // The reconnect succeeded, but what ran while disconnected is still gone.
    expect(written.stopped).toBe(true);
  });

  it("gives up after the reconnect budget instead of looping on a dead endpoint", async () => {
    const first = new FakeTransport();
    let handed = false;
    const dir = mkdtempSync(join(tmpdir(), "ccqa-engine-"));
    dirs.push(dir);
    const warnings: string[] = [];
    await startBrowserCoverage({
      cdpUrl: "ws://127.0.0.1:1/devtools/browser/fake",
      specId: "run1.f/s",
      origins: ["http://127.0.0.1:1"],
      coverageDir: dir,
      roots: { base: dir, root: dir },
      warn: (text) => warnings.push(text),
      connect: async () => {
        if (handed) throw new Error("endpoint is gone");
        handed = true;
        return first;
      },
    });
    first.drop("transport failed: test breakage");
    // Budget: 200 + 400 + 800 + 1600ms of backoff, then the final refusal.
    await new Promise((resolve) => setTimeout(resolve, 3400));
    expect(warnings.filter((w) => w.includes("reconnecting")).length).toBe(4);
    expect(warnings.some((w) => w.includes("giving up"))).toBe(true);
  }, 10_000);

  it("abandons the engine when the initial arm fails: no reconnect, one transport", async () => {
    const fake = new FakeTransport();
    const original = fake.send.bind(fake);
    fake.send = <T>(method: string, params?: Record<string, unknown>, sessionId?: string) =>
      method === "Target.setAutoAttach"
        ? Promise.reject(new Error("filter not supported"))
        : original<T>(method, params, sessionId);
    const dir = mkdtempSync(join(tmpdir(), "ccqa-engine-"));
    dirs.push(dir);
    const warnings: string[] = [];
    let connects = 0;
    await expect(
      startBrowserCoverage({
        cdpUrl: "ws://127.0.0.1:1/devtools/browser/fake",
        specId: "run1.f/s",
        origins: ["http://127.0.0.1:1"],
        coverageDir: dir,
        roots: { base: dir, root: dir },
        warn: (text) => warnings.push(text),
        connect: async () => {
          connects += 1;
          return fake;
        },
      }),
    ).rejects.toThrow(/filter not supported/);
    // The caller reported coverage unavailable and walked away; a reconnect
    // chain here would warn into a spec that isn't being measured and leak
    // connections.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connects).toBe(1);
    expect(fake.closed).toBe(true);
    expect(warnings.filter((w) => w.includes("reconnecting")).length).toBe(0);
  });

  it("writes nothing but a clean empty result when no page ever attached", async () => {
    const fake = new FakeTransport();
    const { engine, dir } = await armedEngine(fake);
    await engine.stop();
    const written = JSON.parse(readFileSync(join(dir, "coverage-frontend.json"), "utf8")) as {
      files: string[];
      stopped: boolean;
    };
    expect(written).toMatchObject({ files: [], stopped: false });
    expect(existsSync(join(dir, "coverage-frontend.json"))).toBe(true);
  });
});

describe("assetPathOf", () => {
  const origins = ["https://app.test", "https://assets.test/"];

  it("files a script under the path the browser asked for, origin removed", () => {
    expect(assetPathOf("https://app.test/_next/static/chunks/a.js.map", origins)).toBe(
      "_next/static/chunks/a.js.map",
    );
  });

  it("keeps a deploy-scoped prefix, since the push used it too", () => {
    expect(assetPathOf("https://assets.test/assets/9f2c/_next/static/a.js.map", origins)).toBe(
      "assets/9f2c/_next/static/a.js.map",
    );
  });

  it("declines a URL from an origin this run never declared", () => {
    expect(assetPathOf("https://cdn.other.test/_next/static/a.js.map", origins)).toBeUndefined();
  });

  it("declines an origin that only prefixes the host, rather than matching it", () => {
    expect(assetPathOf("https://app.test.evil.test/a.js.map", origins)).toBeUndefined();
  });

  it("drops a cache-busting query, which the push never stored", () => {
    expect(assetPathOf("https://app.test/_next/static/a.js?dpl=abc#x", origins)).toBe("_next/static/a.js");
  });
});
