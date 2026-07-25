import type { ServerResponse } from "node:http";
import type { ZodType } from "zod";

/** The message of an unknown throwable, for a log line or an error body. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  sendJson(res, 500, { error: { code: "internal_error", message: errMsg(err) } });
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

/**
 * Read a JSON request body and validate it against `schema`. Both a body that
 * isn't JSON and one that doesn't fit the schema are the client's fault, so
 * both are 400 `invalid_body` — a bare `JSON.parse` would surface a malformed
 * body as a 500. `label` names the body in the message ("deploy body").
 */
export async function readJsonBody<T>(
  req: NodeJS.ReadableStream,
  maxBytes: number,
  schema: ZodType<T>,
  label: string,
): Promise<T> {
  const raw = await readBody(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_body", `${label} must be valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_body",
      `${label} is invalid: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return result.data;
}
