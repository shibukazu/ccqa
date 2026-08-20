/**
 * Next.js integration.
 *
 * Next bundles its server code, so the load hooks in
 * `ccqa-tools/coverage/register` never see the application's own modules — only the
 * bundle. The instrumentation therefore has to happen at build time, while the
 * context that attributes it still comes from the register hook wrapping
 * `node:http`. Both halves are required:
 *
 *   // next.config.ts
 *   export default withCoverage({ ...yourConfig })
 *
 *   NODE_OPTIONS='--import ccqa-tools/coverage/register' CCQA_COVERAGE=1 next start
 *
 * Only server bundles are instrumented. Instrumenting the client would ship
 * `__ccqaCoverage` calls to browsers, where the front-end side of ccqa's
 * coverage already reads V8's own counters and needs nothing injected.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

import { SOURCE_EXTENSIONS } from "../instrument/select.ts";
import { debugLog, readConfig } from "../runtime-env.ts";
import { ENV_NAME } from "../wire.ts";

const require = createRequire(import.meta.url);

interface WebpackRule {
  enforce?: string;
  test?: RegExp;
  include?: string[];
  exclude?: RegExp;
  use?: unknown;
}

interface WebpackConfig {
  module?: { rules?: WebpackRule[] };
}

interface WebpackContext {
  isServer: boolean;
}

type TurbopackRules = Record<string, unknown>;

interface TurbopackConfig {
  rules?: TurbopackRules;
}

export interface CoverageNextOptions {
  /** Project root that file ids are relative to. Defaults to `process.cwd()`. */
  root?: string;
  /** Directories, relative to the root, to instrument. Defaults to `["src"]`. */
  include?: string[];
  /** Set false to build without instrumentation while keeping the config in place. */
  enabled?: boolean;
}

/**
 * Wraps a Next config, preserving any `webpack` hook and `turbopack` rules it
 * already has. Both bundlers are wired because the config does not know which
 * one will build it: webpack gets a post-loader over compiled JavaScript,
 * Turbopack — which has no post phase and never calls the `webpack` hook —
 * gets rule loaders that instrument the original TypeScript instead. Missing
 * either half means a Turbopack (or webpack) build silently ships
 * uninstrumented server code whose only coverage is the module-load boot set.
 */
export function withCoverage<T extends { webpack?: unknown; turbopack?: TurbopackConfig }>(
  config: T,
  options: CoverageNextOptions = {},
): T {
  const enabled = options.enabled ?? process.env[ENV_NAME] !== undefined;
  if (!enabled) return config;

  // Falls back to `CCQA_COVERAGE_ROOT`, not straight to the cwd: ids are baked
  // in here at build time, so a deployment that sets the env to line up with
  // the runner would otherwise have no effect at all on a Next app and report
  // the same file under two names.
  const root = resolve(options.root ?? readConfig().root);
  // Normalised to the exact shape file ids take: "./src", "src/", and
  // backslashes would all silently match nothing in the loader's prefix
  // check, and a Turbopack build would instrument zero files with no error.
  const relativeInclude = (options.include ?? readConfig().include).map((dir) =>
    dir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""),
  );
  const include = relativeInclude.map((dir) => resolve(root, dir));
  const previous = config.webpack as
    | ((config: WebpackConfig, context: WebpackContext) => WebpackConfig)
    | undefined;

  debugLog(readConfig(), `instrumenting server bundles under ${include.join(", ")}`);
  return {
    ...config,
    webpack(webpackConfig: WebpackConfig, context: WebpackContext): WebpackConfig {
      const next = previous ? previous(webpackConfig, context) : webpackConfig;
      if (!context.isServer) return next;
      next.module ??= {};
      next.module.rules ??= [];
      next.module.rules.push({
        enforce: "post",
        test: /\.(?:[cm]?[jt]s|jsx|tsx)$/,
        include,
        exclude: /[\\/]node_modules[\\/]/,
        use: [{ loader: require.resolve("./next-loader.cjs"), options: { root } }],
      });
      return next;
    },
    turbopack: withTurbopackRules(config.turbopack, root, relativeInclude),
  };
}

/**
 * Turbopack rule globs match by extension, everywhere — there is no
 * `include` matcher — so project scoping happens inside the loader through
 * `shouldInstrument`. The rule's condition does what the webpack half's
 * `isServer` gate and `exclude` matcher do: `not browser` keeps probes out
 * of client bundles, `not foreign` keeps dependencies out of the loader
 * entirely. No `as` is set, so the instrumented output stays the same module
 * type and flows through the framework's own TypeScript pipeline.
 *
 * One measured trap: Turbopack serves unchanged files from its persistent
 * cache without consulting rules again, so judging a rule change by an
 * incremental build lies — a rule "not firing" may just be a warm cache.
 */
function withTurbopackRules(
  existing: TurbopackConfig | undefined,
  root: string,
  include: string[],
): TurbopackConfig {
  const rule = {
    condition: { all: [{ not: "browser" }, { not: "foreign" }] },
    loaders: [
      {
        loader: require.resolve("./next-loader.cjs"),
        options: { root, include, dialect: "source" },
      },
    ],
  };
  const rules: TurbopackRules = { ...existing?.rules };
  for (const extension of SOURCE_EXTENSIONS) {
    const glob = `*${extension}`;
    // A rule the config already carries keeps running; ours is appended in
    // the array form Turbopack defines for disjoint conditions.
    rules[glob] = [...toArray(rules[glob]), rule];
  }
  return { ...existing, rules };
}

function toArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
