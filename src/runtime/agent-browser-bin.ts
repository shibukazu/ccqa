import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function hasAgentBrowserShim(dir: string): boolean {
  try {
    statSync(join(dir, "agent-browser"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks up from `start` looking for a `node_modules/.bin/agent-browser` shim.
 * Returns the .bin directory containing the shim, or null if none is found.
 */
function findNodeModulesBin(start: string): string | null {
  let cur = start;
  while (true) {
    const candidate = join(cur, "node_modules", ".bin");
    if (hasAgentBrowserShim(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Resolves the directory containing the `agent-browser` shim that npm/pnpm
 * exposes on PATH for the peer-installed package. Used by `ccqa trace` to
 * prepend this directory to PATH so the Claude subprocess can invoke
 * `agent-browser ...` without requiring a global install.
 *
 * Returns null if agent-browser cannot be located.
 */
export function resolveAgentBrowserBinDir(): string | null {
  // 1. The consumer project's node_modules/.bin (most common — pnpm/npm/yarn
  //    all create a shim here when agent-browser is installed as a peer).
  //    Walk up from process.cwd() to handle monorepos where the shim lives
  //    at the workspace root.
  const fromCwd = findNodeModulesBin(process.cwd());
  if (fromCwd) return fromCwd;

  // 2. Walk up from this file (covers the case where ccqa itself is invoked
  //    from outside the consumer project, e.g. via a globally-linked bin).
  const fromSelf = findNodeModulesBin(dirname(require.resolve("agent-browser/package.json")));
  if (fromSelf) return fromSelf;

  // 3. Legacy fallback: npm-flat layouts where the shim sits next to the
  //    package dir.
  try {
    const pkgDir = dirname(require.resolve("agent-browser/package.json"));
    const candidate = join(pkgDir, "node_modules", ".bin");
    if (hasAgentBrowserShim(candidate)) return candidate;
  } catch {
    // peer not installed at all
  }
  return null;
}

/**
 * Returns a PATH string with the agent-browser shim directory prepended,
 * so `agent-browser ...` resolves without a global install. Falls back to
 * the original PATH when the package can't be resolved.
 */
export function pathWithAgentBrowserShim(currentPath: string | undefined): string {
  const path = currentPath ?? "";
  const dir = resolveAgentBrowserBinDir();
  if (!dir) return path;
  if (path.split(delimiter).includes(dir)) return path;
  return dir + delimiter + path;
}

/**
 * Confirms before launching Claude that an `agent-browser` shim is reachable
 * via PATH. We do this up front so a missing peer dependency fails fast with
 * a clear message, instead of Claude burning tokens probing the system with
 * `which`, `find`, `npm install`, etc.
 *
 * The `resolver` argument is for tests; production calls take no args.
 */
export function assertAgentBrowserAvailable(
  resolver: () => string | null = resolveAgentBrowserBinDir,
): string {
  const dir = resolver();
  if (!dir) {
    throw new AgentBrowserUnavailableError();
  }
  const shim = join(dir, "agent-browser");
  try {
    const s = statSync(shim);
    if (!s.isFile() && !s.isSymbolicLink()) {
      throw new AgentBrowserUnavailableError();
    }
  } catch {
    throw new AgentBrowserUnavailableError();
  }
  return dir;
}

export class AgentBrowserUnavailableError extends Error {
  constructor() {
    super("agent-browser binary not found on PATH");
    this.name = "AgentBrowserUnavailableError";
  }
}

/** Human-readable explanation shown to the user when the guard fires. */
export function formatAgentBrowserUnavailableMessage(): string {
  return [
    "agent-browser is not installed or not on PATH.",
    "",
    "ccqa drives the browser via the peer-installed `agent-browser` package.",
    "Install it in this project:",
    "",
    "  pnpm add -D agent-browser",
    "  # or",
    "  npm install -D agent-browser",
    "",
    "If it is already installed, make sure you are running ccqa from the",
    "project root (or via your package runner, e.g. `pnpm exec ccqa ...`).",
  ].join("\n");
}
