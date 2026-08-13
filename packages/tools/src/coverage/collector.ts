/**
 * Ships what this process reached to a sink, on a timer.
 *
 * Push, not pull: behind a load balancer nothing can address one replica of N,
 * so an endpoint the runner scrapes would silently report a fraction of the
 * truth. Every replica pushes instead, and the sink unions — file sets make
 * that commutative, associative and idempotent, so the sink never has to know
 * how many replicas there were.
 */

import {
  actorBucketKey,
  closeActorBucket,
  closeBucket,
  getRuntime,
  type CoverageRuntime,
} from "./core.ts";
import { debugLog, type CoverageConfig } from "./runtime-env.ts";

export interface CollectorOptions {
  endpoint: string;
  token?: string | undefined;
  intervalMs?: number;
  /** Drops a spec's bucket this long after its last change and last flush. */
  idleTtlMs?: number;
}

export interface CoveragePush {
  protocol: 1;
  pid: number;
  startedAt: number;
  unattributed: number;
  uninstrumentedFiles: number;
  uninstrumentedProcess: boolean;
  /** Only ids not yet accepted by the sink, per spec. */
  specs: Record<string, string[]>;
  boot: string[];
  /**
   * What each identity reached, and when the work was first asked for. Which
   * spec that is — if any — is the run's to decide; this side only reports.
   */
  actors: Array<{ tag: string; at: number; files: string[] }>;
  /**
   * Failed push attempts over this process's whole life, not since the last
   * ack. An application outlives the runs measuring it, and every second
   * before the first of them stood up a sink is a failure — reported as a
   * delta since the last ack, all of that arrives inside the first run and
   * reads as that run having lost 25 minutes of reports. The sink subtracts
   * what a process had already dropped when it first heard from it.
   */
  droppedPushes: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_TTL_MS = 120_000;
/**
 * How many times the exit-time flush may run. More than one because a push the
 * timer started may still be in flight when the first one fires, and that one
 * returns without sending anything.
 */
const MAX_EXIT_FLUSHES = 3;
/**
 * How often a process that instrumented nothing re-announces itself when it has
 * nothing else to send.
 *
 * It has no files and no attributions to report, so the delta it pushes is
 * empty forever after the first success — and the run that heard it is over.
 * Without this, every later run against the same process is told nothing
 * reported at all, rather than that one process is blind.
 */
const BLIND_HEARTBEAT_MS = 30_000;

/** What survives between ticks: ack state plus the counters it gates on. */
export interface CollectorState {
  /** Per spec, ids the sink has acknowledged. */
  sent: Map<string, Set<string>>;
  sentBoot: Set<string>;
  /** Per identity bucket, ids the sink has acknowledged. */
  sentActors: Map<string, Set<string>>;
  /** Per bucket key (spec id or identity bucket), when it last gained a fresh id. */
  lastChange: Map<string, number>;
  /** `unattributed` as of the last push the sink acknowledged. */
  lastSentUnattributed: number;
  /** The two instrumentation-health figures as of that same push. */
  lastSentUninstrumentedFiles: number;
  lastSentUninstrumentedProcess: boolean;
  /** When the last payload was built, for the blind-process heartbeat. */
  lastSentAt: number;
  /** Lifetime failed attempts. Never reset; the sink baselines it instead. */
  droppedPushes: number;
}

export function createCollectorState(): CollectorState {
  return {
    sent: new Map(),
    sentBoot: new Set(),
    sentActors: new Map(),
    lastChange: new Map(),
    lastSentUnattributed: 0,
    lastSentUninstrumentedFiles: 0,
    lastSentUninstrumentedProcess: false,
    lastSentAt: 0,
    droppedPushes: 0,
  };
}

export function startCollector(
  options: CollectorOptions,
  config?: CoverageConfig,
): () => void {
  const runtime = getRuntime();
  if (runtime === undefined) return () => {};

  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const state = createCollectorState();
  let inFlight = false;
  let consecutiveFailures = 0;

  const flush = (): Promise<void> => {
    if (inFlight) return Promise.resolve();
    evict(runtime, state, idleTtlMs);
    const payload = diff(runtime, state);
    if (payload === undefined) return Promise.resolve();
    inFlight = true;
    return post(options, payload)
      .then(() => {
        for (const [specId, files] of Object.entries(payload.specs)) {
          const acked = state.sent.get(specId) ?? new Set<string>();
          for (const file of files) acked.add(file);
          state.sent.set(specId, acked);
        }
        for (const file of payload.boot) state.sentBoot.add(file);
        for (const bucket of payload.actors) {
          const key = actorBucketKey(bucket.tag, bucket.at);
          const acked = state.sentActors.get(key) ?? new Set<string>();
          for (const file of bucket.files) acked.add(file);
          state.sentActors.set(key, acked);
        }
        state.lastSentUnattributed = payload.unattributed;
        state.lastSentUninstrumentedFiles = payload.uninstrumentedFiles;
        state.lastSentUninstrumentedProcess = payload.uninstrumentedProcess;
        consecutiveFailures = 0;
      })
      .catch((error: unknown) => {
        // Nothing is marked sent, so the next tick retries the same delta.
        state.droppedPushes++;
        consecutiveFailures++;
        if (config) debugLog(config, `push failed: ${String(error)}`);
        // Visible without CCQA_COVERAGE_DEBUG: a sink nobody can reach is not
        // a debug-only concern, and throttling keeps a dead sink from
        // flooding stderr once a second for the life of the process.
        if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
          process.stderr.write(
            `[ccqa-tools] push to ${options.endpoint} failed ${consecutiveFailures} times in a row: ${String(error)}\n`,
          );
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(() => void flush(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();

  // A spec-dedicated worker (CCQA_COVERAGE=<runId>.<specId>) can exit inside
  // one tick of starting, with what it reached never pushed. `beforeExit`
  // listeners may be async: awaiting the push here keeps the loop alive until
  // it settles, and Node re-emits the event once it does, so this fires again
  // and exits clean as soon as there is nothing left outstanding.
  //
  // Bounded, because "nothing left outstanding" is only reachable when pushes
  // land. A sink that cannot be reached acks nothing, so the same delta is
  // rebuilt every time — and each attempt re-arms the loop, so the process
  // would never exit and would spin on connect attempts while it did not.
  let exitFlushes = 0;
  const onBeforeExit = async (): Promise<void> => {
    if (consecutiveFailures > 0 || exitFlushes >= MAX_EXIT_FLUSHES) return;
    exitFlushes++;
    await flush();
  };
  process.on("beforeExit", onBeforeExit);

  return () => {
    clearInterval(timer);
    process.off("beforeExit", onBeforeExit);
  };
}

/**
 * `acked` is always a subset of `reached`, and neither ever shrinks, so equal
 * sizes mean nothing new — skip the copy-then-filter and check that first.
 */
function freshOf(reached: Set<string>, acked: Set<string> | undefined): string[] {
  if (acked !== undefined && acked.size === reached.size) return [];
  const fresh: string[] = [];
  for (const file of reached) {
    if (acked === undefined || !acked.has(file)) fresh.push(file);
  }
  return fresh;
}

/** Exported for tests: the sink's HTTP round trip is the only real-I/O part. */
export function diff(runtime: CoverageRuntime, state: CollectorState): CoveragePush | undefined {
  const specs: Record<string, string[]> = {};
  let any = false;
  const now = Date.now();
  for (const [specId, files] of runtime.buckets) {
    const fresh = freshOf(files, state.sent.get(specId));
    if (fresh.length === 0) continue;
    specs[specId] = fresh;
    state.lastChange.set(specId, now);
    any = true;
  }
  const actors: CoveragePush["actors"] = [];
  for (const [key, bucket] of runtime.actors) {
    const fresh = freshOf(bucket.files, state.sentActors.get(key));
    if (fresh.length === 0) continue;
    actors.push({ tag: bucket.tag, at: bucket.at, files: fresh });
    state.lastChange.set(key, now);
  }
  const boot = freshOf(runtime.boot, state.sentBoot);
  // `unattributed` rides along on a file push, but a spec whose files already
  // converged would otherwise stop reporting it entirely — the sink's next
  // baseline would then be whatever was last sent, and a later spec inherits
  // the gap that accrued in between. A bare change is worth a push on its own.
  const unattributedChanged = runtime.unattributed !== state.lastSentUnattributed;
  // A process that instrumented nothing has nothing else to say: no files, no
  // boot set, and `record` never runs so `unattributed` stays zero. Gating on
  // the other three alone left the one counter that reports total failure
  // unable to leave the process that suffered it.
  const healthChanged =
    runtime.uninstrumentedFiles !== state.lastSentUninstrumentedFiles ||
    runtime.uninstrumentedProcess !== state.lastSentUninstrumentedProcess;
  // A blind process has nothing else it could ever send, so once it has said so
  // it goes silent — and the next run is told no process reported at all.
  const reannounce =
    runtime.uninstrumentedProcess && now - state.lastSentAt >= BLIND_HEARTBEAT_MS;
  if (
    !any &&
    boot.length === 0 &&
    actors.length === 0 &&
    !unattributedChanged &&
    !healthChanged &&
    !reannounce
  ) {
    return undefined;
  }
  state.lastSentAt = now;
  return {
    protocol: 1,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    unattributed: runtime.unattributed,
    uninstrumentedFiles: runtime.uninstrumentedFiles,
    uninstrumentedProcess: runtime.uninstrumentedProcess,
    specs,
    boot,
    actors,
    droppedPushes: state.droppedPushes,
  };
}

/**
 * Forgets specs that stopped changing and have nothing outstanding, so a long
 * lived server does not accumulate every spec it has ever served — and so the
 * hot-path gate falls back to zero between runs.
 */
export function evict(runtime: CoverageRuntime, state: CollectorState, idleTtlMs: number): void {
  const now = Date.now();
  const cutoff = now - idleTtlMs;
  const actors = [...runtime.actors].map(([key, bucket]) => [key, bucket.files] as const);
  // Identity buckets keep the same window as spec ones. A shorter one looked
  // like a way to stop other people's traffic holding the gate open, but it
  // bought nothing on a busy environment and cost the late in-process tail the
  // whole mechanism exists to catch.
  dropQuiet([...runtime.buckets], state.sent, state, cutoff, now, (key) => closeBucket(runtime, key));
  dropQuiet(actors, state.sentActors, state, cutoff, now, (key) => closeActorBucket(runtime, key));
}

function dropQuiet(
  entries: readonly (readonly [string, Set<string>])[],
  sent: Map<string, Set<string>>,
  state: CollectorState,
  cutoff: number,
  now: number,
  close: (key: string) => void,
): void {
  for (const [key, files] of entries) {
    const seen = state.lastChange.get(key);
    // First sighting: the bucket may hold files this tick has not diffed yet,
    // and dropping it would discard them — and, if it was the only one open,
    // close the hot-path gate for the whole process.
    if (seen === undefined) {
      state.lastChange.set(key, now);
      continue;
    }
    if (seen > cutoff) continue;
    // Went quiet, but the sink has not acked everything in it yet — keep it
    // rather than dropping files that were never actually sent.
    if (freshOf(files, sent.get(key)).length > 0) continue;
    close(key);
    sent.delete(key);
    state.lastChange.delete(key);
  }
}

async function post(options: CollectorOptions, payload: CoveragePush): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    // Without a bound, one hung request pins `inFlight` and every later tick
    // is dropped by the `if (inFlight) return` guard — silence with no way
    // back. `.finally` already always clears it; a timeout just makes sure
    // the promise it is waiting on eventually settles.
    signal: AbortSignal.timeout(intervalMs * 5),
  });
  if (!response.ok) throw new Error(`sink returned ${response.status}`);
}
