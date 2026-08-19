import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { RawWebSocket } from "./ws.ts";

/**
 * The transport against a scripted TCP peer. What matters here is exactly
 * what broke in production: the handshake must not offer permessage-deflate
 * (the stateful inflate stream is what killed CI measurements), and the
 * framing layer must survive fragmentation, pings, and large frames without
 * inventing its own failure modes.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface Peer {
  server: Server;
  url: string;
  /** Resolves per accepted connection with the captured handshake request. */
  connections: Promise<{ socket: Socket; request: string }>;
}

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** One-connection ws server; `extra` appends headers to the 101 response. */
function listen(extra = ""): Promise<Peer> {
  return new Promise((resolveListen) => {
    let resolveConn: (value: { socket: Socket; request: string }) => void;
    const connections = new Promise<{ socket: Socket; request: string }>((resolve) => {
      resolveConn = resolve;
    });
    const server = createServer((socket) => {
      let request = "";
      const onData = (chunk: Buffer): void => {
        request += chunk.toString("latin1");
        const end = request.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.off("data", onData);
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(request)?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`,
        );
        resolveConn({ socket, request });
      };
      socket.on("data", onData);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolveListen({ server, url: `ws://127.0.0.1:${port}/ws`, connections });
    });
  });
}

/** Server-side frame: unmasked, as a server speaks. */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parses one masked client frame from a buffer; returns payload and rest. */
function parseClientFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buf.length < 2) return undefined;
  const opcode = (buf[0] ?? 0) & 0x0f;
  let length = (buf[1] ?? 0) & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buf.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  expect((buf[1] ?? 0) & 0x80, "client frames must be masked").not.toBe(0);
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  if (buf.length < offset + length) return undefined;
  const payload = Buffer.from(buf.subarray(offset, offset + length));
  for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return { opcode, payload, rest: buf.subarray(offset + length) };
}

async function attach(ws: RawWebSocket): Promise<{ messages: string[]; closed: Promise<string> }> {
  const messages: string[] = [];
  let resolveClosed: (detail: string) => void;
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });
  ws.attach({ onMessage: (text) => messages.push(text), onClose: (detail) => resolveClosed(detail) });
  return { messages, closed };
}

function nextChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => socket.once("data", resolve));
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("RawWebSocket", () => {
  it("offers no extension in the handshake and delivers text messages", async () => {
    const peer = await listen();
    const ws = await RawWebSocket.connect(peer.url);
    const { messages } = await attach(ws);
    const { socket, request } = await peer.connections;
    // The reason this transport exists: never let the peer negotiate
    // permessage-deflate, whose stateful stream is unrecoverable on error.
    expect(request.toLowerCase()).not.toContain("sec-websocket-extensions");
    socket.write(frame(0x1, Buffer.from('{"hello":1}')));
    await settle();
    expect(messages).toEqual(['{"hello":1}']);
    ws.close();
  });

  it("refuses a server that negotiates an extension anyway", async () => {
    const peer = await listen("Sec-WebSocket-Extensions: permessage-deflate\r\n");
    await expect(RawWebSocket.connect(peer.url)).rejects.toThrow(/unrequested extension/);
  });

  it("reassembles a fragmented message and handles a 16-bit length", async () => {
    const peer = await listen();
    const ws = await RawWebSocket.connect(peer.url);
    const { messages } = await attach(ws);
    const { socket } = await peer.connections;
    const big = "x".repeat(70_000);
    socket.write(
      Buffer.concat([
        frame(0x1, Buffer.from("part1-"), false),
        frame(0x0, Buffer.from("part2"), true),
        frame(0x1, Buffer.from(big)),
      ]),
    );
    await settle();
    expect(messages).toEqual(["part1-part2", big]);
    ws.close();
  });

  it("masks what it sends and answers pings with pongs", async () => {
    const peer = await listen();
    const ws = await RawWebSocket.connect(peer.url);
    await attach(ws);
    const { socket } = await peer.connections;
    const received = nextChunk(socket);
    ws.send("ping me");
    const first = parseClientFrame(await received);
    expect(first?.opcode).toBe(0x1);
    expect(first?.payload.toString()).toBe("ping me");
    const pongArrived = nextChunk(socket);
    socket.write(frame(0x9, Buffer.from("beat")));
    const pong = parseClientFrame(await pongArrived);
    expect(pong?.opcode).toBe(0xa);
    expect(pong?.payload.toString()).toBe("beat");
    ws.close();
  });

  it("reports a close frame's code and an abrupt end distinctly", async () => {
    const peerA = await listen();
    const wsA = await RawWebSocket.connect(peerA.url);
    const a = await attach(wsA);
    const { socket: socketA } = await peerA.connections;
    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1001, 0);
    socketA.write(frame(0x8, closePayload));
    await expect(a.closed).resolves.toContain("code 1001");
    expect(wsA.open).toBe(false);

    const peerB = await listen();
    const wsB = await RawWebSocket.connect(peerB.url);
    const b = await attach(wsB);
    const { socket: socketB } = await peerB.connections;
    socketB.destroy();
    await expect(b.closed).resolves.toContain("abruptly");
  });

  it("treats a frame with RSV bits as a dead stream, with the reason", async () => {
    const peer = await listen();
    const ws = await RawWebSocket.connect(peer.url);
    const { closed } = await attach(ws);
    const { socket } = await peer.connections;
    const bad = frame(0x1, Buffer.from("z"));
    bad[0] = (bad[0] ?? 0) | 0x40; // RSV1 — what a deflate frame would carry
    socket.write(bad);
    await expect(closed).resolves.toContain("RSV");
    expect(() => ws.send("x")).toThrow(/closed/);
  });
});
