/**
 * One run's answer out of a project's stored event stream (ADR-0022).
 *
 * The stream interleaves many runs and two producers; this is the single
 * shared interpretation over it — the same gate, join and loss accounting the
 * run-local sink applies, executed at read time by whichever host asks (the
 * hub's API, or the CLI). Everything here is a pure fold over the stamps the
 * events carry: no clock is ever read, so the same stream resolves to the
 * same answer on any host, at any time.
 */

import { z } from "zod";

import type { StoredEvent } from "./events.ts";
import { CoverageResolver } from "./resolver.ts";

/**
 * How far past a run's last marker an application push still counts as its
 * audience (ms). The run-local sink keeps listening while a spec settles, so
 * the work a spec's last action triggered still lands; a stored stream has no
 * listener to wait, so the resolve re-creates that patience as a fixed bound.
 * Pushes past it were heard by nobody bound to this run — most likely they
 * belong to whatever run came next.
 */
export const GRACE_MS = 30_000;

/**
 * What one run's slice of the stream resolves to. The shape is the read-out
 * API of `CoverageResolver` written down: what the coverage page needs to
 * draw, and nothing the stream cannot support.
 */
export const ResolvedCoverageSchema = z.object({
  runId: z.string(),
  /** The hub run record this measurement belongs to, once a run-link arrived. */
  hubRunId: z.string().optional(),
  /** Stamp of the last event this resolve ingested — the page's honest "as of". */
  asOf: z.number(),
  /** Stream position this answer covers; a consumer's cache keys off it. */
  lastSeq: z.number(),
  /** The denominator the run enumerated, when `coverage.include` was set. */
  universe: z.object({ include: z.array(z.string()), files: z.array(z.string()) }).optional(),
  specs: z.array(
    z.object({
      specId: z.string(),
      /** Server ∪ browser halves, sorted — the union a report row would carry. */
      files: z.array(z.string()),
      /** Per declared identity key, distinct events credited to this spec. */
      actorEvents: z.record(z.string(), z.number()),
    }),
  ),
  /** Files reached at module top level, owned by no spec. */
  boot: z.array(z.string()),
  health: z.object({
    heardFromApplication: z.boolean(),
    /**
     * Application pushes whose stamp fell inside the run's listening span,
     * credited as-is. The endpoint-misconfiguration detector: a stream can
     * hold pushes from long before the run, so if nothing arrived while it
     * was measuring this is 0 — check `CCQA_COVERAGE_ENDPOINT` on the
     * application.
     */
    pushesDuringRun: z.number(),
    attributedSpecs: z.number(),
    rejectedPushes: z.number(),
    uninstrumentedFiles: z.number(),
    uninstrumentedProcesses: z.number(),
    droppedPushes: z.number(),
    unmappedActorEvents: z.number(),
    outsideWindowEvents: z.record(z.string(), z.number()),
    specsMeasured: z.number(),
  }),
});
export type ResolvedCoverage = z.infer<typeof ResolvedCoverageSchema>;

/**
 * One read-out line for a resolved spec — shared by the run-end summary and
 * `ccqa hub coverage`, so the two never drift on how a measurement reads.
 */
export function formatResolvedSpec(spec: ResolvedCoverage["specs"][number]): string {
  const actors = Object.entries(spec.actorEvents)
    .map(([key, count]) => `${key}: ${count} event(s)`)
    .join(", ");
  return `${spec.specId}: ${spec.files.length} file(s)${actors ? ` (${actors})` : ""}`;
}

/**
 * Interprets `runId`'s view of the stream.
 *
 * Two passes, because the resolver needs its context up front: the first
 * collects what the run's own markers establish — which ids it issued, which
 * identity tags were its to hand out, its universe, and when its first and
 * last marker arrived. The second replays the stream through the shared
 * resolver: this run's window markers as they came, and every application
 * push — as-is when its stamp falls inside the span the run's sink would
 * have been listening (first marker to last marker plus `GRACE_MS`),
 * stripped of its spec and actor attribution when it does not. A push
 * outside the span was another run's audience, so its attribution is not
 * this run's to claim — but the collector never re-sends what an earlier
 * run acked, so on an always-on hub the boot set and each process's health
 * figures arrived long before this run began, and only survive here.
 */
export function resolveStream(events: StoredEvent[], runId: string): ResolvedCoverage {
  const issued = new Set<string>();
  const specOrder: string[] = [];
  const tagToKey = new Map<string, string>();
  const browserFiles = new Map<string, Set<string>>();
  let universe: { include: string[]; files: string[] } | undefined;
  let hubRunId: string | undefined;
  let firstMarkerAt: number | undefined;
  let lastMarkerAt = 0;

  for (const event of events) {
    const body = event.body;
    if (!("kind" in body) || body.runId !== runId) continue;
    if (firstMarkerAt === undefined) firstMarkerAt = event.at;
    lastMarkerAt = event.at;
    switch (body.kind) {
      case "spec-open":
        if (!issued.has(body.specId)) {
          issued.add(body.specId);
          specOrder.push(body.specId);
        }
        break;
      case "window-open":
        tagToKey.set(body.tag, body.key);
        break;
      case "universe":
        universe = { include: body.include, files: body.files };
        break;
      case "run-link":
        hubRunId = body.hubRunId;
        break;
      case "browser": {
        const files = browserFiles.get(body.specId) ?? new Set<string>();
        for (const file of body.files) files.add(file);
        browserFiles.set(body.specId, files);
        break;
      }
    }
  }

  const resolver = new CoverageResolver(issued, tagToKey);
  let asOf = 0;
  let lastSeq = 0;
  let pushesDuringRun = 0;
  for (const event of events) {
    if (event.seq > lastSeq) lastSeq = event.seq;
    const body = event.body;
    if ("kind" in body) {
      if (body.runId !== runId) continue;
      asOf = event.at;
      if (body.kind === "window-open") {
        resolver.apply({ kind: "window-open", at: event.at, tag: body.tag, key: body.key, specId: body.specId });
      } else if (body.kind === "window-close") {
        resolver.apply({ kind: "window-close", at: event.at, tag: body.tag });
      }
      continue;
    }
    if (firstMarkerAt === undefined || event.at < firstMarkerAt || event.at > lastMarkerAt + GRACE_MS) {
      // Outside the span, but not discarded: stripped of the attribution that
      // belongs to whichever run was listening, the push still testifies to
      // the boot set and the process's health — which, on an always-on hub,
      // were acked before this run began and never re-sent. `asOf` stays
      // put: these are not this run's measurement moving forward.
      resolver.apply({ kind: "push", at: event.at, push: { ...body, specs: {}, actors: [] } });
      continue;
    }
    asOf = event.at;
    pushesDuringRun++;
    resolver.apply({ kind: "push", at: event.at, push: body });
  }

  const specs = specOrder.map((specId) => {
    const actorEvents: Record<string, number> = {};
    for (const [key, count] of resolver.actorEventsFor(specId)) actorEvents[key] = count;
    return {
      specId,
      files: [...new Set([...(resolver.filesFor(specId) ?? []), ...(browserFiles.get(specId) ?? [])])].sort(),
      actorEvents,
    };
  });
  const outsideWindowEvents: Record<string, number> = {};
  for (const [key, count] of resolver.outsideWindowEvents()) outsideWindowEvents[key] = count;

  return {
    runId,
    ...(hubRunId !== undefined ? { hubRunId } : {}),
    asOf,
    lastSeq,
    ...(universe !== undefined ? { universe } : {}),
    specs,
    boot: [...resolver.boot()].sort(),
    health: {
      heardFromApplication: resolver.heardFromApplication(),
      pushesDuringRun,
      attributedSpecs: resolver.attributedSpecs(),
      rejectedPushes: resolver.rejectedPushes(),
      uninstrumentedFiles: resolver.uninstrumentedFiles(),
      uninstrumentedProcesses: resolver.uninstrumentedProcesses(),
      droppedPushes: resolver.droppedPushes(),
      unmappedActorEvents: resolver.unmappedActorEvents(),
      outsideWindowEvents,
      specsMeasured: specs.length,
    },
  };
}

/**
 * Every run that opened a spec in this stream, most recently heard-from
 * first — recency by the arrival position of each run's latest spec-open,
 * the one order the hub's stamps establish.
 */
export function listRunIds(events: StoredEvent[]): string[] {
  const lastOpenIndex = new Map<string, number>();
  events.forEach((event, index) => {
    const body = event.body;
    if ("kind" in body && body.kind === "spec-open") lastOpenIndex.set(body.runId, index);
  });
  return [...lastOpenIndex.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
