import type { ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(text);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: "internal_error", message } });
}

export function sendBytes(res: ServerResponse, status: number, bytes: Uint8Array, contentType: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(Buffer.from(bytes));
}

/** Read a request body into a single Buffer, rejecting once `maxBytes` is exceeded. */
export function readBody(req: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectPromise(new HttpError(413, "payload_too_large", `request body exceeds ${maxBytes} bytes`));
        req.removeAllListeners();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", rejectPromise);
  });
}
