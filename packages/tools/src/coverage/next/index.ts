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

export interface CoverageNextOptions {
  /** Project root that file ids are relative to. Defaults to `process.cwd()`. */
  root?: string;
  /** Directories, relative to the root, to instrument. Defaults to `["src"]`. */
  include?: string[];
  /** Set false to build without instrumentation while keeping the config in place. */
  enabled?: boolean;
}

/** Wraps a Next config, preserving any `webpack` hook it already has. */
export function withCoverage<T extends { webpack?: unknown }>(
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
  const include = (options.include ?? ["src"]).map((dir) => resolve(root, dir));
  const previous = config.webpack as
    | ((config: WebpackConfig, context: WebpackContext) => WebpackConfig)
    | undefined;

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
      debugLog(readConfig(), `instrumenting server bundles under ${include.join(", ")}`);
      return next;
    },
  };
}
