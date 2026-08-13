/**
 * Carries the spec id across Temporal, whose activities are the one async-job
 * boundary that can be attributed at all: the SDK hands interceptors the same
 * header map on the way out of a client and on the way into an activity.
 *
 * Three hops, three interceptors. The middle one — the workflow — lives in
 * `ccqa-coverage/temporal/workflow` because it is evaluated inside a
 * deterministic sandbox that has no Node built-ins.
 */

import { currentActor, currentSpecId, runAsActor, runInSpec } from "../core.ts";
import { TEMPORAL_HEADER, parseMark, type CoverageMark } from "../wire.ts";
import { fromHeader, toHeader, type TemporalHeaders } from "./header.ts";

interface WithHeaders {
  headers: TemporalHeaders;
}

type Next<I, O> = (input: I) => O;

/**
 * Client side: stamps the spec of whatever request is starting the workflow.
 *
 * Both `start` and `signalWithStart` begin executions; covering only one leaves
 * a hole that shows up as an unattributed activity much later.
 */
export function createClientInterceptor(): {
  start: <I extends WithHeaders, O>(input: I, next: Next<I, O>) => O;
  signalWithStart: <I extends WithHeaders, O>(input: I, next: Next<I, O>) => O;
} {
  const stamp = <I extends WithHeaders, O>(input: I, next: Next<I, O>): O => {
    const mark = currentMark();
    if (mark === undefined) return next(input);
    return next({ ...input, headers: { ...input.headers, ...toHeader(mark) } });
  };
  return { start: stamp, signalWithStart: stamp };
}

/**
 * Activity side: reopens the context the work came from. Activities run in an
 * ordinary Node context, so everything the activity touches is attributed from
 * here on.
 *
 * An identity mark keeps the instant it was stamped with rather than taking
 * the current time — an activity may run long after the request that scheduled
 * it, and the run matches on when the work was asked for.
 */
export function createActivityInterceptor(): {
  execute: <I extends WithHeaders, O>(input: I, next: Next<I, O>) => O;
} {
  return {
    execute: <I extends WithHeaders, O>(input: I, next: Next<I, O>): O => {
      const mark = parseMark(fromHeader(input.headers));
      if (mark === undefined) return next(input);
      if ("spec" in mark) return runInSpec(mark.spec, () => next(input));
      return runAsActor(mark.tag, mark.at, () => next(input));
    },
  };
}

/** What the current context has to hand on: its spec, or who caused it. */
function currentMark(): CoverageMark | undefined {
  const specId = currentSpecId();
  if (specId !== undefined) return { spec: specId };
  const actor = currentActor();
  return actor === undefined ? undefined : { tag: actor.tag, at: actor.at };
}

export { TEMPORAL_HEADER };
