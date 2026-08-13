/**
 * One run's coverage measurement: the sink the application pushes to, the
 * environment each spec's test process needs, and the merge of what both sides
 * reported into a report row.
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
import {
  COVERAGE_ARTIFACTS_ENV,
  COVERAGE_ORIGINS_ENV,
  COVERAGE_ROOT_ENV,
  COVERAGE_SPEC_ENV,
  FRONTEND_COVERAGE_FILE,
  type FrontendCoverage,
} from "./contract.ts";

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
  /** Project root. `coverage.root` is resolved against it. */
  cwd: string;
  config: CoverageConfig;
  /** Every spec this run may execute; the sink refuses ids outside this set. */
  specs: readonly SpecRef[];
  /** Identities whose turns this run hands out. Empty unless the config declares any. */
  actors?: ActorPlan;
}

export class CoverageSession {
  private readonly existing = new Map<string, boolean>();

  private readonly sink: CoverageSink;
  private readonly runId: string;
  /** What reported paths are relative to, and what they are checked against. */
  private readonly root: string;
  /** Set only when the project widened the root; see `specEnv`. */
  private readonly declaredRoot: string | undefined;
  private readonly actors: ActorPlan;
  readonly origins: readonly string[];

  // Assigned in the body rather than declared as parameters: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  private constructor(
    sink: CoverageSink,
    runId: string,
    root: string,
    declaredRoot: string | undefined,
    actors: ActorPlan,
    origins: readonly string[],
  ) {
    this.sink = sink;
    this.runId = runId;
    this.root = root;
    this.declaredRoot = declaredRoot;
    this.actors = actors;
    this.origins = origins;
  }

  static async start(options: CoverageSessionOptions): Promise<CoverageSession> {
    const origins = options.config.origins.map((origin) => resolveEnvRefs(origin));
    const unresolved = origins.filter((origin) => !/^https?:\/\//i.test(origin));
    if (unresolved.length > 0) {
      throw new Error(
        `coverage.origins must be absolute http(s) URLs after variable substitution; got ${unresolved.join(", ")}`,
      );
    }
    const bind = new URL(resolveEnvRefs(options.config.sink));
    const actors = options.actors ?? NO_ACTORS;
    const issued = new Set(options.specs.map((spec) => specIdFor(options.runId, spec)));
    const sink = await CoverageSink.start(
      bind.hostname,
      bind.port === "" ? 80 : Number(bind.port),
      issued,
      actors.tagToKey,
    );
    const declaredRoot = await resolveRoot(options.cwd, options.config.root);
    return new CoverageSession(
      sink,
      options.runId,
      declaredRoot ?? options.cwd,
      declaredRoot,
      actors,
      origins,
    );
  }

  get sinkUrl(): string {
    return this.sink.url;
  }

  /**
   * Opens the spec's measurement and returns what its test process needs.
   *
   * Waits out the drain first, when the spec acts as an identity another spec
   * just finished acting as: the two clocks involved make an event near the
   * boundary ambiguous, and a quiet gap is the only thing that resolves it
   * without either side having to trust the other's time.
   */
  async beginSpec(ref: SpecRef, coverageDir: string): Promise<Record<string, string>> {
    const specId = specIdFor(this.runId, ref);
    for (const window of this.actors.windowsForSpec.get(specKey(ref)) ?? []) {
      const closedAt = this.sink.lastClosedAt(window.tag);
      const wait = closedAt === undefined ? 0 : closedAt + ACTOR_DRAIN_MS - Date.now();
      if (wait > 0) {
        log.meta("coverage", `waiting ${Math.ceil(wait / 1000)}s for ${window.key} to go quiet`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.sink.openWindow(window, specId);
    }
    return this.specEnv(ref, coverageDir);
  }

  /** What a spec's test process needs to attach the cookie and report back. */
  private specEnv(ref: SpecRef, coverageDir: string): Record<string, string> {
    return {
      [COVERAGE_SPEC_ENV]: specIdFor(this.runId, ref),
      [COVERAGE_ORIGINS_ENV]: this.origins.join(","),
      [COVERAGE_ARTIFACTS_ENV]: coverageDir,
      // Only when the project asked for a wider root. This name is also the
      // one `@ccqa/coverage` reads, and a server the test process starts
      // inherits the environment: setting it always would re-root that
      // server's ids while its `include` prefixes stayed relative to the old
      // root, and it would then instrument nothing.
      ...(this.declaredRoot === undefined ? {} : { [COVERAGE_ROOT_ENV]: this.declaredRoot }),
    };
  }

  /** Merges both sides once the spec's pushes have stopped arriving. */
  async collect(ref: SpecRef, coverageDir: string): Promise<ReportCoverage> {
    const specId = specIdFor(this.runId, ref);
    await this.settle(specId);
    // Closed only now: the work a spec's last action triggers arrives after the
    // test process is gone, and settle is what waits for it.
    const owned = this.actors.windowsForSpec.get(specKey(ref)) ?? [];
    for (const window of owned) this.sink.closeWindow(window.tag);
    const matched = this.sink.actorEventsFor(specId);
    const backend = this.sink.filesFor(specId);
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
      backendReported: this.sink.heardFromApplication(),
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
        unattributed: this.sink.unattributedFor(specId),
        unmappedScripts: frontend?.unmappedScripts ?? 0,
        unmappedRanges: frontend?.unmappedRanges ?? 0,
        outsideProject: (frontend?.files.length ?? 0) - inProject.length,
        unresolvedSources: frontend?.unresolvedSources ?? 0,
        uninstrumentedFiles: this.sink.uninstrumentedFiles(),
        uninstrumentedProcesses: this.sink.uninstrumentedProcesses(),
        droppedPushes: this.sink.droppedPushes(),
        unmappedActorEvents: this.sink.unmappedActorEvents(),
        // This spec's own identities only. Summing the run's would make every
        // later row inherit it, and the last spec always look the worst.
        outsideWindowEvents: owned.reduce(
          (sum, window) => sum + (this.sink.outsideWindowEvents().get(window.key) ?? 0),
          0,
        ),
      },
    };
  }

  /** Files reached at module top level, across the whole run. */
  boot(): string[] {
    return [...this.sink.boot()].sort();
  }

  /** Whether any instrumented application process reported at all. */
  heardFromApplication(): boolean {
    return this.sink.heardFromApplication();
  }

  /** Specs some application process attributed a file to. */
  attributedSpecs(): number {
    return this.sink.attributedSpecs();
  }

  /** Declared identities that acted outside the turns this run gave them. */
  outsideWindowEvents(): ReadonlyMap<string, number> {
    return this.sink.outsideWindowEvents();
  }

  /** Events from identities this project never declared. */
  unmappedActorEvents(): number {
    return this.sink.unmappedActorEvents();
  }

  /** Pushes naming a spec id this run never issued — a stale or forged cookie. */
  rejectedPushes(): number {
    return this.sink.rejectedPushes();
  }

  /** Pushes the sink could not read — the two halves' wire formats disagree. */
  malformedPushes(): number {
    return this.sink.malformedPushes();
  }

  /** Application processes that instrumented nothing at all. */
  uninstrumentedProcesses(): number {
    return this.sink.uninstrumentedProcesses();
  }

  async close(): Promise<void> {
    await this.sink.close();
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

  private async settle(specId: string): Promise<void> {
    // Nothing has ever pushed: the application is not instrumented, or cannot
    // reach the sink. Waiting a second per spec would buy nothing.
    if (!this.sink.heardFromApplication()) return;
    const deadline = Date.now() + SETTLE_CAP_MS;
    let previous = this.sink.filesFor(specId)?.size ?? 0;
    let quiet = 0;
    while (Date.now() < deadline && quiet < SETTLE_QUIET_POLLS) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      const size = this.sink.filesFor(specId)?.size ?? 0;
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
 * the answer this measurement exists to prevent.
 */
async function resolveRoot(cwd: string, declared: string | undefined): Promise<string | undefined> {
  if (declared === undefined) return undefined;
  // A `${VAR}` nobody set substitutes to "", and `resolve(cwd, "")` is `cwd` —
  // indistinguishable from never having configured a root.
  const substituted = resolveEnvRefs(declared).trim();
  if (substituted === "") {
    throw new Error(`coverage.root "${declared}" resolved to nothing — is the variable set?`);
  }
  const root = resolve(cwd, substituted);
  const stats = await stat(root).catch(() => undefined);
  if (stats?.isDirectory() !== true) {
    throw new Error(`coverage.root must name an existing directory; "${declared}" resolved to ${root}`);
  }
  if (relative(root, cwd).startsWith("..")) {
    throw new Error(`coverage.root must contain the project root; ${root} does not contain ${cwd}`);
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
    // Absent whenever the generated test never called the hooks. The row says
    // so through `frontendReported`; the back-end half still counts.
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
