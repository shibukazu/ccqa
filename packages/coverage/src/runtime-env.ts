import { ENV_DEBUG, ENV_INCLUDE, ENV_NAME, ENV_ROOT, parseSpecId } from "./wire.ts";

export interface CoverageConfig {
  enabled: boolean;
  /** Set when the process is dedicated to one spec and has no request to read. */
  ambientSpecId: string | undefined;
  root: string;
  /** Path prefixes, relative to `root`, whose files get instrumented. */
  include: string[];
  debug: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CoverageConfig {
  const raw = env[ENV_NAME];
  const include = (env[ENV_INCLUDE] ?? "src")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    enabled: raw !== undefined && raw !== "" && raw !== "0" && raw !== "false",
    ambientSpecId: parseSpecId(raw),
    root: env[ENV_ROOT] ?? process.cwd(),
    include,
    debug: env[ENV_DEBUG] === "1" || env[ENV_DEBUG] === "true",
  };
}

/**
 * Diagnostics go to stderr and nowhere else. A `--import` preload is inherited
 * by every child node process, and writing to stdout corrupts whatever the host
 * was parsing there — enough to make a framework's own toolchain fail to start.
 */
export function debugLog(config: CoverageConfig, message: string): void {
  if (!config.debug) return;
  process.stderr.write(`[ccqa-coverage] ${message}\n`);
}
