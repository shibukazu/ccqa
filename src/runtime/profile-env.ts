import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Profile env vars are hub-sourced (pulled via `ccqa hub`) and merged into
 * `process.env` by `applyProfileEnv` before any spec work, so one spec targets
 * dev/stg/prd without per-environment copies. Spec `${VAR}` references all
 * resolve against `process.env` downstream. `<cwd>/.env` is still read
 * automatically as a local default layer.
 *
 * The `.env` parser is a small hand-rolled subset (no dotenv dependency).
 */

/**
 * Parse a `.env` body into a `name → value` map. Subset: blank / `#` lines
 * skipped, optional leading `export`, split on the first `=`, surrounding
 * quotes stripped, inline `# comment` dropped. No multi-line / interpolation.
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue; // not a key=value line

    const key = withoutExport.slice(0, eq).trim();
    if (key === "") continue;

    out[key] = parseValue(withoutExport.slice(eq + 1).trim());
  }
  return out;
}

function parseValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, 1);
    // Only treat as a quoted value when the quote actually wraps the value:
    // a closing quote followed by nothing or a ` # comment`. Otherwise (e.g.
    // `"a" and "b"`, `"x"y`) the leading quote is just data — fall through and
    // keep the whole thing rather than truncating at the first inner quote.
    if (close !== -1 && /^\s*(#.*)?$/.test(raw.slice(close + 1))) {
      return raw.slice(1, close);
    }
  }
  // Unquoted: a `#` after whitespace starts a comment; one glued to the value
  // (URL fragment) stays literal.
  const hash = raw.search(/\s#/);
  return hash === -1 ? raw : raw.slice(0, hash).trimEnd();
}

/** Read + parse a `.env`, or `null` if absent. Other read errors propagate. */
async function readDotenv(path: string): Promise<Record<string, string> | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseDotenv(content);
}

/** Absolute path of the default `.env` ccqa loads when `--profile` is absent. */
export function defaultEnvPath(cwd: string): string {
  return join(cwd, ".env");
}

/**
 * Load `<cwd>/.env`, the default when no `--profile` is given. A missing `.env`
 * is fine (returns `null`) — the run falls back to the existing `process.env`.
 */
export async function loadDefaultEnv(cwd: string): Promise<Record<string, string> | null> {
  return readDotenv(defaultEnvPath(cwd));
}

/**
 * Merge vars into `process.env`. With `override` (the default), the profile
 * wins over inherited values. Returns the applied names — never values, so
 * callers log names only and secrets stay out of the log.
 */
export function applyProfileEnv(
  vars: Record<string, string>,
  opts: { override?: boolean } = {},
): string[] {
  const override = opts.override ?? true;
  const applied: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (!override && process.env[name] !== undefined) continue;
    process.env[name] = value;
    applied.push(name);
  }
  return applied;
}
