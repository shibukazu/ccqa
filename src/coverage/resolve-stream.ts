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
 * `runId`'s view of the stream, built one event at a time.
 *
 * Two passes, because the resolver needs its context up front. The first
 * collects what the run's own markers establish — which ids it issued, which
 * identity tags were its to hand out, its universe, and when its first and
 * last marker arrived; markers are a small part of a stream, so a caller can
 * hold them. The second replays the stream through the shared resolver: this
 * run's window markers as they came, and every application push — as-is when
 * its stamp falls inside the span the run's sink would have been listening
 * (first marker to last marker plus `GRACE_MS`), stripped of its spec and
 * actor attribution when it does not. A push outside the span was another
 * run's audience, so its attribution is not this run's to claim — but the
 * collector never re-sends what an earlier run acked, so on an always-on hub
 * the boot set and each process's health figures arrived long before this run
 * began, and only survive here.
 *
 * The constructor takes the markers and `accept` takes one event at a time, so
 * the second pass can be fed from a stream: it keeps nothing per push, which
 * is what lets a resolve outlive the point where the stream stops fitting in
 * memory.
 */
export class StreamResolution {
  private readonly runId: string;
  private readonly resolver: CoverageResolver;
  /** The ids this run opened, in that order — a `Set` iterates by insertion. */
  private readonly specIds: ReadonlySet<string>;
  private readonly browserFiles = new Map<string, Set<string>>();
  /**
   * The stamps in which the run's sink would have been listening. Undefined
   * when the markers held no event of this run — then no push is ever inside.
   */
  private readonly span: { from: number; until: number } | undefined;
  private universe: { include: string[]; files: string[] } | undefined;
  private hubRunId: string | undefined;
  private asOf = 0;
  private lastSeq = 0;
  private pushesDuringRun = 0;

  /** `markers` needs to hold every marker event of the stream; pushes are ignored here. */
  // `runId` is assigned in the body, not declared as a parameter: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  constructor(markers: Iterable<StoredEvent>, runId: string) {
    this.runId = runId;
    const specIds = new Set<string>();
    const tagToKey = new Map<string, string>();
    let firstAt: number | undefined;
    let lastAt = 0;

    for (const event of markers) {
      const body = event.body;
      if (!("kind" in body) || body.runId !== runId) continue;
      if (firstAt === undefined) firstAt = event.at;
      lastAt = event.at;
      switch (body.kind) {
        case "spec-open":
          specIds.add(body.specId);
          break;
        case "window-open":
          tagToKey.set(body.tag, body.key);
          break;
        case "universe":
          this.universe = { include: body.include, files: body.files };
          break;
        case "run-link":
          this.hubRunId = body.hubRunId;
          break;
        case "browser": {
          const files = this.browserFiles.get(body.specId) ?? new Set<string>();
          for (const file of body.files) files.add(file);
          this.browserFiles.set(body.specId, files);
          break;
        }
      }
    }

    this.specIds = specIds;
    this.span = firstAt === undefined ? undefined : { from: firstAt, until: lastAt + GRACE_MS };
    this.resolver = new CoverageResolver(specIds, tagToKey);
  }

  /** One event of the second pass. Every event of the stream, in stamp order. */
  accept(event: StoredEvent): void {
    if (event.seq > this.lastSeq) this.lastSeq = event.seq;
    const body = event.body;
    if ("kind" in body) {
      if (body.runId !== this.runId) return;
      this.asOf = event.at;
      if (body.kind === "window-open") {
        this.resolver.apply({ kind: "window-open", at: event.at, tag: body.tag, key: body.key, specId: body.specId });
      } else if (body.kind === "window-close") {
        this.resolver.apply({ kind: "window-close", at: event.at, tag: body.tag });
      }
      return;
    }
    if (this.span === undefined || event.at < this.span.from || event.at > this.span.until) {
      // Outside the span, but not discarded: stripped of the attribution that
      // belongs to whichever run was listening, the push still testifies to
      // the boot set and the process's health — which, on an always-on hub,
      // were acked before this run began and never re-sent. `asOf` stays
      // put: these are not this run's measurement moving forward.
      this.resolver.apply({ kind: "push", at: event.at, push: { ...body, specs: {}, actors: [] } });
      return;
    }
    this.asOf = event.at;
    this.pushesDuringRun++;
    this.resolver.apply({ kind: "push", at: event.at, push: body });
  }

  /** The answer as of every event accepted so far. */
  finish(): ResolvedCoverage {
    const specs = [...this.specIds].map((specId) => {
      const actorEvents: Record<string, number> = {};
      for (const [key, count] of this.resolver.actorEventsFor(specId)) actorEvents[key] = count;
      return {
        specId,
        files: [
          ...new Set([...(this.resolver.filesFor(specId) ?? []), ...(this.browserFiles.get(specId) ?? [])]),
        ].sort(),
        actorEvents,
      };
    });
    const outsideWindowEvents: Record<string, number> = {};
    for (const [key, count] of this.resolver.outsideWindowEvents()) outsideWindowEvents[key] = count;

    return {
      runId: this.runId,
      ...(this.hubRunId !== undefined ? { hubRunId: this.hubRunId } : {}),
      asOf: this.asOf,
      lastSeq: this.lastSeq,
      ...(this.universe !== undefined ? { universe: this.universe } : {}),
      specs,
      boot: [...this.resolver.boot()].sort(),
      health: {
        heardFromApplication: this.resolver.heardFromApplication(),
        pushesDuringRun: this.pushesDuringRun,
        attributedSpecs: this.resolver.attributedSpecs(),
        rejectedPushes: this.resolver.rejectedPushes(),
        uninstrumentedFiles: this.resolver.uninstrumentedFiles(),
        uninstrumentedProcesses: this.resolver.uninstrumentedProcesses(),
        droppedPushes: this.resolver.droppedPushes(),
        unmappedActorEvents: this.resolver.unmappedActorEvents(),
        outsideWindowEvents,
        specsMeasured: specs.length,
      },
    };
  }
}

/** `StreamResolution` over a stream already in hand. */
export function resolveStream(events: StoredEvent[], runId: string): ResolvedCoverage {
  const resolution = new StreamResolution(events, runId);
  for (const event of events) resolution.accept(event);
  return resolution.finish();
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
