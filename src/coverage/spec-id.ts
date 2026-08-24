import { specKey, type SpecRef } from "../store/index.ts";

/**
 * `<runId>.<feature>/<spec>`. The run id keeps a stale cookie from an earlier
 * run out; the spec half is `specKey`, so an id here and a report row name the
 * same spec the same way.
 */
export function specIdFor(runId: string, ref: SpecRef): string {
  return `${runId}.${specKey(ref)}`;
}

/**
 * Inverse of `specIdFor`: the `feature/spec` half, or null when the id was
 * minted under another run. The runId itself may contain `.`, so the known
 * prefix is stripped by length, never by splitting on the dot.
 */
export function specKeyFromSpecId(specId: string, runId: string): string | null {
  return specId.startsWith(`${runId}.`) ? specId.slice(runId.length + 1) : null;
}
