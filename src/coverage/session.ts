/**
 * One run's coverage measurement: the sink the application pushes to, the
 * acquisition engine each spec's browser is armed with, and the merge of what
 * both sides reported into a report row.
 *
 * The two sides never talk to each other. The browser writes what it reached
 * into the spec's coverage directory; instrumented server processes push what
 * they reached here. They meet on the spec id the cookie carried between them.
 */

import { access, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { ACTOR_DRAIN_MS, NO_ACTORS, type ActorPlan } from "./actors.ts";
import type { CoverageConfig } from "../config/project-config.ts";
import type { ReportCoverage } from "../report/schema.ts";
import type { CoverageCollector } from "../targets/types.ts";
import { resolveEnvRefs } from "../runtime/env-vars.ts";
import { specKey, type SpecRef } from "../store/index.ts";
import { errMessage } from "../run/errors.ts";
import * as log from "../cli/logger.ts";
import { CoverageSink } from "./sink.ts";
import type { RunEventInbox } from "./inbox.ts";
import { startBrowserCoverage, type BrowserCoverageHandle } from "./browser/engine.ts";
import { enumerateUniverse, type CoverageUniverse } from "./universe.ts";
import { FRONTEND_COVERAGE_FILE, type FrontendCoverage } from "./contract.ts";

/**
 * The application pushes on a timer, so the last second of a spec is still in
 * flight when its test returns — and the tail of a spec is where the work it
 * triggered asynchronously lands.
 */
const SETTLE_POLL_MS = 250;
// Comfortably past the application's own 1s push interval: at exactly one
// interval, whether the last push lands before the window closes is a coin flip
// and the spec's file set becomes flaky.
const SETTLE_QUIET_POLLS = 10;
const SETTLE_CAP_MS = 10_000;

export interface CoverageSessionOptions {
  runId: string;
  /** Directory ccqa runs in. `coverage.projectRoot` is resolved against it. */
  cwd: string;
  config: CoverageConfig;
  /** Every spec this run may execute; the sink refuses ids outside this set. */
  specs: readonly SpecRef[];
  /** Identities whose turns this run hands out. Empty unless the config declares any. */
  actors?: ActorPlan;
  /**
   * Set by `--coverage-inbox hub`: no local sink is bound, the run appends its
   * facts here instead, and report rows carry no coverage (ADR-0022).
   */
  inbox?: RunEventInbox;
}

export class CoverageSession {
  private readonly existing = new Map<string, boolean>();

  /**
   * Undefined in hub mode: nothing binds on the runner, and every read-side
   * answer here stays empty — interpretation lives in the hub's resolve
   * (ADR-0022).
   */
  private readonly sink: CoverageSink | undefined;
  private readonly inbox: RunEventInbox | undefined;
  /**
   * Hub mode's stand-in for the sink's window log: when each identity's turn
   * last closed, on this process's clock, which is all the drain scheduling
   * ever compared against.
   */
  private readonly windowClosedAt = new Map<string, number>();
  private readonly runId: string;
  /** What reported paths are relative to, and what they are checked against. */
  private readonly root: string;
  /** Where ccqa runs — the engine's base for resolving bundler-relative paths. */
  private readonly cwd: string;
  private readonly actors: ActorPlan;
  readonly origins: readonly string[];
  /**
   * The denominator, enumerated once at start, or undefined when
   * `coverage.include` is unset — and always in hub mode, where it travels as
   * a `universe` event instead of riding the report envelope.
   */
  readonly universe: CoverageUniverse | undefined;

  // Assigned in the body rather than declared as parameters: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  private constructor(
    sink: CoverageSink | undefined,
    inbox: RunEventInbox | undefined,
    runId: string,
    root: string,
    cwd: string,
    actors: ActorPlan,
    origins: readonly string[],
    universe: CoverageUniverse | undefined,
  ) {
    this.sink = sink;
    this.inbox = inbox;
    this.runId = runId;
    this.root = root;
    this.cwd = cwd;
    this.actors = actors;
    this.origins = origins;
    this.universe = universe;
  }

  static async start(options: CoverageSessionOptions): Promise<CoverageSession> {
    const origins = options.config.instrumentedOrigins.map((origin) => resolveEnvRefs(origin));
    const unresolved = origins.filter((origin) => !/^https?:\/\//i.test(origin));
    if (unresolved.length > 0) {
      throw new Error(
        `coverage.instrumentedOrigins must be absolute http(s) URLs after variable substitution; got ${unresolved.join(", ")}`,
      );
    }
    const actors = options.actors ?? NO_ACTORS;
    let sink: CoverageSink | undefined;
    if (options.inbox === undefined) {
      const bind = new URL(resolveEnvRefs(options.config.sink));
      const issued = new Set(options.specs.map((spec) => specIdFor(options.runId, spec)));
      sink = await CoverageSink.start(
        bind.hostname,
        bind.port === "" ? 80 : Number(bind.port),
        issued,
        actors.tagToKey,
      );
    }
    const declaredRoot = await resolveRoot(options.cwd, options.config.projectRoot);
    const root = declaredRoot ?? options.cwd;
    // Enumerated at start, not at close: the envelope that carries it is built
    // before the first spec runs (the incremental report), and the tree cannot
    // change mid-run — the run owns this checkout for its duration.
    const universe =
      options.config.include === undefined
        ? undefined
        : await enumerateUniverse(root, options.config.include, (text) => log.warn(text));
    if (options.inbox !== undefined && universe !== undefined) {
      await options.inbox.append({
        kind: "universe",
        runId: options.runId,
        include: [...universe.include],
        files: [...universe.files],
      });
    }
    return new CoverageSession(
      sink,
      options.inbox,
      options.runId,
      root,
      options.cwd,
      actors,
      origins,
      // Streamed above rather than exposed: in hub mode the envelope must not
      // carry it — the stream is the record.
      options.inbox === undefined ? universe : undefined,
    );
  }

  /**
   * Ties the stream's run id to the hub's run record. The session starts
   * before the hub assigns that id, so the link is appended once it exists;
   * local mode has no stream to link.
   */
  async linkHubRun(hubRunId: string): Promise<void> {
    if (this.inbox === undefined) return;
    await this.inbox.append({ kind: "run-link", runId: this.runId, hubRunId });
  }

  /** Where the local sink listens. Hub mode binds nothing, so there is no URL. */
  get sinkUrl(): string {
    return this.sink?.url ?? "";
  }

  /** The id this run's events carry in the stream — what a hub resolve is asked for. */
  get streamRunId(): string {
    return this.runId;
  }

  /**
   * True in hub mode: the facts leave as a stream, rows carry no coverage,
   * and the run-side health read-outs below answer empty. The one mode flag
   * callers should consult, so the answer cannot drift from what `start`
   * actually wired.
   */
  get streamsToHub(): boolean {
    return this.inbox !== undefined;
  }

  /**
   * Opens the spec's measurement.
   *
   * Waits out the drain first, when the spec acts as an identity another spec
   * just finished acting as: the two clocks involved make an event near the
   * boundary ambiguous, and a quiet gap is the only thing that resolves it
   * without either side having to trust the other's time.
   */
  async beginSpec(ref: SpecRef): Promise<void> {
    const specId = specIdFor(this.runId, ref);
    if (this.inbox !== undefined) {
      await this.inbox.append({ kind: "spec-open", runId: this.runId, specId });
    }
    for (const window of this.actors.windowsForSpec.get(specKey(ref)) ?? []) {
      // The drain is a pause this process schedules, so it compares its own
      // stamps in either mode — only the interpretation moved to the hub.
      const closedAt =
        this.inbox === undefined
          ? this.sink!.lastClosedAt(window.tag)
          : this.windowClosedAt.get(window.tag);
      const wait = closedAt === undefined ? 0 : closedAt + ACTOR_DRAIN_MS - Date.now();
      if (wait > 0) {
        log.meta("coverage", `waiting ${Math.ceil(wait / 1000)}s for ${window.key} to go quiet`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (this.inbox === undefined) {
        this.sink!.openWindow(window, specId);
      } else {
        await this.inbox.append({
          kind: "window-open",
          runId: this.runId,
          tag: window.tag,
          key: window.key,
          specId,
        });
      }
    }
  }

  /**
   * Attaches the acquisition engine to the browser the spec's target drives.
   * Everything spec-specific the engine needs — the id, the cookie's
   * destinations, the roots — lives here, so the caller only supplies where
   * the browser is.
   */
  armBrowser(ref: SpecRef, cdpUrl: string, coverageDir: string): Promise<BrowserCoverageHandle> {
    return startBrowserCoverage({
      cdpUrl,
      specId: specIdFor(this.runId, ref),
      origins: this.origins,
      coverageDir,
      roots: { base: this.cwd, root: this.root },
      warn: (text) => log.warn(`coverage: ${text}`),
    });
  }

  /**
   * Merges both sides once the spec's pushes have stopped arriving.
   *
   * In hub mode there is nothing to merge: the run appends what it alone can
   * state — its markers and the browser half — and resolves nothing, so the
   * row gets no coverage. There is no settle either: settling existed to read
   * a complete file set before the row was written, and late pushes land on
   * the hub whenever they arrive, attributed by the spec id they carry.
   */
  async collect(ref: SpecRef, coverageDir: string): Promise<ReportCoverage | undefined> {
    const specId = specIdFor(this.runId, ref);
    if (this.inbox !== undefined) {
      await this.streamSpecClose(this.inbox, ref, specId, coverageDir);
      return undefined;
    }
    const sink = this.sink!;
    await this.settle(specId);
    // Closed only now: the work a spec's last action triggers arrives after the
    // test process is gone, and settle is what waits for it.
    const owned = this.actors.windowsForSpec.get(specKey(ref)) ?? [];
    for (const window of owned) sink.closeWindow(window.tag);
    const matched = sink.actorEventsFor(specId);
    const backend = sink.filesFor(specId);
    const frontend = await readFrontend(coverageDir, specId);
    // Only the browser half is checked against the working tree. Its paths come
    // out of source maps, which also describe the framework's own build output;
    // the server half is already confined to the directories the application
    // was told to instrument.
    const inProject = await this.keepExisting(frontend?.files ?? []);
    const files = new Set<string>([...(backend ?? []), ...inProject]);
    return {
      files: [...files].sort(),
      frontendFiles: inProject.length,
      backendFiles: backend?.size ?? 0,
      backendReported: sink.heardFromApplication(),
      frontendReported: frontend !== undefined,
      frontendStopped: frontend?.stopped ?? false,
      // Listed even at zero: a declared window that matched nothing is the
      // whole failure, and omitting it would leave the row looking ordinary.
      actorWindows: owned.map((window) => ({
        key: window.key,
        events: matched.get(window.key) ?? 0,
      })),
      excludedDependencies: frontend?.excludedDependencies ?? 0,
      gaps: {
        unattributed: sink.unattributedFor(specId),
        unmappedScripts: frontend?.unmappedScripts ?? 0,
        unmappedRanges: frontend?.unmappedRanges ?? 0,
        outsideProject: (frontend?.files.length ?? 0) - inProject.length,
        unresolvedSources: frontend?.unresolvedSources ?? 0,
        uninstrumentedFiles: sink.uninstrumentedFiles(),
        uninstrumentedProcesses: sink.uninstrumentedProcesses(),
        droppedPushes: sink.droppedPushes(),
        unmappedActorEvents: sink.unmappedActorEvents(),
        // This spec's own identities only. Summing the run's would make every
        // later row inherit it, and the last spec always look the worst.
        outsideWindowEvents: owned.reduce(
          (sum, window) => sum + (sink.outsideWindowEvents().get(window.key) ?? 0),
          0,
        ),
      },
    };
  }

  // The read-outs below answer empty in hub mode — nothing here saw the
  // stream, and the run's health reporting is skipped there for that reason.

  /** Files reached at module top level, across the whole run. */
  boot(): string[] {
    return this.sink === undefined ? [] : [...this.sink.boot()].sort();
  }

  /** Whether any instrumented application process reported at all. */
  heardFromApplication(): boolean {
    return this.sink?.heardFromApplication() ?? false;
  }

  /** Specs some application process attributed a file to. */
  attributedSpecs(): number {
    return this.sink?.attributedSpecs() ?? 0;
  }

  /** Declared identities that acted outside the turns this run gave them. */
  outsideWindowEvents(): ReadonlyMap<string, number> {
    return this.sink?.outsideWindowEvents() ?? new Map();
  }

  /** Events from identities this project never declared. */
  unmappedActorEvents(): number {
    return this.sink?.unmappedActorEvents() ?? 0;
  }

  /** Pushes naming a spec id this run never issued — a stale or forged cookie. */
  rejectedPushes(): number {
    return this.sink?.rejectedPushes() ?? 0;
  }

  /** Pushes the sink could not read — the two halves' wire formats disagree. */
  malformedPushes(): number {
    return this.sink?.malformedPushes() ?? 0;
  }

  /** Application processes that instrumented nothing at all. */
  uninstrumentedProcesses(): number {
    return this.sink?.uninstrumentedProcesses() ?? 0;
  }

  async close(): Promise<void> {
    await this.sink?.close();
  }

  /**
   * Hub-mode close: everything the run alone can state about this spec goes
   * to the inbox. Windows close now, on this process's stamps — actor events
   * match on the instant the work was asked for, so a spec's asynchronous
   * tail still lands inside the turn that caused it.
   */
  private async streamSpecClose(
    inbox: RunEventInbox,
    ref: SpecRef,
    specId: string,
    coverageDir: string,
  ): Promise<void> {
    for (const window of this.actors.windowsForSpec.get(specKey(ref)) ?? []) {
      await inbox.append({ kind: "window-close", runId: this.runId, tag: window.tag });
      // Recorded only after the append resolves: the hub stamps the close
      // before the ack returns, so a drain measured from here spans at least
      // as long on the hub's clock — the only erosion left is the ack's
      // return leg, not the whole POST.
      this.windowClosedAt.set(window.tag, Date.now());
    }
    const frontend = await readFrontend(coverageDir, specId);
    if (frontend !== undefined) {
      // The existence check is part of resolving the browser half, and only
      // the run holds the checkout to resolve against.
      const files = [...new Set(await this.keepExisting(frontend.files))].sort();
      await inbox.append({ kind: "browser", runId: this.runId, specId, files });
    }
    await inbox.append({ kind: "spec-close", runId: this.runId, specId });
  }

  /** Keeps the paths that name a file in the working tree, cached per session. */
  private async keepExisting(paths: readonly string[]): Promise<string[]> {
    const unknown = paths.filter((path) => !this.existing.has(path));
    await Promise.all(
      unknown.map(async (path) => {
        this.existing.set(
          path,
          await access(join(this.root, path)).then(
            () => true,
            () => false,
          ),
        );
      }),
    );
    return paths.filter((path) => this.existing.get(path) === true);
  }

  /** Local mode only; hub mode never settles (see `collect`). */
  private async settle(specId: string): Promise<void> {
    const sink = this.sink!;
    // Nothing has ever pushed: the application is not instrumented, or cannot
    // reach the sink. Waiting a second per spec would buy nothing.
    if (!sink.heardFromApplication()) return;
    const deadline = Date.now() + SETTLE_CAP_MS;
    let previous = sink.filesFor(specId)?.size ?? 0;
    let quiet = 0;
    while (Date.now() < deadline && quiet < SETTLE_QUIET_POLLS) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      const size = sink.filesFor(specId)?.size ?? 0;
      quiet = size === previous ? quiet + 1 : 0;
      previous = size;
    }
  }
}

/**
 * Ends a spec's measurement, whatever happened to the spec.
 *
 * Every caller has to reach this, including the paths that give up before the
 * spec runs: a turn opened on an identity and never closed swallows every later
 * event for it, and the next spec on that identity skips the drain it needs.
 *
 * Never throws. A measurement that could not be read is not a test result.
 */
export async function closeMeasurement(
  collector: CoverageCollector,
  ref: SpecRef,
  coverageDir: string,
): Promise<ReportCoverage | undefined> {
  try {
    return await collector.collect(ref, coverageDir);
  } catch (error) {
    log.warn(`coverage: could not collect for ${specKey(ref)} (${errMessage(error)})`);
    return undefined;
  }
}

/**
 * The configured root, checked before a run leans on it.
 *
 * Every failure here is otherwise silent and identical to success: a root that
 * does not exist, or does not contain the project, sends every relative source
 * outside it, and the run reports a smaller file set with no error at all —
 * the answer this measurement exists to prevent. Spec selection
 * (src/select/analyze.ts) resolves the same key through this function too, so
 * both sides of an intersection agree on what the root means.
 */
export async function resolveRoot(cwd: string, declared: string | undefined): Promise<string | undefined> {
  if (declared === undefined) return undefined;
  // A `${VAR}` nobody set substitutes to "", and `resolve(cwd, "")` is `cwd` —
  // indistinguishable from never having configured a root.
  const substituted = resolveEnvRefs(declared).trim();
  if (substituted === "") {
    throw new Error(`coverage.projectRoot "${declared}" resolved to nothing — is the variable set?`);
  }
  const root = resolve(cwd, substituted);
  const stats = await stat(root).catch(() => undefined);
  if (stats?.isDirectory() !== true) {
    throw new Error(`coverage.projectRoot must name an existing directory; "${declared}" resolved to ${root}`);
  }
  if (relative(root, cwd).startsWith("..")) {
    throw new Error(
      `coverage.projectRoot must contain the directory ccqa runs in; ${root} does not contain ${cwd}`,
    );
  }
  return root;
}

/**
 * Where a spec's browser-side result lands.
 *
 * Not the artifacts directory: the tool a target runs owns that one and may
 * recreate it on startup, and everything left there is also reported as an
 * artifact — the same measurement would then ship twice, once structured and
 * once as a raw blob.
 */
export function specCoverageDir(reportDir: string, feature: string, spec: string): string {
  return join(reportDir, "coverage", feature, spec);
}

/**
 * `<runId>.<feature>/<spec>`. The run id keeps a stale cookie from an earlier
 * run out; the spec half is `specKey`, so an id here and a report row name the
 * same spec the same way.
 */
function specIdFor(runId: string, ref: SpecRef): string {
  return `${runId}.${specKey(ref)}`;
}

async function readFrontend(
  coverageDir: string,
  specId: string,
): Promise<FrontendCoverage | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(coverageDir, FRONTEND_COVERAGE_FILE), "utf8");
  } catch {
    // Absent whenever no engine ever wrote here — an unmeasured target, or an
    // attach that failed. The row says so through `frontendReported`; the
    // back-end half still counts.
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as FrontendCoverage;
    // The spec id is checked, not assumed: a file left by an earlier run would
    // otherwise be merged into this one's result as if the browser had produced it.
    if (!Array.isArray(parsed.files) || parsed.specId !== specId) throw new Error("not this spec");
    return parsed;
  } catch (error) {
    // Written but unreadable — a truncated write from a killed process. Loud,
    // because unlike an absent file this one had something to say.
    log.warn(
      `coverage: ${FRONTEND_COVERAGE_FILE} for ${specId} could not be read (${errMessage(error)})`,
    );
    return undefined;
  }
}
