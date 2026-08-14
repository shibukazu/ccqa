import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CdpTransport, EventHandler } from "./cdp.ts";
import { startBrowserCoverage, type BrowserCoverageHandle } from "./engine.ts";

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

  onClose(): void {}
  close(): void {}

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
