import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FRONTEND_COVERAGE_FILE, type FrontendCoverage } from "../contract.ts";
import { sourceBehindBuildOutput } from "./build-output.ts";
import { normalizeSourcePath, type SourcePath, type SourceRoots } from "./source-path.ts";
import {
  decodeInlineSourceMap,
  parseSourceMap,
  prepareSourceMap,
  readSourceMappingUrl,
  resolveCovered,
  type CoveredRange,
  type PreparedSourceMap,
} from "./source-map.ts";

/**
 * Turns raw V8 coverage into the project's file set — the half of the browser
 * pipeline that needs no browser. Input is "script URL + covered ranges +
 * (lazily) its source text"; everything here is a pure computation over that,
 * so it does not care how the counters were acquired.
 *
 * The acquisition side hands scripts in as often as it takes counters — per
 * navigation, periodically, at the end — and each batch that changed anything
 * is persisted as it lands (see `flush`).
 */

/** One script's covered code, as the acquisition side hands it over. */
export interface AcquiredScript {
  url: string;
  /** Ranges with a non-zero count only. A script with none is ignored. */
  ranges: readonly CoveredRange[];
  /** The script's text, fetched only when a source map has to be located. */
  source(): Promise<string | undefined>;
}

export interface FrontendResolutionOptions {
  specId: string;
  /** Where `coverage-frontend.json` is written. */
  coverageDir: string;
  roots: SourceRoots;
  /**
   * Fetch of an external `.map` referenced by a script. Implementations should
   * carry the browser's credentials where they can: an application that serves
   * its maps only to signed-in users would otherwise answer with a sign-in
   * page.
   */
  fetchText(url: string): Promise<string | undefined>;
  warn(text: string): void;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

export class FrontendResolution {
  private readonly specId: string;
  private readonly coverageDir: string;
  private readonly roots: SourceRoots;
  private readonly fetchText: (url: string) => Promise<string | undefined>;
  private readonly warn: (text: string) => void;

  private readonly files = new Set<string>();
  /**
   * Resolution, memoised. `roots` is fixed for the session and V8 re-reports
   * every script it has seen on each take, so both answers below are otherwise
   * recomputed for the whole page at every navigation.
   */
  private readonly classified = new Map<string, SourcePath>();
  /** Project path -> the source it was built from, or itself. */
  private readonly sources = new Map<string, string>();
  /** Decoded once per script and kept; the raw map is dropped with it. */
  private readonly maps = new Map<string, PreparedSourceMap | null>();

  private unmappedScripts = 0;
  private unmappedRanges = 0;
  private unresolvedSources = 0;
  private excludedDependencies = 0;
  /** Set once collection dies: everything after this point was never seen. */
  private stopped = false;
  /** What the last write held, so an unchanged flush does not rewrite the file. */
  private written = "";
  private dirReady = false;

  constructor(opts: FrontendResolutionOptions) {
    this.specId = opts.specId;
    this.coverageDir = opts.coverageDir;
    this.roots = opts.roots;
    this.fetchText = opts.fetchText;
    this.warn = opts.warn;
  }

  async absorb(script: AcquiredScript): Promise<void> {
    if (script.ranges.length === 0) return;
    // A development bundler names the module in the script URL itself, which is
    // both cheaper and more exact than a source map — and the common case, so
    // it is answered before any map is fetched.
    const direct = this.bundlerModulePath(script.url);
    if (direct !== undefined) {
      this.files.add(this.sourceOf(direct));
      return;
    }

    const prepared = await this.loadSourceMap(script);
    if (prepared === undefined) {
      this.unmappedScripts++;
      return;
    }
    const resolved = resolveCovered(prepared, [...script.ranges]);
    this.unmappedRanges += resolved.unmappedRanges;
    for (const raw of resolved.sources) {
      const source = this.classify(raw);
      // Counted, not dropped: a source that resolves to nothing usable is a
      // file the result cannot mention, which reads as one no spec ever
      // reached. Dependency code is dropped too, but on purpose, so it is
      // counted apart.
      if (source.kind === "unresolved") this.unresolvedSources++;
      else if (source.kind === "dependency") this.excludedDependencies++;
      else this.files.add(this.sourceOf(source.path));
    }
  }

  /** Collection died mid-spec; the shorter file set must say so. */
  markStopped(): void {
    this.stopped = true;
    this.flush();
  }

  /**
   * Written after every batch that changed something, not only at the end: a
   * spec that fails mid-way still leaves everything it reached, and a failing
   * spec is exactly when the reader wants to know what ran.
   */
  flush(): void {
    const payload: FrontendCoverage = {
      specId: this.specId,
      files: [...this.files].sort(),
      unmappedScripts: this.unmappedScripts,
      unmappedRanges: this.unmappedRanges,
      unresolvedSources: this.unresolvedSources,
      excludedDependencies: this.excludedDependencies,
      stopped: this.stopped,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (text === this.written) return;
    try {
      if (!this.dirReady) {
        mkdirSync(this.coverageDir, { recursive: true });
        this.dirReady = true;
      }
      writeFileSync(join(this.coverageDir, FRONTEND_COVERAGE_FILE), text, "utf8");
      this.written = text;
    } catch (error) {
      this.warn(`could not write ${FRONTEND_COVERAGE_FILE} (${message(error)})`);
    }
  }

  private classify(raw: string): SourcePath {
    const known = this.classified.get(raw);
    if (known !== undefined) return known;
    const source = normalizeSourcePath(raw, this.roots);
    this.classified.set(raw, source);
    return source;
  }

  private sourceOf(path: string): string {
    const known = this.sources.get(path);
    if (known !== undefined) return known;
    const source = sourceBehindBuildOutput(path, this.roots.root) ?? path;
    this.sources.set(path, source);
    return source;
  }

  /**
   * Restricted to bundler schemes: a real `http(s)` URL is a built asset, and
   * its path says nothing about the sources inside it.
   */
  private bundlerModulePath(url: string): string | undefined {
    if (url === "" || /^https?:/i.test(url) || !url.includes("://")) return undefined;
    const source = this.classify(url);
    if (source.kind !== "project" || !SOURCE_FILE.test(source.path)) return undefined;
    return source.path;
  }

  private async loadSourceMap(script: AcquiredScript): Promise<PreparedSourceMap | undefined> {
    const cached = this.maps.get(script.url);
    if (cached !== undefined) return cached ?? undefined;
    const prepared = await this.fetchSourceMap(script);
    this.maps.set(script.url, prepared ?? null);
    return prepared;
  }

  private async fetchSourceMap(script: AcquiredScript): Promise<PreparedSourceMap | undefined> {
    const source = await script.source();
    if (source === undefined) return undefined;
    const reference = readSourceMappingUrl(source);
    if (reference === undefined) return undefined;

    const inline = decodeInlineSourceMap(reference);
    let json = inline;
    if (json === undefined) {
      let target: string;
      try {
        target = new URL(reference, script.url).toString();
      } catch {
        return undefined;
      }
      json = await this.fetchText(target);
      if (json === undefined) return undefined;
    }

    const map = parseSourceMap(json);
    if (map === undefined) return undefined;
    return prepareSourceMap(map, source);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
