/**
 * Reads and writes the one Temporal header this package uses.
 *
 * The payload is built by hand rather than through `defaultPayloadConverter` so
 * that the workflow half of the integration stays free of Temporal imports —
 * the workflow sandbox is picky, and a plain `json/plain` string is exactly
 * what the default converter would have produced anyway.
 */

import { TEMPORAL_HEADER, type CoverageMark } from "../wire.ts";

export interface TemporalPayload {
  metadata?: Record<string, Uint8Array> | null;
  data?: Uint8Array | null;
}

export type TemporalHeaders = Record<string, TemporalPayload | undefined>;

const ENCODING = "json/plain";

// Shared across calls: activities are scheduled, and headers decoded, far too
// often to pay for a fresh encoder/decoder each time.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * A spec travels as a bare string and an identity as an object, so the two are
 * told apart by shape rather than by a discriminator nobody else would read.
 */
export function toHeader(mark: CoverageMark): TemporalHeaders {
  const value = "spec" in mark ? mark.spec : { tag: mark.tag, at: mark.at };
  return {
    [TEMPORAL_HEADER]: {
      metadata: { encoding: encode(ENCODING) },
      data: encode(JSON.stringify(value)),
    },
  };
}

/** The raw value off the header. Callers validate it with `parseMark`. */
export function fromHeader(headers: TemporalHeaders | undefined): unknown {
  const payload = headers?.[TEMPORAL_HEADER];
  if (!payload?.data) return undefined;
  try {
    return JSON.parse(decode(payload.data)) as unknown;
  } catch {
    return undefined;
  }
}

function encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function decode(value: Uint8Array): string {
  return textDecoder.decode(value);
}
