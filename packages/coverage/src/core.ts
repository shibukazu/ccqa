/**
 * The hot path, and the only module instrumented application code imports.
 *
 * It has **no imports at all**, on purpose. Bundlers pull this file into every
 * layer they build — a Next.js RSC bundle, an SSR bundle, a route-handler
 * bundle, a Temporal workflow sandbox — and each of those rejects a different
 * subset of Node built-ins. `node:http` alone is enough to fail a Next.js
 * webpack build outright. Everything platform-specific lives behind
 * `ccqa-coverage/register`, which only ever loads in real Node.
 *
 * For the same reason the process-wide state hangs off `globalThis` rather than
 * module scope: a bundler produces several copies of this file per process, and
 * a per-copy AsyncLocalStorage would shard attribution across them.
 */

/** The slice of AsyncLocalStorage this package needs, minus the import. */
export interface ContextStorage<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

/**
 * What one in-flight execution carries.
 *
 * Exactly one of the two says where its reach goes. `specId` is set when the
 * request itself named a spec. `actor` is set when nothing did, and all that is
 * known is who caused the work and when it was first asked for — enough for the
 * run to decide later, and nothing this process could decide on its own.
 */
export interface CoverageStore {
  specId?: string;
  actor?: ActorMark;
  files: Set<string>;
}

/** Who caused a request, and the instant it arrived. Never interpreted here. */
export interface ActorMark {
  tag: string;
  at: number;
}

/** One identity's reach from one instant, as the collector ships it. */
export interface ActorBucket {
  tag: string;
  at: number;
  files: Set<string>;
}

export interface CoverageRuntime {
  /**
   * Shape version of this object. Two builds of `ccqa-coverage` can end up in
   * one process (an app dependency and a hoisted transitive one); the first to
   * install wins and the rest defer to it, so the shape has to be recognisable.
   */
  readonly protocol: 1;
  readonly als: ContextStorage<CoverageStore>;
  /** specId -> reached file ids. Union is idempotent, so merging is free. */
  readonly buckets: Map<string, Set<string>>;
  /**
   * `<tag> <at>` -> what that identity reached from that instant.
   *
   * Kept apart from `buckets` because nothing here knows which spec they belong
   * to — or whether they belong to one at all. Most of them are other people
   * using the same environment, and the run discards those.
   */
  readonly actors: Map<string, ActorBucket>;
  /**
   * Files reached at module top level. Kept out of the spec buckets because the
   * first spec to import a module would otherwise own it, making the result
   * depend on spec execution order.
   */
  readonly boot: Set<string>;
  /**
   * Number of open buckets, spec and identity alike. `record()` returns on zero
   * before touching anything else — the reason instrumentation costs nothing
   * while nothing is being measured, and the reason this package does not need
   * sampling. A field rather than a `.size` sum because this check is the hot
   * path itself.
   *
   * An identity bucket arms it the same way a spec does, so an application with
   * the actor preset installed pays while any identity has acted recently, not
   * only while a spec is running. That is the price of the application not
   * being told which identities matter.
   */
  active: number;
  /**
   * Executions that ran while a spec was open but outside its async context.
   * A silent gap here would read as "never reached", so it is always counted.
   */
  unattributed: number;
  /**
   * Files a load hook saw but could not turn into recorded coverage — an
   * undecodable source, or a parse error. Uncounted, this would render
   * identically to "reached by no spec", which is a lie.
   */
  uninstrumentedFiles: number;
  /**
   * Set when nothing in this process can be instrumented at all, so every file
   * it runs is missing rather than some of them.
   *
   * A flag and not a count, because the failure is the process: counted as one
   * file it reads as a rounding error next to the thousands it actually hides.
   */
  uninstrumentedProcess: boolean;
  readonly pid: number;
  readonly startedAt: number;
}

const RUNTIME_KEY = Symbol.for("ccqa.coverage.runtime");

/** The name instrumented code calls through. Kept short; it appears per module. */
export const GLOBAL_RECORD = "__ccqaCoverage";

interface GlobalWithRuntime {
  [RUNTIME_KEY]?: CoverageRuntime;
  [GLOBAL_RECORD]?: typeof record;
}

function globals(): GlobalWithRuntime {
  return globalThis as unknown as GlobalWithRuntime;
}

export function getRuntime(): CoverageRuntime | undefined {
  return globals()[RUNTIME_KEY];
}

/**
 * Memoized so the hot path skips the `globalThis` read. `installRuntime`
 * primes it and never replaces an installed runtime, so once set it never
 * goes stale — but it must stay undefined (and keep re-reading `globalThis`)
 * until then, or a module that finished loading before `register` installs
 * the runtime would be stuck uninstrumented for the rest of the process.
 */
let cachedRuntime: CoverageRuntime | undefined;

function runtime(): CoverageRuntime | undefined {
  if (cachedRuntime === undefined) cachedRuntime = globals()[RUNTIME_KEY];
  return cachedRuntime;
}

/**
 * Installs the process-wide runtime, or returns the one already there.
 * Called by `ccqa-coverage/register`; application code never calls it.
 */
export function installRuntime(als: ContextStorage<CoverageStore>): CoverageRuntime {
  const g = globals();
  const existing = g[RUNTIME_KEY];
  if (existing) {
    cachedRuntime = existing;
    return existing;
  }
  const created: CoverageRuntime = {
    protocol: 1,
    als,
    buckets: new Map(),
    actors: new Map(),
    boot: new Set(),
    active: 0,
    unattributed: 0,
    uninstrumentedFiles: 0,
    uninstrumentedProcess: false,
    pid: typeof process === "undefined" ? -1 : process.pid,
    startedAt: Date.now(),
  };
  g[RUNTIME_KEY] = created;
  g[GLOBAL_RECORD] = record;
  cachedRuntime = created;
  return created;
}

/**
 * Marks a file as reached. Instrumented code calls this through
 * `globalThis.__ccqaCoverage`, so the call sites cost one global read per
 * module and one truthiness check per invocation when coverage is off.
 *
 * @param topLevel set by the prologue a module runs on first import.
 */
export function record(fileId: string, topLevel?: boolean): void {
  const rt = runtime();
  if (rt === undefined) return;
  if (topLevel === true) {
    // Not gated on `active`: a module body runs once, so there is no hot path
    // to protect, and most modules are imported before the first spec ever
    // starts. Gating it would leave this set permanently empty.
    rt.boot.add(fileId);
    return;
  }
  if (rt.active === 0) return;
  const store = rt.als.getStore();
  if (store === undefined) {
    rt.unattributed++;
    return;
  }
  store.files.add(fileId);
}

/** The spec the current async context belongs to, if any. */
export function currentSpecId(): string | undefined {
  return runtime()?.als.getStore()?.specId;
}

/**
 * Opens `specId`'s bucket and runs `fn` inside its context. Every entry point —
 * HTTP, Temporal activity, manual — funnels through here.
 *
 * The bucket outlives `fn`: work a request schedules and does not await still
 * belongs to the spec that caused it.
 */
export function runInSpec<R>(specId: string, fn: () => R): R {
  const rt = runtime();
  if (rt === undefined) return fn();
  return rt.als.run({ specId, files: openBucket(rt, specId) }, fn);
}

/**
 * Records that `tag` caused this work at `at`, without deciding whose it is.
 *
 * Carrier wins: a request that already named a spec needs no identity, and
 * overwriting it would replace a fact with something the run still has to
 * interpret. Everything else is recorded whoever it came from — the application
 * is never told which identities are being measured, so it cannot filter, and
 * the run discards the ones it did not ask for.
 */
export function runAsActor<R>(tag: string, at: number, fn: () => R): R {
  const rt = runtime();
  if (rt === undefined) return fn();
  const store = rt.als.getStore();
  if (store?.specId !== undefined) return fn();
  return rt.als.run({ actor: { tag, at }, files: openActorBucket(rt, tag, at) }, fn);
}

/** The identity mark on the current async context, if it has one. */
export function currentActor(): ActorMark | undefined {
  return runtime()?.als.getStore()?.actor;
}

/** Returns `specId`'s file set, creating it — and arming the gate — if new. */
export function openBucket(runtime: CoverageRuntime, specId: string): Set<string> {
  let files = runtime.buckets.get(specId);
  if (files === undefined) {
    files = new Set<string>();
    runtime.buckets.set(specId, files);
    armGate(runtime);
  }
  return files;
}

/**
 * The key both halves of the collector agree on. A space separates them safely:
 * a spec id can never contain one, so identity keys and spec ids stay disjoint
 * where the collector tracks both in one map.
 */
export function actorBucketKey(tag: string, at: number): string {
  return `${tag} ${at}`;
}

/** Returns the identity's file set for that instant, creating it if new. */
export function openActorBucket(runtime: CoverageRuntime, tag: string, at: number): Set<string> {
  const key = actorBucketKey(tag, at);
  let bucket = runtime.actors.get(key);
  if (bucket === undefined) {
    bucket = { tag, at, files: new Set<string>() };
    runtime.actors.set(key, bucket);
    armGate(runtime);
  }
  return bucket.files;
}

/** Drops a spec's bucket once it has been handed to the collector. */
export function closeBucket(runtime: CoverageRuntime, specId: string): void {
  if (runtime.buckets.delete(specId)) armGate(runtime);
}

/** Drops an identity's bucket once it has been handed to the collector. */
export function closeActorBucket(runtime: CoverageRuntime, key: string): void {
  if (runtime.actors.delete(key)) armGate(runtime);
}

function armGate(runtime: CoverageRuntime): void {
  runtime.active = runtime.buckets.size + runtime.actors.size;
}
