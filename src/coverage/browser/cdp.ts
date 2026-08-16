import { appendFileSync } from "node:fs";

/**
 * Minimal Chrome DevTools Protocol client, dependency-free on purpose.
 *
 * Coverage acquisition speaks a handful of domains over one transport, which
 * is not enough to justify a protocol library in a published CLI. The
 * transport is the `WebSocket` global — stable since Node 22 — so availability
 * is gated with an explicit error instead of a package.json engines bump:
 * everything else in ccqa still runs on 20, and only `--coverage`'s browser
 * half needs more.
 */

export class CdpError extends Error {}

/**
 * Wire-level trace, for diagnosing the engine against a live browser:
 * `CCQA_CDP_TRACE=1` writes to stderr, `CCQA_CDP_TRACE_FILE=<path>` to a file.
 * The file is the usable one during a live run, whose stderr already carries
 * the agent's narration.
 */
const TRACE_FILE = process.env.CCQA_CDP_TRACE_FILE;
const TRACE = process.env.CCQA_CDP_TRACE === "1" || TRACE_FILE !== undefined;

function trace(direction: string, text: string): void {
  if (!TRACE) return;
  const line = `[cdp ${direction}] ${Date.now() % 100000} ${text}\n`;
  if (TRACE_FILE === undefined) {
    process.stderr.write(line);
    return;
  }
  try {
    appendFileSync(TRACE_FILE, line);
  } catch {
    // Tracing must never break the engine.
  }
}

export type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

/** Throws with the actual requirement when the runtime cannot open the socket. */
export function requireWebSocket(): void {
  if (typeof WebSocket === "undefined") {
    throw new CdpError(
      `browser coverage needs the WebSocket global (node 22+); this is node ${process.version}`,
    );
  }
}

/**
 * Resolves whatever a target hands us — `host:port`, an `http://` endpoint, or
 * a ws URL — to the **browser-level** ws endpoint. A page-level ws URL is not
 * enough: auto-attach has to be armed at the browser to see every page and
 * every popup, so a page URL is reduced to its host and re-resolved through
 * `/json/version` like the rest.
 */
export async function browserWebSocketUrl(endpoint: string): Promise<string> {
  const trimmed = endpoint.trim();
  if (/^wss?:\/\//i.test(trimmed) && trimmed.includes("/devtools/browser/")) return trimmed;
  let host: string;
  try {
    const url = new URL(/^[a-z+]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    host = url.host;
  } catch {
    throw new CdpError(`not a CDP endpoint: "${endpoint}"`);
  }
  const version = await fetch(`http://${host}/json/version`).catch((error: unknown) => {
    throw new CdpError(`CDP endpoint ${host} did not answer /json/version (${message(error)})`);
  });
  if (!version.ok) throw new CdpError(`CDP endpoint ${host} answered ${version.status}`);
  const body = (await version.json()) as { webSocketDebuggerUrl?: string };
  if (typeof body.webSocketDebuggerUrl !== "string") {
    throw new CdpError(`CDP endpoint ${host} reported no webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

/**
 * What the engine needs from a transport. Structural, so the engine's state
 * machine — which the real-browser e2e cannot exercise on CI — is testable
 * against a scripted fake.
 */
export interface CdpTransport {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  on(method: string, handler: EventHandler): void;
  onClose(handler: () => void): void;
  close(): void;
}

export class CdpClient implements CdpTransport {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private readonly closeHandlers = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => this.receive(String((event as MessageEvent).data)));
    ws.addEventListener("close", () => this.drop("connection closed"));
    ws.addEventListener("error", () => this.drop("connection error"));
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    requireWebSocket();
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new CdpError(`could not connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new CdpClient(ws);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError(`${method}: connection closed`));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
    });
    trace("->", `#${id} ${method} sid:${shortId(sessionId)}`);
    this.ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
    return promise;
  }

  on(method: string, handler: EventHandler): void {
    let set = this.listeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Already closing; drop() has done or will do the bookkeeping.
    }
  }

  private receive(data: string): void {
    let parsed: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      trace("rx", `unparseable frame: ${data.slice(0, 60)}`);
      return;
    }
    if (parsed.id !== undefined) {
      const waiting = this.pending.get(parsed.id);
      if (waiting === undefined) return;
      this.pending.delete(parsed.id);
      if (parsed.error !== undefined) {
        trace("<-", `#${parsed.id} ${waiting.method} ERROR ${parsed.error.message ?? "?"}`);
        waiting.reject(new CdpError(`${waiting.method}: ${parsed.error.message ?? "CDP error"}`));
      } else {
        trace("<-", `#${parsed.id} ${waiting.method} ok`);
        waiting.resolve(parsed.result ?? {});
      }
      return;
    }
    if (parsed.method !== undefined) {
      trace("ev", describeEvent(parsed.method, parsed.params ?? {}, parsed.sessionId));
      const set = this.listeners.get(parsed.method);
      if (set === undefined) return;
      for (const handler of set) {
        try {
          handler(parsed.params ?? {}, parsed.sessionId);
        } catch {
          // An event handler must never take the transport down with it.
        }
      }
    }
  }

  private drop(reason: string): void {
    for (const waiting of this.pending.values()) {
      waiting.reject(new CdpError(`${waiting.method}: ${reason}`));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // Same rule as event handlers.
      }
    }
    this.closeHandlers.clear();
  }
}

/** Attach events carry the one thing a method name cannot: what was handed over. */
function describeEvent(
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): string {
  const base = `${method} sid:${shortId(sessionId)}`;
  if (method !== "Target.attachedToTarget") return base;
  const info = params as {
    targetInfo?: { type?: string; url?: string };
    sessionId?: string;
    waitingForDebugger?: boolean;
  };
  return (
    `${base} child:${shortId(info.sessionId)} ${info.targetInfo?.type ?? "?"} ` +
    `${info.targetInfo?.url?.slice(0, 40) ?? "?"} wait:${String(info.waitingForDebugger)}`
  );
}

function shortId(sessionId: string | undefined): string {
  return sessionId?.slice(0, 6) ?? "-";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
