import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * Minimal RFC 6455 client for the CDP transport, dependency-free on purpose.
 *
 * Not a general WebSocket: it exists because the runtime's global `WebSocket`
 * (undici) unconditionally offers `permessage-deflate`, Chromium's DevTools
 * server accepts it with context takeover, and a single hiccup in that
 * stateful inflate stream kills the connection from the client side — the
 * browser and the spec keep running while the measurement silently dies.
 * Every CDP client that ships (Playwright, puppeteer) disables the extension;
 * this transport never offers it, so there is no compressed state to corrupt.
 *
 * Deliberately lenient where the payload is concerned — text arrives through
 * `Buffer.toString("utf8")`, so an invalid byte becomes U+FFFD instead of a
 * dead transport — and strict only about frame structure, where a violation
 * means the stream can no longer be trusted at all.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HANDSHAKE_HEADER_CAP = 64 * 1024;
/** One assembled message; CDP takes and `IO.read` chunks reach megabytes, not this. */
const MESSAGE_CAP = 256 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class WsError extends Error {}

export interface RawSocketHandlers {
  /** One complete (defragmented) data message, decoded leniently as UTF-8. */
  onMessage(text: string): void;
  /**
   * The connection is gone, with the most specific reason this side knows —
   * a close frame's code, a socket error's message, or the frame violation
   * that made the stream untrustworthy. Fires exactly once.
   */
  onClose(detail: string): void;
}

/** Why a 101 response head is unacceptable, or `undefined` when it is fine. */
function handshakeFailure(head: string, expectedAccept: string, host: string): string | undefined {
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  if (!/^HTTP\/1\.1 101 /i.test(statusLine)) {
    return `handshake with ${host} answered "${statusLine.slice(0, 80)}"`;
  }
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if (headers.get("sec-websocket-accept") !== expectedAccept) {
    return `handshake with ${host} returned a wrong Sec-WebSocket-Accept`;
  }
  const extensions = headers.get("sec-websocket-extensions");
  if (extensions !== undefined && extensions !== "") {
    return `server negotiated unrequested extension "${extensions}"`;
  }
  return undefined;
}

export class RawWebSocket {
  private readonly socket: Socket;
  private handlers: RawSocketHandlers | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  /**
   * Arrived-but-unparsed chunks. Left as a list until a parse attempt can
   * make progress: a multi-megabyte take answered in one frame would
   * otherwise re-copy everything buffered so far on every TCP chunk.
   */
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  /** Bytes `buffer` must reach before another parse attempt can complete a frame. */
  private needed = 0;
  private fragments: Buffer[] = [];
  private fragmentedBytes = 0;
  private fragmentedOpcode: number | undefined;
  private closeSent = false;
  private finished = false;
  private peerCloseDetail: string | undefined;
  private isOpen = true;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  get open(): boolean {
    return this.isOpen;
  }

  /**
   * Opens the socket and completes the upgrade. No `Sec-WebSocket-Extensions`
   * is offered — that omission is this class's reason to exist — and a server
   * that answers with one anyway is refused: it would speak a framing this
   * side does not.
   */
  static async connect(wsUrl: string): Promise<RawWebSocket> {
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      throw new WsError(`not a ws URL: "${wsUrl}"`);
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new WsError(`not a ws URL: "${wsUrl}"`);
    }
    const secure = url.protocol === "wss:";
    const port = url.port !== "" ? Number(url.port) : secure ? 443 : 80;
    const host = url.hostname;
    const socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    socket.setNoDelay(true);

    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    const path = `${url.pathname || "/"}${url.search}`;
    const request =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;

    const leftover = await new Promise<Buffer>((resolve, reject) => {
      let response = Buffer.alloc(0);
      const timer = setTimeout(() => {
        fail(new WsError(`handshake with ${url.host} timed out`));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      const fail = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        response = Buffer.concat([response, chunk]);
        const headerEnd = response.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (response.length > HANDSHAKE_HEADER_CAP) {
            fail(new WsError(`handshake response from ${url.host} exceeded ${HANDSHAKE_HEADER_CAP} bytes`));
          }
          return;
        }
        const head = response.subarray(0, headerEnd).toString("latin1");
        const failure = handshakeFailure(head, expectedAccept, url.host);
        if (failure !== undefined) {
          fail(new WsError(failure));
          return;
        }
        cleanup();
        resolve(response.subarray(headerEnd + 4));
      };
      const onError = (error: Error): void => {
        fail(new WsError(`could not connect to ${url.host} (${error.message})`));
      };
      const onEnd = (): void => {
        fail(new WsError(`${url.host} closed the connection during the handshake`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onEnd);
      };
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onEnd);
      // A TLSSocket queues writes until its handshake settles, so writing on
      // the TCP connect is correct for both plain and TLS sockets.
      socket.on("connect", () => socket.write(request));
    });

    const ws = new RawWebSocket(socket);
    socket.on("data", (chunk: Buffer) => ws.ingest(chunk));
    socket.on("error", (error: Error) => ws.finish(`socket error: ${error.message}`));
    socket.on("close", () => ws.finish(ws.peerCloseDetail ?? "connection closed abruptly"));
    if (leftover.length > 0) ws.ingest(leftover);
    return ws;
  }

  attach(handlers: RawSocketHandlers): void {
    this.handlers = handlers;
  }

  /** Sends one text message. Throws `WsError` when the connection is gone. */
  send(text: string): void {
    if (!this.isOpen) throw new WsError("connection closed");
    this.sendFrame(OP_TEXT, Buffer.from(text, "utf8"));
  }

  /** Starts an orderly close; `onClose` fires when the socket is down. */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.peerCloseDetail ??= "connection closed";
    try {
      if (!this.closeSent) {
        this.closeSent = true;
        this.sendFrameRaw(OP_CLOSE, Buffer.from([0x03, 0xe8])); // 1000, normal closure
      }
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }

  private ingest(chunk: Buffer): void {
    if (this.finished) return;
    this.pendingChunks.push(chunk);
    this.pendingBytes += chunk.length;
    // O(1) while a known-length frame is still incomplete; the concat below
    // then happens once per frame instead of once per TCP chunk.
    if (this.buffer.length + this.pendingBytes < this.needed) return;
    this.buffer = Buffer.concat([this.buffer, ...this.pendingChunks]);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.needed = 0;
    for (;;) {
      const frame = this.parseFrame();
      if (frame === undefined || this.finished) return;
      this.handleFrame(frame.fin, frame.opcode, frame.payload);
    }
  }

  private parseFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const first = buf[0] ?? 0;
    const second = buf[1] ?? 0;
    if ((first & 0x70) !== 0) {
      // No extension was negotiated, so a set RSV bit means the peer is
      // framing for one anyway; nothing after this byte can be trusted.
      this.fail(`frame with RSV bits set (0x${first.toString(16)}) though no extension was negotiated`);
      return undefined;
    }
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return undefined;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return undefined;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MESSAGE_CAP)) {
        this.fail(`frame of ${big} bytes exceeds the ${MESSAGE_CAP}-byte cap`);
        return undefined;
      }
      length = Number(big);
      offset += 8;
    }
    let mask: Buffer | undefined;
    if (masked) {
      // A server must not mask, but unmasking a masked frame loses nothing.
      if (buf.length < offset + 4) return undefined;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) {
      this.needed = offset + length;
      return undefined;
    }
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask !== undefined) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
      }
    }
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmentedOpcode !== undefined) {
          this.fail("new data frame started inside a fragmented message");
          return;
        }
        if (fin) {
          this.deliver(payload);
          return;
        }
        this.fragmentedOpcode = opcode;
        this.fragments = [payload];
        this.fragmentedBytes = payload.length;
        return;
      case OP_CONTINUATION: {
        if (this.fragmentedOpcode === undefined) {
          this.fail("continuation frame outside a fragmented message");
          return;
        }
        this.fragments.push(payload);
        this.fragmentedBytes += payload.length;
        if (this.fragmentedBytes > MESSAGE_CAP) {
          this.fail(`fragmented message exceeds the ${MESSAGE_CAP}-byte cap`);
          return;
        }
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentedBytes = 0;
          this.fragmentedOpcode = undefined;
          this.deliver(whole);
        }
        return;
      }
      case OP_PING:
        // Answered even while closing: the peer may gate its close on it.
        try {
          this.sendFrameRaw(OP_PONG, payload);
        } catch {
          // The socket is going down; finish() will say so.
        }
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        this.peerCloseDetail =
          code === undefined
            ? "connection closed"
            : `connection closed (code ${code}${reason ? `: ${reason}` : ""})`;
        if (!this.closeSent) {
          this.closeSent = true;
          try {
            this.sendFrameRaw(OP_CLOSE, payload.subarray(0, 2));
          } catch {
            // Already down; the close detail is recorded either way.
          }
        }
        this.socket.end();
        return;
      }
      default:
        this.fail(`unknown frame opcode 0x${opcode.toString(16)}`);
    }
  }

  private deliver(payload: Buffer): void {
    // Lenient by design: an invalid byte becomes U+FFFD and at worst fails
    // one message's JSON parse, instead of killing the whole measurement.
    this.handlers?.onMessage(payload.toString("utf8"));
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    try {
      this.sendFrameRaw(opcode, payload);
    } catch (error) {
      throw new WsError(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private sendFrameRaw(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) {
      masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private fail(reason: string): void {
    this.socket.destroy();
    this.finish(reason);
  }

  private finish(detail: string): void {
    if (this.finished) return;
    this.finished = true;
    this.isOpen = false;
    this.buffer = Buffer.alloc(0);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.fragments = [];
    this.fragmentedBytes = 0;
    this.handlers?.onClose(detail);
  }
}
