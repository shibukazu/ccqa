import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceBehindBuildOutput } from "../coverage/frontend/build-output.ts";
import { normalizeSourcePath, type SourcePath, type SourceRoots } from "../coverage/frontend/source-path.ts";
import {
  decodeInlineSourceMap,
  parseSourceMap,
  prepareSourceMap,
  readSourceMappingUrl,
  resolveCovered,
  type CoveredRange,
  type PreparedSourceMap,
} from "../coverage/frontend/source-map.ts";
import {
  COVERAGE_ARTIFACTS_ENV,
  COVERAGE_COOKIE,
  COVERAGE_ORIGINS_ENV,
  COVERAGE_ROOT_ENV,
  COVERAGE_SPEC_ENV,
  FRONTEND_COVERAGE_FILE,
  type FrontendCoverage,
} from "../coverage/contract.ts";

/**
 * Front-end half of `ccqa run --coverage`, for tests ccqa generates for
 * external targets. Generated tests import it through the
 * `ccqa/coverage-hooks` subpath, the same way they import
 * `ccqa/step-evidence`.
 *
 * It does two things the back-end instrumentation cannot do for itself:
 *
 *   - **Attaches the spec cookie.** Every request the browser makes carries it,
 *     navigations and service-worker fetches included, which is what lets an
 *     instrumented server tell this spec's traffic from the rest of a shared
 *     environment's. It goes only to the origins coverage was configured for —
 *     never to an identity provider or any third party the spec visits.
 *   - **Reads V8's own counters** for the browser, which needs nothing injected
 *     into the application, and maps them back to source files.
 *
 * The same two constraints as `ccqa/step-evidence` apply: no test-framework
 * import (the page is typed structurally), and never fail the user's test —
 * every failure here is swallowed with a stderr note.
 */

/** The subset of a Playwright `Page` this module uses. Structural by design. */
export interface CcqaCoveragePage {
  context(): CcqaCoverageContext;
  goto(url: string, options?: unknown): Promise<unknown>;
  reload(options?: unknown): Promise<unknown>;
  on(event: string, handler: (...args: never[]) => void): unknown;
  mainFrame?(): unknown;
  coverage?: CcqaJsCoverage;
  request?: CcqaFetcher;
}

export interface CcqaCoverageContext {
  addCookies(cookies: readonly CcqaCookie[]): Promise<void>;
  clearCookies(options?: unknown): Promise<void>;
}

export interface CcqaCookie {
  name: string;
  value: string;
  url: string;
}

export interface CcqaFetcher {
  get(url: string): Promise<{ ok(): boolean; text(): Promise<string> }>;
}

export interface CcqaJsCoverage {
  startJSCoverage(options?: {
    resetOnNavigation?: boolean;
    reportAnonymousScripts?: boolean;
  }): Promise<void>;
  stopJSCoverage(): Promise<readonly CcqaCoverageEntry[]>;
}

export interface CcqaCoverageEntry {
  url: string;
  source?: string;
  functions: readonly {
    ranges: readonly { count: number; startOffset: number; endOffset: number }[];
  }[];
}

export type { FrontendCoverage };

interface Session {
  specId: string;
  coverageDir: string;
  roots: SourceRoots;
  files: Set<string>;
  /**
   * Resolution, memoised. `roots` is fixed for the session and V8 re-reports
   * every script it has seen on each take, so both answers below are otherwise
   * recomputed for the whole page at every navigation.
   */
  classified: Map<string, SourcePath>;
  /** Project path -> the source it was built from, or itself. */
  sources: Map<string, string>;
  unmappedScripts: number;
  unmappedRanges: number;
  unresolvedSources: number;
  excludedDependencies: number;
  /** Set once collection dies: everything after this point was never seen. */
  stopped: boolean;
  coverage: CcqaJsCoverage | undefined;
  fetcher: CcqaFetcher | undefined;
  /** Decoded once per script and kept; the raw map is dropped with it. */
  maps: Map<string, PreparedSourceMap | null>;
  /** Set by the goto/reload wrappers so the event they cause does not take twice. */
  expectNavigation: boolean;
  /** What the last write held, so an unchanged take does not rewrite the file. */
  written: string;
  /** Serialises takes, so a navigation during a take cannot interleave two. */
  pending: Promise<void>;
}

const sessions = new WeakMap<CcqaCoveragePage, Session>();

/**
 * Attaches the cookie and starts collecting. Call once, before the spec's
 * first navigation — V8 reports nothing for a script that was already parsed.
 */
export async function ccqaCoverageStart(page: CcqaCoveragePage): Promise<void> {
  const specId = process.env[COVERAGE_SPEC_ENV];
  const coverageDir = process.env[COVERAGE_ARTIFACTS_ENV];
  if (!specId || !coverageDir) return;
  const origins = (process.env[COVERAGE_ORIGINS_ENV] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const session: Session = {
    specId,
    coverageDir,
    // `base` is where the build ran and `root` is where answers are rooted.
    // They part company only in a workspace, where the run points the root at
    // a directory that also contains the project's sibling packages.
    roots: { base: process.cwd(), root: process.env[COVERAGE_ROOT_ENV] || process.cwd() },
    files: new Set(),
    classified: new Map(),
    sources: new Map(),
    unmappedScripts: 0,
    unmappedRanges: 0,
    unresolvedSources: 0,
    excludedDependencies: 0,
    stopped: false,
    coverage: page.coverage,
    fetcher: page.request,
    maps: new Map(),
    expectNavigation: false,
    written: "",
    pending: Promise.resolve(),
  };
  sessions.set(page, session);

  try {
    mkdirSync(coverageDir, { recursive: true });
  } catch (error) {
    warn(`could not create ${coverageDir} (${message(error)})`);
  }
  await attachCookie(page, specId, origins);
  await startCollecting(session);
  watchNavigations(page, session);
}

/** Final take. Safe to call more than once, and safe if `start` never ran. */
export async function ccqaCoverageStop(page: CcqaCoveragePage): Promise<void> {
  const session = sessions.get(page);
  if (session === undefined) return;
  await take(session, false);
}

/**
 * Keeps the cookie on the context for the whole spec.
 *
 * A recorded step may clear cookies at any point — it is a recordable action —
 * and everything after that would silently lose its attribution, which reads
 * as "never reached". Re-adding after each clear makes the attachment
 * independent of where in the spec the clear happens to sit.
 */
async function attachCookie(
  page: CcqaCoveragePage,
  specId: string,
  origins: readonly string[],
): Promise<void> {
  if (origins.length === 0) {
    warn("no origins configured — the spec cookie was not attached");
    return;
  }
  const cookies = origins.map((url) => ({ name: COVERAGE_COOKIE, value: specId, url }));
  const context = page.context();
  const add = async (): Promise<void> => {
    try {
      await context.addCookies(cookies);
    } catch (error) {
      warn(`could not attach the spec cookie (${message(error)})`);
    }
  };
  const clear = context.clearCookies.bind(context);
  context.clearCookies = async (options?: unknown): Promise<void> => {
    await clear(options);
    await add();
  };
  await add();
}

function watchNavigations(page: CcqaCoveragePage, session: Session): void {
  // A full document load discards the isolate's counters, so what the previous
  // page ran has to be taken before the next one commits. `goto`/`reload` are
  // wrapped because only a wrapper runs *before* the navigation; the event, all
  // a click-driven load offers, fires after it and catches only what survived.
  const before = async (navigate: () => Promise<unknown>): Promise<unknown> => {
    await take(session, true);
    session.expectNavigation = true;
    try {
      return await navigate();
    } catch (error) {
      // A navigation that never committed fires no event, so the flag it set
      // would otherwise swallow the next real one's take.
      session.expectNavigation = false;
      throw error;
    }
  };
  const goto = page.goto.bind(page);
  page.goto = (url: string, options?: unknown) => before(() => goto(url, options));
  const reload = page.reload.bind(page);
  page.reload = (options?: unknown) => before(() => reload(options));
  try {
    const mainFrame = page.mainFrame?.();
    page.on("framenavigated", ((frame: unknown) => {
      // Sub-frames (embedded widgets, ads) do not reset the page's counters,
      // and a take costs a full transfer of every script's source over CDP.
      if (mainFrame !== undefined && frame !== mainFrame) return;
      if (session.expectNavigation) {
        session.expectNavigation = false;
        return;
      }
      void take(session, true);
    }) as (...args: never[]) => void);
  } catch (error) {
    warn(`could not watch navigations (${message(error)})`);
  }
}

async function startCollecting(session: Session): Promise<void> {
  if (session.coverage === undefined) {
    warn("this browser exposes no JS coverage — front-end coverage will be empty");
    return;
  }
  try {
    // Anonymous scripts matter: a development bundler evaluates each module in
    // its own `eval`, and those are where the application's own code lives.
    await session.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: true,
    });
  } catch (error) {
    warn(`could not start JS coverage (${message(error)})`);
    session.coverage = undefined;
  }
}

/** Drains V8's counters into the session, optionally restarting collection. */
function take(session: Session, restart: boolean): Promise<void> {
  session.pending = session.pending.then(async () => {
    const coverage = session.coverage;
    if (coverage === undefined) return;
    // Dropped before restarting or finishing, so a second `stop` is a no-op
    // rather than a second `stopJSCoverage` the driver rejects.
    session.coverage = undefined;
    let entries: readonly CcqaCoverageEntry[];
    try {
      entries = await coverage.stopJSCoverage();
    } catch (error) {
      // Collection is over for this spec. Recorded rather than only logged: the
      // shorter file set that results is otherwise indistinguishable from a
      // spec that genuinely reached less.
      warn(`could not read JS coverage (${message(error)})`);
      session.stopped = true;
      flush(session);
      return;
    }
    for (const entry of entries) await absorb(session, entry);
    flush(session);
    if (restart) {
      session.coverage = coverage;
      await startCollecting(session);
      if (session.coverage === undefined) {
        session.stopped = true;
        flush(session);
      }
    }
  });
  // A terminal catch, or a rejection here would surface as an unhandled one
  // from the navigation listener and take the user's test down with it.
  session.pending = session.pending.catch((error: unknown) => {
    warn(`coverage take failed (${message(error)})`);
    session.stopped = true;
    // Written, not just set: `session.coverage` is already cleared by this
    // point so the final stop is a no-op, and the file would keep the last
    // successful flush's `stopped: false` — a truncated result presented whole.
    flush(session);
  });
  return session.pending;
}

async function absorb(session: Session, entry: CcqaCoverageEntry): Promise<void> {
  // A development bundler names the module in the script URL itself, which is
  // both cheaper and more exact than a source map — and the common case, so it
  // is answered before any range object is allocated.
  const direct = bundlerModulePath(session, entry.url);
  if (direct !== undefined) {
    const path = sourceOf(session, direct);
    if (session.files.has(path) || !anyCovered(entry)) return;
    session.files.add(path);
    return;
  }

  const ranges: CoveredRange[] = [];
  for (const fn of entry.functions) {
    for (const range of fn.ranges) {
      if (range.count > 0) {
        ranges.push({ startOffset: range.startOffset, endOffset: range.endOffset });
      }
    }
  }
  if (ranges.length === 0) return;

  const prepared = await loadSourceMap(session, entry);
  if (prepared === undefined) {
    session.unmappedScripts++;
    return;
  }
  const resolved = resolveCovered(prepared, ranges);
  session.unmappedRanges += resolved.unmappedRanges;
  for (const raw of resolved.sources) {
    const source = classify(session, raw);
    // Counted, not dropped: a source that resolves to nothing usable is a file
    // the result cannot mention, which reads as one no spec ever reached.
    // Dependency code is dropped too, but on purpose, so it is counted apart.
    if (source.kind === "unresolved") session.unresolvedSources++;
    else if (source.kind === "dependency") session.excludedDependencies++;
    else session.files.add(sourceOf(session, source.path));
  }
}

function classify(session: Session, raw: string): SourcePath {
  const known = session.classified.get(raw);
  if (known !== undefined) return known;
  const source = normalizeSourcePath(raw, session.roots);
  session.classified.set(raw, source);
  return source;
}

function sourceOf(session: Session, path: string): string {
  const known = session.sources.get(path);
  if (known !== undefined) return known;
  const source = sourceBehindBuildOutput(path, session.roots.root) ?? path;
  session.sources.set(path, source);
  return source;
}

function anyCovered(entry: CcqaCoverageEntry): boolean {
  for (const fn of entry.functions) {
    for (const range of fn.ranges) if (range.count > 0) return true;
  }
  return false;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Restricted to bundler schemes: a real `http(s)` URL is a built asset, and its
 * path says nothing about the sources inside it.
 */
function bundlerModulePath(session: Session, url: string): string | undefined {
  if (url === "" || /^https?:/i.test(url) || !url.includes("://")) return undefined;
  const source = classify(session, url);
  if (source.kind !== "project" || !SOURCE_FILE.test(source.path)) return undefined;
  return source.path;
}

async function loadSourceMap(
  session: Session,
  entry: CcqaCoverageEntry,
): Promise<PreparedSourceMap | undefined> {
  const cached = session.maps.get(entry.url);
  if (cached !== undefined) return cached ?? undefined;
  const prepared = await fetchSourceMap(session, entry);
  session.maps.set(entry.url, prepared ?? null);
  return prepared;
}

async function fetchSourceMap(
  session: Session,
  entry: CcqaCoverageEntry,
): Promise<PreparedSourceMap | undefined> {
  if (entry.source === undefined) return undefined;
  const reference = readSourceMappingUrl(entry.source);
  if (reference === undefined) return undefined;

  const inline = decodeInlineSourceMap(reference);
  let json = inline;
  if (json === undefined) {
    // The sibling `.map` is fetched through the browser's own request context
    // so it carries the session's cookies; an application that serves its maps
    // only to signed-in users would otherwise answer with a sign-in page.
    const fetcher = session.fetcher;
    if (fetcher === undefined) return undefined;
    let target: string;
    try {
      target = new URL(reference, entry.url).toString();
    } catch {
      return undefined;
    }
    try {
      const response = await fetcher.get(target);
      if (!response.ok()) return undefined;
      json = await response.text();
    } catch {
      return undefined;
    }
  }

  const map = parseSourceMap(json);
  if (map === undefined) return undefined;
  return prepareSourceMap(map, entry.source);
}

/**
 * Written after every take that changed something, not only at the end: a spec
 * that fails mid-way still leaves everything it reached, and a failing spec is
 * exactly when the reader wants to know what ran.
 */
function flush(session: Session): void {
  const payload: FrontendCoverage = {
    specId: session.specId,
    files: [...session.files].sort(),
    unmappedScripts: session.unmappedScripts,
    unmappedRanges: session.unmappedRanges,
    unresolvedSources: session.unresolvedSources,
    excludedDependencies: session.excludedDependencies,
    stopped: session.stopped,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (text === session.written) return;
  try {
    writeFileSync(join(session.coverageDir, FRONTEND_COVERAGE_FILE), text, "utf8");
    session.written = text;
  } catch (error) {
    warn(`could not write ${FRONTEND_COVERAGE_FILE} (${message(error)})`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  process.stderr.write(`[ccqa] coverage: ${text}\n`);
}
