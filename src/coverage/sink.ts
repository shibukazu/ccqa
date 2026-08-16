/**
 * Where instrumented application processes push what they reached. Why they
 * push rather than being scraped is ADR-0021.
 *
 * It authenticates nothing. The gate is the set of spec ids this run issued —
 * a token would have to be configured on both sides to add anything, and the
 * sink binds to loopback by default.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

import { ACTOR_WINDOW_TOLERANCE_MS, type ActorWindow } from "./actors.ts";
import { SPEC_ID_PATTERN } from "./contract.ts";

/** What an instrumented process pushes, once a second. */
const PushSchema = z.object({
  protocol: z.literal(1),
  pid: z.number(),
  startedAt: z.number(),
  unattributed: z.number(),
  // Not `z.record` with a key regex: one bad key would reject the whole push,
  // discarding every other spec's delta with it. Keys are checked per entry in
  // `accept`, where a bad one costs only itself.
  specs: z.record(z.string(), z.array(z.string())),
  boot: z.array(z.string()),
  /** Added by later SDK builds; absent from older ones, hence the defaults. */
  uninstrumentedFiles: z.number().default(0),
  uninstrumentedProcess: z.boolean().default(false),
  droppedPushes: z.number().default(0),
  /**
   * What some identity reached, and when that work was first asked for. The
   * application states only this; which spec it belongs to is decided here.
   */
  actors: z
    .array(
      z.object({ tag: z.string(), at: z.number(), files: z.array(z.string()) }),
    )
    .default([]),
});
type CoveragePush = z.infer<typeof PushSchema>;

/** Everything one spec's execution reached, across every process that reported. */
interface SpecCoverage {
  files: Set<string>;
  /**
   * Each reporting process's unattributed count when this spec's bucket opened.
   * The push carries a process-wide running total, so without a baseline a
   * spec would inherit every earlier spec's gaps as if they were its own.
   */
  baseline: Map<string, number>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The running figures one application process reports about itself.
 *
 * `droppedBaseline` is what it had already failed to deliver when this run
 * first heard from it: an application outlives the runs measuring it, and only
 * the difference happened while there was a sink to miss.
 */
interface ProcessReport {
  unattributed: number;
  uninstrumentedFiles: number;
  /** Instrumented nothing at all, so every file it ran is missing rather than some. */
  blind: boolean;
  droppedBaseline: number;
  droppedLatest: number;
}

/**
 * One spec's turn at acting as an identity, on the sink's clock.
 *
 * Opened when the spec starts and closed once its pushes have gone quiet, so
 * the work a spec's last action triggers is still inside its own turn.
 */
interface WindowLog {
  tag: string;
  key: string;
  specId: string;
  openedAt: number;
  closedAt: number | undefined;
}

export class CoverageSink {
  /** Where instrumented processes push to. Known once the socket is bound. */
  url = "";

  private readonly specs = new Map<string, SpecCoverage>();
  private readonly bootFiles = new Set<string>();
  /** What each reporting process last said about itself, keyed so a restart is a new one. */
  private readonly processes = new Map<string, ProcessReport>();
  private pushesReceived = 0;
  private rejected = 0;
  private malformed = 0;
  /** Every turn this run has handed out, oldest first. Kept for the whole run. */
  private readonly windows: WindowLog[] = [];
  /** Per spec, per window, the distinct events that landed in it. Drives the row's count. */
  private readonly matched = new Map<string, Map<string, Set<string>>>();
  /** Events from a declared identity that fell outside every turn it was given. */
  private readonly outsideWindow = new Map<string, number>();
  /**
   * Events from identities this project never declared — other people using the
   * same environment. Deduplicated by timestamp alone: the identity is dropped
   * on arrival, so there is nothing else left to tell two of them apart.
   */
  private readonly unmappedAt = new Set<number>();

  private readonly server: Server;
  /** Spec ids this run issued. A push naming anything else is dropped. */
  private readonly issued: ReadonlySet<string>;
  /** Declared identities to their display key. A tag absent here is somebody else's. */
  private readonly tagToKey: ReadonlyMap<string, string>;

  // Assigned in the body rather than declared as parameters: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  private constructor(
    server: Server,
    issued: ReadonlySet<string>,
    tagToKey: ReadonlyMap<string, string>,
  ) {
    this.server = server;
    this.issued = issued;
    this.tagToKey = tagToKey;
  }

  /**
   * Binds and starts accepting pushes. `issued` is fixed at start: the cookie
   * is client-controlled, so an id this run never issued is refused here
   * rather than trusted into a report.
   */
  static async start(
    host: string,
    port: number,
    issued: ReadonlySet<string>,
    tagToKey: ReadonlyMap<string, string> = new Map(),
  ): Promise<CoverageSink> {
    // The handler is attached before the socket binds, so the first push
    // cannot arrive at a server that has none and hang until its timeout.
    const sink = new CoverageSink(createServer(), issued, tagToKey);
    sink.server.on("request", (request, response) => {
      void sink.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      sink.server.once("error", reject);
      sink.server.listen(port, host, () => {
        sink.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = sink.server.address() as AddressInfo;
    sink.url = `http://${formatHost(host)}:${address.port}`;
    return sink;
  }

  /** What `specId` reached so far. Reads do not clear: late pushes still land. */
  filesFor(specId: string): ReadonlySet<string> | undefined {
    return this.specs.get(specId)?.files;
  }

  /** Gives `specId` sole claim to `window`'s identity from now until it is closed. */
  openWindow(window: ActorWindow, specId: string): void {
    this.windows.push({
      tag: window.tag,
      key: window.key,
      specId,
      openedAt: Date.now(),
      closedAt: undefined,
    });
  }

  /** Ends the open turn on `tag`. Later events from it belong to nobody. */
  closeWindow(tag: string): void {
    for (let i = this.windows.length - 1; i >= 0; i--) {
      const window = this.windows[i]!;
      if (window.tag !== tag || window.closedAt !== undefined) continue;
      window.closedAt = Date.now();
      return;
    }
  }

  /** When the run may next open a turn on `tag`, given the drain it has to leave. */
  lastClosedAt(tag: string): number | undefined {
    let latest: number | undefined;
    for (const window of this.windows) {
      if (window.tag !== tag || window.closedAt === undefined) continue;
      latest = window.closedAt;
    }
    return latest;
  }

  /** Per window key, how many distinct events this spec was credited with. */
  actorEventsFor(specId: string): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const [key, events] of this.matched.get(specId) ?? []) counts.set(key, events.size);
    return counts;
  }

  /**
   * Events from a declared identity that arrived outside its turns.
   *
   * Loud rather than silent: it means something other than this run drove that
   * identity, and whatever it reached is missing from a spec that looks whole.
   */
  outsideWindowEvents(): ReadonlyMap<string, number> {
    return this.outsideWindow;
  }

  /** Events from identities this project never declared. Their reach belongs to nobody. */
  unmappedActorEvents(): number {
    return this.unmappedAt.size;
  }

  /** Executions that ran while `specId` was open but outside its context. */
  unattributedFor(specId: string): number {
    const spec = this.specs.get(specId);
    if (spec === undefined) return 0;
    let total = 0;
    for (const [process, baseline] of spec.baseline) {
      total += Math.max(0, (this.processes.get(process)?.unattributed ?? 0) - baseline);
    }
    return total;
  }

  /**
   * Files reached at module top level. Deliberately not folded into any spec:
   * the first spec to import a module would otherwise own it, which makes a
   * spec's result depend on the order the run happened to execute.
   */
  boot(): ReadonlySet<string> {
    return this.bootFiles;
  }

  /** True once any instrumented process has reported — i.e. the server half is wired up. */
  heardFromApplication(): boolean {
    return this.pushesReceived > 0;
  }

  /**
   * Specs some process attributed a file to.
   *
   * Distinct from `heardFromApplication`, which a process satisfies with its
   * boot set alone. An application that reports but attributes nothing has the
   * instrumentation working and the spec cookie not arriving — and that reads
   * identically to a server that genuinely ran no code.
   */
  attributedSpecs(): number {
    return this.specs.size;
  }

  /** Pushes refused because they named a spec id this run never issued. */
  rejectedPushes(): number {
    return this.rejected;
  }

  /**
   * Pushes the sink could not read. Counted because the failure is otherwise
   * invisible from this side and shows up as "the spec reached no server code".
   */
  malformedPushes(): number {
    return this.malformed;
  }

  /**
   * Files the applications could not instrument — they can never report reach.
   *
   * Not baselined, unlike `unattributed` and `droppedPushes`: a file that
   * failed to rewrite when the process booted is still unrewritten now, so it
   * is a standing condition of this run and not a past event.
   */
  uninstrumentedFiles(): number {
    let total = 0;
    for (const report of this.processes.values()) total += report.uninstrumentedFiles;
    return total;
  }

  /**
   * Application processes that instrumented nothing at all. Kept apart from
   * the file count because one of these hides every file the process ran, and
   * folded together it would read as a single missing file.
   */
  uninstrumentedProcesses(): number {
    let total = 0;
    for (const report of this.processes.values()) if (report.blind) total++;
    return total;
  }

  /** Pushes the applications could not deliver during this run. Never seen here. */
  droppedPushes(): number {
    let total = 0;
    for (const report of this.processes.values()) {
      total += Math.max(0, report.droppedLatest - report.droppedBaseline);
    }
    return total;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body: string;
    try {
      body = await readBody(request);
    } catch {
      this.malformed++;
      response.writeHead(413).end();
      return;
    }
    let push: CoveragePush;
    try {
      push = PushSchema.parse(JSON.parse(body));
    } catch {
      this.malformed++;
      response.writeHead(400).end();
      return;
    }
    this.accept(push);
    response.writeHead(204).end();
  }

  private accept(push: CoveragePush): void {
    const process = `${push.pid}:${push.startedAt}`;
    // Falling back to this push's own figure, not zero: the application process
    // outlives the run and arrives carrying a lifetime total. Counting from the
    // first push this run sees costs at most the sub-second before it, and the
    // alternative charged one spec with every gap since the server booted.
    const known = this.processes.get(process);
    const previous = known?.unattributed ?? push.unattributed;
    for (const file of push.boot) this.bootFiles.add(file);
    for (const [specId, files] of Object.entries(push.specs)) {
      if (!SPEC_ID_PATTERN.test(specId) || !this.issued.has(specId)) {
        this.rejected++;
        continue;
      }
      let spec = this.specs.get(specId);
      if (spec === undefined) {
        spec = { files: new Set(), baseline: new Map() };
        this.specs.set(specId, spec);
      }
      if (!spec.baseline.has(process)) spec.baseline.set(process, previous);
      for (const file of files) spec.files.add(file);
    }
    for (const event of push.actors) this.attributeActorEvent(event, process, previous);
    this.processes.set(process, {
      unattributed: push.unattributed,
      uninstrumentedFiles: push.uninstrumentedFiles,
      // Once true it stays true: a process that could not instrument itself
      // does not recover, and a later push saying nothing about it is not news.
      blind: known?.blind === true || push.uninstrumentedProcess,
      droppedBaseline: known?.droppedBaseline ?? push.droppedPushes,
      droppedLatest: push.droppedPushes,
    });
    this.pushesReceived++;
  }

  /**
   * Decides which spec, if any, an identity's work belongs to.
   *
   * `at` is when the work was first asked for, not when it ran — an activity a
   * queue picks up minutes later still carries the instant that caused it, so a
   * slow tail lands in the turn that started it rather than the one running now.
   */
  private attributeActorEvent(
    event: { tag: string; at: number; files: string[] },
    process: string,
    previous: number,
  ): void {
    const key = this.tagToKey.get(event.tag);
    if (key === undefined) {
      // Somebody else on a shared environment. The identity is dropped here and
      // not stored anywhere, so all that is left to count with is the instant.
      this.unmappedAt.add(event.at);
      return;
    }
    const window = this.windowAt(event.tag, event.at);
    if (window === undefined) {
      this.outsideWindow.set(key, (this.outsideWindow.get(key) ?? 0) + 1);
      return;
    }
    const spec = this.specs.get(window.specId) ?? { files: new Set(), baseline: new Map() };
    this.specs.set(window.specId, spec);
    // The same baseline a spec carried by a request would get. A spec attributed
    // only through an identity never appears in `push.specs`, so without this
    // its `unattributed` has nothing to subtract from and reads as a clean zero
    // — on exactly the specs where an identity bucket keeps the gate armed and
    // the counter moving.
    if (!spec.baseline.has(process)) spec.baseline.set(process, previous);
    for (const file of event.files) spec.files.add(file);

    let byKey = this.matched.get(window.specId);
    if (byKey === undefined) {
      byKey = new Map();
      this.matched.set(window.specId, byKey);
    }
    const events = byKey.get(key) ?? new Set<string>();
    // One request can be reported over several pushes as it reaches more files;
    // counting the instant rather than the report keeps that one event.
    events.add(`${event.tag} ${event.at}`);
    byKey.set(key, events);
  }

  /**
   * The turn on `tag` that `at` falls in, latest first.
   *
   * Both clocks are involved — the application stamped `at`, this process
   * stamped the bounds — so each bound gives a little. It cannot reach the
   * neighbouring turn: the run leaves a full drain between two turns on one
   * identity and this reaches half of it.
   */
  private windowAt(tag: string, at: number): WindowLog | undefined {
    let found: WindowLog | undefined;
    for (const window of this.windows) {
      if (window.tag !== tag) continue;
      if (at < window.openedAt - ACTOR_WINDOW_TOLERANCE_MS) continue;
      if (window.closedAt !== undefined && at > window.closedAt + ACTOR_WINDOW_TOLERANCE_MS) continue;
      found = window;
    }
    return found;
  }
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("coverage push too large");
    chunks.push(buffer);
  }
  return (chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)).toString("utf8");
}
