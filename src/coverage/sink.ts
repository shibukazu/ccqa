/**
 * Where instrumented application processes push what they reached. Why they
 * push rather than being scraped is ADR-0021.
 *
 * This is the transport half only: it reads bodies, stamps arrival with the
 * one clock this process has, and hands each event to the resolver — which
 * owns every judgement about what the events mean.
 *
 * It authenticates nothing. The gate is the set of spec ids this run issued —
 * a token would have to be configured on both sides to add anything, and the
 * sink binds to loopback by default.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ActorWindow } from "./actors.ts";
import { CoverageResolver, PushSchema, type CoveragePush } from "./resolver.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class CoverageSink {
  /** Where instrumented processes push to. Known once the socket is bound. */
  url = "";

  private readonly server: Server;
  private readonly resolver: CoverageResolver;
  /**
   * Pushes this side could not read. Counted here, not in the resolver: an
   * unreadable body never becomes an event, so only the transport that
   * dropped it can count it — a host replaying the stream would see nothing.
   */
  private malformed = 0;

  // Assigned in the body rather than declared as parameters: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  private constructor(server: Server, resolver: CoverageResolver) {
    this.server = server;
    this.resolver = resolver;
  }

  /**
   * Binds and starts accepting pushes. `issued` is fixed at start: the cookie
   * is client-controlled, so an id this run never issued is refused by the
   * resolver rather than trusted into a report.
   */
  static async start(
    host: string,
    port: number,
    issued: ReadonlySet<string>,
    tagToKey: ReadonlyMap<string, string> = new Map(),
  ): Promise<CoverageSink> {
    // The handler is attached before the socket binds, so the first push
    // cannot arrive at a server that has none and hang until its timeout.
    const sink = new CoverageSink(createServer(), new CoverageResolver(issued, tagToKey));
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
    return this.resolver.filesFor(specId);
  }

  /** Gives `specId` sole claim to `window`'s identity from now until it is closed. */
  openWindow(window: ActorWindow, specId: string): void {
    this.resolver.apply({
      kind: "window-open",
      at: Date.now(),
      tag: window.tag,
      key: window.key,
      specId,
    });
  }

  /** Ends the open turn on `tag`. Later events from it belong to nobody. */
  closeWindow(tag: string): void {
    this.resolver.apply({ kind: "window-close", at: Date.now(), tag });
  }

  /** When the run may next open a turn on `tag`, given the drain it has to leave. */
  lastClosedAt(tag: string): number | undefined {
    return this.resolver.lastClosedAt(tag);
  }

  /** Per window key, how many distinct events this spec was credited with. */
  actorEventsFor(specId: string): ReadonlyMap<string, number> {
    return this.resolver.actorEventsFor(specId);
  }

  /** Events from a declared identity that arrived outside its turns. */
  outsideWindowEvents(): ReadonlyMap<string, number> {
    return this.resolver.outsideWindowEvents();
  }

  /** Events from identities this project never declared. Their reach belongs to nobody. */
  unmappedActorEvents(): number {
    return this.resolver.unmappedActorEvents();
  }

  /** Executions that ran while `specId` was open but outside its context. */
  unattributedFor(specId: string): number {
    return this.resolver.unattributedFor(specId);
  }

  /** Files reached at module top level, never folded into any spec. */
  boot(): ReadonlySet<string> {
    return this.resolver.boot();
  }

  /** True once any instrumented process has reported — i.e. the server half is wired up. */
  heardFromApplication(): boolean {
    return this.resolver.heardFromApplication();
  }

  /** Specs some process attributed a file to. */
  attributedSpecs(): number {
    return this.resolver.attributedSpecs();
  }

  /** Pushes refused because they named a spec id this run never issued. */
  rejectedPushes(): number {
    return this.resolver.rejectedPushes();
  }

  /**
   * Pushes the sink could not read. Counted because the failure is otherwise
   * invisible from this side and shows up as "the spec reached no server code".
   */
  malformedPushes(): number {
    return this.malformed;
  }

  /** Files the applications could not instrument — they can never report reach. */
  uninstrumentedFiles(): number {
    return this.resolver.uninstrumentedFiles();
  }

  /** Application processes that instrumented nothing at all. */
  uninstrumentedProcesses(): number {
    return this.resolver.uninstrumentedProcesses();
  }

  /** Pushes the applications could not deliver during this run. Never seen here. */
  droppedPushes(): number {
    return this.resolver.droppedPushes();
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
    this.resolver.apply({ kind: "push", at: Date.now(), push });
    response.writeHead(204).end();
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
