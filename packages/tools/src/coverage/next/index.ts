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
  const relativeInclude = (options.include ?? ["src"]).map((dir) => dir.replace(/\/+$/, ""));
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
        test: /\.(?:[cm]?js|jsx|tsx?)$/,
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
 * `include` matcher — so scoping to the project happens inside the loader
 * (fast prefix checks against `include`). No `as` is set, so the
 * instrumented output stays the same module type and flows through the
 * framework's own TypeScript pipeline.
 *
 * No `condition` either, though the types offer one: as of Next 16.3 a rule
 * carrying any `condition` is silently skipped (measured — the loader never
 * runs), so the client graph is instrumented too. Its probes are no-ops in a
 * browser (`globalThis.__ccqaCoverage` never exists there) and the
 * insert-only rewrite keeps line numbers, so the V8-side front-end
 * measurement is unaffected. Revisit once rule conditions actually work.
 */
function withTurbopackRules(
  existing: TurbopackConfig | undefined,
  root: string,
  include: string[],
): TurbopackConfig {
  const rule = {
    loaders: [
      {
        loader: require.resolve("./next-loader.cjs"),
        options: { root, include, dialect: "source" },
      },
    ],
  };
  const rules: TurbopackRules = { ...existing?.rules };
  for (const glob of ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"]) {
    const present = rules[glob];
    // A rule the config already carries keeps running; ours is appended in
    // the array form Turbopack defines for disjoint conditions.
    rules[glob] = present === undefined ? rule : [...(Array.isArray(present) ? present : [present]), rule];
  }
  return { ...existing, rules };
}
