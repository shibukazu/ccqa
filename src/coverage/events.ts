import { z } from "zod";

import { PushSchema } from "./resolver.ts";

/**
 * The wire and storage shapes of the coverage event stream (ADR-0022).
 *
 * Two producers write it. The instrumented application posts the same push
 * body it has always posted — the inbox recognises it by its `protocol`
 * field, so a collector already deployed keeps working unchanged. The run
 * posts explicit run events: its markers, its browser half, its universe.
 * The hub stores either under a stamp `{seq, at}` and never looks inside;
 * interpretation happens at read time (resolver.ts).
 *
 * Every run event carries `runId` because one project's stream interleaves
 * many runs: the markers are what bound one run's view of the stream, so
 * they must say whose they are.
 */

export const RunEventSchema = z.discriminatedUnion("kind", [
  /** A spec's measurement opened; its id is now issued. */
  z.object({ kind: z.literal("spec-open"), runId: z.string(), specId: z.string() }),
  z.object({ kind: z.literal("spec-close"), runId: z.string(), specId: z.string() }),
  /** `specId` holds `tag`'s turn from now until the matching close. */
  z.object({
    kind: z.literal("window-open"),
    runId: z.string(),
    tag: z.string(),
    key: z.string(),
    specId: z.string(),
  }),
  z.object({ kind: z.literal("window-close"), runId: z.string(), tag: z.string() }),
  /** The browser half of one spec, resolved from V8's counters by the run. */
  z.object({
    kind: z.literal("browser"),
    runId: z.string(),
    specId: z.string(),
    files: z.array(z.string()),
  }),
  /** The denominator, enumerated by the run from its checkout (universe.ts). */
  z.object({
    kind: z.literal("universe"),
    runId: z.string(),
    include: z.array(z.string()),
    files: z.array(z.string()),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * What one POST to the inbox may carry: an application push (recognised by
 * `protocol`) or a run event (recognised by `kind`). Checked in this order —
 * the push shape has no `kind` and a run event has no `protocol`.
 */
export const InboxBodySchema = z.union([PushSchema, RunEventSchema]);

/** One stored line: the hub's stamp around whichever body arrived. */
export const StoredEventSchema = z.object({
  /** Position in the project's stream; the resolve cache keys off the last one. */
  seq: z.number(),
  /** The hub's receive stamp — the single clock every join reads (ADR-0022). */
  at: z.number(),
  body: InboxBodySchema,
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;
