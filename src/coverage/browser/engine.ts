import { COVERAGE_COOKIE } from "../contract.ts";
import { FrontendResolution, type AcquiredScript } from "../frontend/resolve.ts";
import type { SourceRoots } from "../frontend/source-path.ts";
import type { CoveredRange } from "../frontend/source-map.ts";
import { browserWebSocketUrl, CdpClient, type CdpTransport } from "./cdp.ts";

/**
 * The acquisition half of browser coverage, spoken directly to the browser.
 *
 * Every browser a target drives is a Chromium and answers CDP, so the three
 * things coverage needs from a browser — the spec cookie in every context,
 * V8's counters, and collecting them across navigations — are implemented
 * once here, against the protocol. What stays per-target is only how its
 * `cdpEndpoint` is obtained; see `Target.browserCoverage`.
 *
 * Two facts, both measured rather than read, shaped this file:
 *
 *   - **`callCount: true` is required.** In best-effort mode (`false`) the
 *     counters stop applying to anything the next document runs, silently;
 *     count mode survives navigations from one `start`. Playwright's own
 *     coverage uses count mode for the same reason.
 *   - **The engine must never make the browser wait on this process.** An
 *     early design paused every document request to guarantee the cookie
 *     before it left; a take issued inside that pause never answers. So
 *     nothing here holds a request, takes stand down while a navigation is
 *     in flight (`navigatingSince`), and the cookie is planted at arm time —
 *     before any navigation exists — then re-asserted on every
 *     `frameNavigated` and timer tick. The run process blocking its own loop
 *     (the live runner's synchronous spawns) then costs only take latency:
 *     the browser was measured to navigate freely under an attached client
 *     that reads nothing for seconds.
 *
 * A test process closing its last page is the one moment this design cannot
 * get ahead of. The periodic take bounds that loss to its interval; the live
 * path avoids it entirely by stopping the engine before the session's browser
 * is closed.
 */

export interface BrowserCoverageOptions {
  /** `host:port`, an `http://` endpoint, or a ws URL; see browserWebSocketUrl. */
  cdpUrl: string;
  specId: string;
  /** Absolute http(s) origins the spec cookie is attached for. */
  origins: readonly string[];
  /** Where `coverage-frontend.json` lands. */
  coverageDir: string;
  roots: SourceRoots;
  warn(text: string): void;
  /** Test seam: how the transport is opened. Defaults to the real CDP client. */
  connect?(wsUrl: string): Promise<CdpTransport>;
}

export interface BrowserCoverageHandle {
  /** Final take, flush, disconnect. Safe to call once the driver is done. */
  stop(): Promise<void>;
}

const TAKE_INTERVAL_MS = 400;
/** How long a navigation may hold takes before the guard assumes a lost event. */
const NAVIGATION_GUARD_MS = 5_000;
/** How long `stop()` waits for the final take before declaring the tail lost. */
const STOP_TAKE_TIMEOUT_MS = 2_000;

interface AttachedPage {
  sessionId: string;
  targetId: string;
  /**
   * Set once `startPreciseCoverage` has answered. The periodic timer runs
   * while pages are still arming, and a take against a profiler that has not
   * started is an error at best — the page is skipped until it is ready.
   */
  armed: boolean;
  /**
   * When a document navigation started, and undefined once it committed or
   * stopped. A take sent inside that window wedges — the take never answers
   * and the navigation never commits, each waiting on the other — so takes
   * are held while it is open. Timestamped rather than boolean: a missed
   * commit event would otherwise silence coverage for good, so the guard
   * expires (see NAVIGATION_GUARD_MS).
   */
  navigatingSince: number | undefined;
  /**
   * The main frame's id, learned from its first commit. The Page events above
   * fire for subframes too, and a subframe committing mid-navigation must not
   * clear the main frame's hold — that would re-open the very wedge the hold
   * exists to close.
   */
  mainFrameId: string | undefined;
  /** Serialises takes, so a navigation during a take cannot interleave two. */
  pending: Promise<void>;
}

/** The browser's own chrome. Nothing there is the application under test. */
const INTERNAL_URL = /^(chrome|chrome-untrusted|chrome-extension|devtools):/;

interface ScriptCoverageEntry {
  url: string;
  functions: readonly {
    ranges: readonly { startOffset: number; endOffset: number; count: number }[];
  }[];
}

export async function startBrowserCoverage(
  opts: BrowserCoverageOptions,
): Promise<BrowserCoverageHandle> {
  const connect = opts.connect ?? ((wsUrl: string) => CdpClient.connect(wsUrl));
  const client = await connect(await browserWebSocketUrl(opts.cdpUrl));
  const engine = new Engine(client, opts);
  try {
    await engine.arm();
  } catch (error) {
    client.close();
    throw error;
  }
  return engine;
}

class Engine implements BrowserCoverageHandle {
  private readonly client: CdpTransport;
  private readonly opts: BrowserCoverageOptions;
  private readonly resolution: FrontendResolution;
  private readonly pages = new Map<string, AttachedPage>();
  /**
   * Targets already armed, by target id. Browser-level auto-attach reports
   * existing targets too, so the explicit sweep for them can hand over the
   * same target a second time, and a page armed through two sessions is taken
   * twice for one set of counters.
   */
  private readonly armedTargets = new Set<string>();
  /** Sessions whose take failure was already said; see enqueueTake. */
  private readonly warnedTakeSessions = new Set<string>();
  private readonly cookies: readonly { name: string; value: string; url: string }[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(client: CdpTransport, opts: BrowserCoverageOptions) {
    this.client = client;
    this.opts = opts;
    this.cookies = opts.origins.map((url) => ({
      name: COVERAGE_COOKIE,
      value: opts.specId,
      url,
    }));
    this.resolution = new FrontendResolution({
      specId: opts.specId,
      coverageDir: opts.coverageDir,
      roots: opts.roots,
      fetchText: (url) => this.fetchThroughBrowser(url),
      warn: opts.warn,
    });
  }

  async arm(): Promise<void> {
    this.client.on("Target.attachedToTarget", (params) => {
      void this.onAttached(
        params as unknown as {
          sessionId: string;
          targetInfo: { targetId: string; type: string; url: string };
          waitingForDebugger: boolean;
        },
      );
    });
    this.client.on("Target.detachedFromTarget", (params) => {
      const sessionId = (params as { sessionId?: string }).sessionId;
      if (sessionId === undefined) return;
      const page = this.pages.get(sessionId);
      this.pages.delete(sessionId);
      // A cross-process navigation keeps the target id but replaces the
      // session; freeing the id here is what lets the successor re-arm.
      if (page !== undefined) this.armedTargets.delete(page.targetId);
    });
    // The three Page events fire for subframes too; only the main frame's are
    // navigation state here. Its id is learned from its first commit (the one
    // frame with no parent) — until then, events are taken at face value: a
    // brand-new page has no subframes to confuse them.
    this.client.on("Page.frameStartedNavigating", (params, sessionId) => {
      if (sessionId === undefined) return;
      const page = this.pages.get(sessionId);
      if (page === undefined || !this.isMainFrame(page, (params as { frameId?: string }).frameId)) {
        return;
      }
      page.navigatingSince = Date.now();
    });
    this.client.on("Page.frameNavigated", (params, sessionId) => {
      if (sessionId === undefined) return;
      const page = this.pages.get(sessionId);
      if (page === undefined) return;
      const frame = (params as { frame?: { id?: string; parentId?: string } }).frame;
      if (frame?.parentId !== undefined) return;
      if (frame?.id !== undefined) page.mainFrameId = frame.id;
      page.navigatingSince = undefined;
      // Re-asserted per navigation: a recorded step may clear cookies at any
      // point, and every request after that would silently lose attribution.
      // Event-driven and unawaited — see the module comment for why nothing
      // here may ever hold the browser.
      void this.setCookies(page);
    });
    this.client.on("Page.frameStoppedLoading", (params, sessionId) => {
      // A navigation that never committed (an abort, a download) also ends
      // the hold; without this the guard only recovers by expiry.
      if (sessionId === undefined) return;
      const page = this.pages.get(sessionId);
      if (page === undefined || !this.isMainFrame(page, (params as { frameId?: string }).frameId)) {
        return;
      }
      page.navigatingSince = undefined;
    });
    this.client.onClose(() => {
      // The browser went away with pages still open: whatever ran since the
      // last take was never seen, and the file has to say so.
      if (!this.stopped && this.pages.size > 0) this.resolution.markStopped();
      this.pages.clear();
      if (this.timer !== undefined) clearInterval(this.timer);
    });

    // Attached through tab targets, not pages directly: a tab's auto-attach
    // is what reports the *new* page target a cross-process navigation swaps
    // in — paused, so it can be armed before its first script. Browser-level
    // auto-attach reports existing tabs as well as future ones; the explicit
    // sweep below is a belt for a browser that doesn't, deduplicated through
    // `armedTargets`.
    await this.client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "tab" }, { exclude: true }],
    });
    const existing = await this.client.send<{
      targetInfos: { targetId: string; type: string }[];
    }>("Target.getTargets", { filter: [{ type: "tab" }] });
    for (const info of existing.targetInfos) {
      if (this.armedTargets.has(info.targetId)) continue;
      await this.client
        .send("Target.attachToTarget", { targetId: info.targetId, flatten: true })
        .catch(() => undefined);
    }
    this.timer = setInterval(() => {
      for (const page of this.pages.values()) {
        this.enqueueTake(page.sessionId);
        if (page.armed) void this.setCookies(page);
      }
    }, TAKE_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    // The hold is lifted for the final take: what it protects against is a
    // wedged *navigation*, and the race below is what protects the run from a
    // wedged take. A page that never armed measured nothing at all, and a
    // final take that cannot finish means the tail went unseen — both are
    // "stopped", not a smaller-but-complete result.
    let sawEverything = ![...this.pages.values()].some((page) => !page.armed);
    for (const page of this.pages.values()) page.navigatingSince = undefined;
    const takes = Promise.all([...this.pages.keys()].map((sessionId) => this.enqueueTake(sessionId)));
    const timedOut = await Promise.race([
      takes.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(resolve, STOP_TAKE_TIMEOUT_MS, true)),
    ]);
    if (timedOut) {
      this.opts.warn("the final coverage take did not answer; the spec's tail went unseen");
      sawEverything = false;
    }
    if (!sawEverything) this.resolution.markStopped();
    this.resolution.flush();
    this.client.close();
  }

  private async onAttached(params: {
    sessionId: string;
    targetInfo: { targetId: string; type: string; url: string };
    waitingForDebugger: boolean;
  }): Promise<void> {
    const { sessionId, targetInfo } = params;
    const release = (): Promise<unknown> =>
      params.waitingForDebugger
        ? this.client.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined)
        : Promise.resolve();
    if (this.stopped) {
      // A target attaching into a closing engine is released, never armed —
      // arming it would only print connection errors after the run finished.
      await release();
      return;
    }
    if (targetInfo.type === "tab") {
      if (!this.armedTargets.has(targetInfo.targetId)) {
        this.armedTargets.add(targetInfo.targetId);
        // The tab session's own auto-attach is what hands over its pages —
        // current, future, and the swapped-in successor of a cross-process
        // navigation, paused until armed.
        await this.client
          .send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
            sessionId,
          )
          .catch(() => undefined);
      }
      await release();
      return;
    }
    const measurable =
      (targetInfo.type === "page" || targetInfo.type === "iframe") &&
      !INTERNAL_URL.test(targetInfo.url);
    if (!measurable || this.armedTargets.has(targetInfo.targetId)) {
      // Not measured — or already armed through another session — but never
      // left hanging on the debugger. A duplicate session on a measured target
      // is dropped, so every page is driven through exactly one.
      await release();
      if (measurable) {
        await this.client
          .send("Target.detachFromTarget", { sessionId })
          .catch(() => undefined);
      }
      return;
    }
    this.armedTargets.add(targetInfo.targetId);
    const page: AttachedPage = {
      sessionId,
      targetId: targetInfo.targetId,
      armed: false,
      navigatingSince: undefined,
      mainFrameId: undefined,
      pending: Promise.resolve(),
    };
    this.pages.set(sessionId, page);
    // Everything is *sent* before the release and *awaited* after it. A target
    // waiting on the debugger answers no renderer-bound command until it is
    // released, so awaiting between sends deadlocks: the enable waits for the
    // release, the release waits for the enable. Sending first still gives the
    // ordering that matters — the renderer processes the queue in order when
    // it starts, so the profiler is on and the cookie exists before the first
    // script runs or the first request leaves.
    //
    // Deliberately minimal: no Debugger, no Network.enable, no Fetch. Those
    // domains push instrumentation the renderer can end up waiting on when
    // this process stops reading the socket — and the run process does stop
    // reading, every time it drives the browser through a synchronous spawn.
    // Everything left is pull-based (takes) or low-volume (frameNavigated).
    const sent: Promise<unknown>[] = [
      this.client.send("Profiler.enable", {}, sessionId),
      // Count mode is load-bearing, not a preference: best-effort mode's
      // counters stop applying to the next document a navigation brings in.
      this.client
        .send("Profiler.startPreciseCoverage", { callCount: true, detailed: true }, sessionId)
        .then(() => {
          page.armed = true;
        }),
      this.client.send("Page.enable", {}, sessionId),
      this.setCookies(page),
    ];
    await release();
    const results = await Promise.allSettled(sent);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed !== undefined) {
      // A target that vanished between attach and arm is routine (a closed
      // popup); anything armed half-way still counts what it can.
      this.opts.warn(`could not arm a browser target (${message(failed.reason)})`);
    }
  }

  private setCookies(page: AttachedPage): Promise<unknown> {
    if (this.cookies.length === 0) return Promise.resolve();
    // Per page session, not `Storage.setCookies` at the browser: the browser
    // command wants a *created* context's id and rejects the default one —
    // which is exactly the context a real driver's browser uses.
    return this.client
      .send("Network.setCookies", { cookies: this.cookies }, page.sessionId)
      .catch((error: unknown) => {
        this.opts.warn(`could not attach the spec cookie (${message(error)})`);
      });
  }

  private enqueueTake(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page === undefined || !page.armed) return Promise.resolve();
    if (page.navigatingSince !== undefined) {
      if (Date.now() - page.navigatingSince < NAVIGATION_GUARD_MS) return Promise.resolve();
      page.navigatingSince = undefined;
    }
    page.pending = page.pending
      .then(async () => {
        const taken = await this.client.send<{ result: ScriptCoverageEntry[] }>(
          "Profiler.takePreciseCoverage",
          {},
          sessionId,
        );
        await this.absorbEntries(taken.result);
      })
      .catch((error: unknown) => {
        // A session dying mid-take is routine (a closed page; detach handling
        // cleans up) and shutdown rejections are expected — but a resolution
        // bug would land here too, every 400ms, and swallowing it silently
        // shrinks the spec's result. Said once per session.
        if (this.stopped || this.warnedTakeSessions.has(sessionId)) return;
        this.warnedTakeSessions.add(sessionId);
        if (this.pages.has(sessionId)) {
          this.opts.warn(`a coverage take failed and later ones may too (${message(error)})`);
        }
      });
    return page.pending;
  }

  /** Face value until the main frame's id is known; see the arm() comment. */
  private isMainFrame(page: AttachedPage, frameId: string | undefined): boolean {
    return page.mainFrameId === undefined || frameId === undefined || frameId === page.mainFrameId;
  }

  private async absorbEntries(entries: readonly ScriptCoverageEntry[]): Promise<void> {
    let changed = false;
    for (const entry of entries) {
      const ranges: CoveredRange[] = [];
      for (const fn of entry.functions) {
        for (const range of fn.ranges) {
          if (range.count > 0) {
            ranges.push({ startOffset: range.startOffset, endOffset: range.endOffset });
          }
        }
      }
      if (ranges.length === 0) continue;
      const script: AcquiredScript = {
        url: entry.url,
        ranges,
        // Fetched over HTTP rather than `Debugger.getScriptSource` — the
        // Debugger domain is one of the ones this session must not enable
        // (see arm). A script that has no http(s) URL and still needs its
        // source is counted as unmapped, same as one whose map is missing.
        source: async () =>
          /^https?:/i.test(entry.url) ? this.fetchThroughBrowser(entry.url) : undefined,
      };
      await this.resolution.absorb(script);
      changed = true;
    }
    if (changed) this.resolution.flush();
  }

  /**
   * Fetches through a page where there is one, so the request carries the
   * session's cookies (see `FrontendResolutionOptions.fetchText`).
   */
  private async fetchThroughBrowser(url: string): Promise<string | undefined> {
    const [page] = this.pages.values();
    if (page !== undefined) {
      try {
        // Mandatory for frame targets: the resource is loaded as that frame.
        const tree = await this.client.send<{ frameTree: { frame: { id: string } } }>(
          "Page.getFrameTree",
          {},
          page.sessionId,
        );
        const loaded = await this.client.send<{
          resource: { success: boolean; stream?: string };
        }>(
          "Network.loadNetworkResource",
          {
            frameId: tree.frameTree.frame.id,
            url,
            options: { disableCache: false, includeCredentials: true },
          },
          page.sessionId,
        );
        if (loaded.resource.success && loaded.resource.stream !== undefined) {
          return await this.readStream(loaded.resource.stream, page.sessionId);
        }
      } catch {
        // Fall through to the plain fetch.
      }
    }
    // No page to borrow credentials from (or the browser refused): a plain
    // fetch still resolves the public case.
    try {
      const response = await fetch(url);
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    }
  }

  private async readStream(handle: string, sessionId: string): Promise<string> {
    const parts: string[] = [];
    for (;;) {
      const chunk = await this.client.send<{
        data: string;
        base64Encoded?: boolean;
        eof: boolean;
      }>("IO.read", { handle }, sessionId);
      parts.push(
        chunk.base64Encoded === true
          ? Buffer.from(chunk.data, "base64").toString("utf8")
          : chunk.data,
      );
      if (chunk.eof) break;
    }
    await this.client.send("IO.close", { handle }, sessionId).catch(() => undefined);
    return parts.join("");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
