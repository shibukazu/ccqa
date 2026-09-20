import { deflateRawSync } from "node:zlib";

/**
 * A real zip archive, built here so the trace reader and the evidence writer
 * are both exercised against actual bytes rather than a hand-rolled fixture.
 * Nothing but the tests reaches this module — no entry point imports it, so it
 * is not part of any build.
 */

export interface ZipInput {
  name: string;
  data: Buffer;
  method: "stored" | "deflate";
}

export function buildZip(inputs: ZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const input of inputs) {
    const nameBuf = Buffer.from(input.name, "utf8");
    const methodCode = input.method === "stored" ? 0 : 8;
    const payload = input.method === "stored" ? input.data : deflateRawSync(input.data);
    const localOffset = offset;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(methodCode, 8);
    localHeader.writeUInt32LE(0, 14); // crc32 — readZip never checks it
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(input.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, payload);
    offset += localHeader.length + nameBuf.length + payload.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(methodCode, 10);
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(input.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBuf);
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

