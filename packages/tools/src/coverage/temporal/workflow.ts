/**
 * The workflow hop, kept in its own module because Temporal evaluates it inside
 * the deterministic sandbox. Nothing here may reach for a Node built-in — not
 * even transitively — which rules out importing `core.ts`'s neighbours.
 *
 * Register it with the worker:
 *
 *   interceptors: { workflowModules: ["ccqa-tools/coverage/temporal/workflow"] }
 *
 * or, for a pre-built bundle, pass the same specifier to
 * `bundleWorkflowCode({ workflowInterceptorModules })`.
 */

import { workflowInfo } from "@temporalio/workflow";

import { fromHeader, toHeader, type TemporalHeaders } from "./header.ts";
import { parseMark, type CoverageMark } from "../wire.ts";

/**
 * One entry per workflow execution.
 *
 * A module-level variable would leak between workflows: with `reuseV8Context`
 * (the worker default) many executions share a V8 isolate and interleave at
 * every await. Keying on `runId` gives each execution its own slot, and
 * `execute`'s `finally` removes it.
 */
const markByRunId = new Map<string, CoverageMark>();

interface WithHeaders {
  headers: TemporalHeaders;
}

type Next<I, O> = (input: I) => O;

function propagate<I extends WithHeaders>(input: I): I {
  const mark = markByRunId.get(workflowInfo().runId);
  if (mark === undefined) return input;
  return { ...input, headers: { ...input.headers, ...toHeader(mark) } };
}

export const interceptors = () => {
  const propagator = {
    async execute<I extends WithHeaders, O>(input: I, next: Next<I, Promise<O>>): Promise<O> {
      const mark = parseMark(fromHeader(input.headers));
      const { runId } = workflowInfo();
      if (mark !== undefined) markByRunId.set(runId, mark);
      try {
        return await next(input);
      } finally {
        markByRunId.delete(runId);
      }
    },
    scheduleActivity<I extends WithHeaders, O>(input: I, next: Next<I, O>): O {
      return next(propagate(input));
    },
    scheduleLocalActivity<I extends WithHeaders, O>(input: I, next: Next<I, O>): O {
      return next(propagate(input));
    },
    startChildWorkflowExecution<I extends WithHeaders, O>(input: I, next: Next<I, O>): O {
      return next(propagate(input));
    },
  };
  return { inbound: [propagator], outbound: [propagator] };
};
