import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CoverageUniverse } from "../report/schema.ts";
import { SOURCE_FILE } from "./frontend/resolve.ts";

/**
 * The denominator: every source file the measurement *could* have reached,
 * enumerated by the run because the run is the only party holding the same
 * checkout the measurement ran against — which is what makes "uncovered"
 * trustworthy. The hub renders universe ∪ reached as a file tree; a reached
 * path missing from the universe (a build-output mapping the filters below
 * would skip) still appears, so the exclusions can never lose a result.
 *
 * Enumerated once per run, shipped in the report envelope, and displayed by
 * the hub as-is. There is no separate sync channel to drift out of step.
 */

export type { CoverageUniverse };

/**
 * Directories that hold generated or vendored code, not sources anyone writes
 * tests against. Dot-directories (.git, .next, .turbo…) are skipped wholesale.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

/**
 * More files than any human will triage as a gap list — a ceiling this high is
 * only reached when `coverage.include` points at something like a whole
 * monorepo, and a truncated universe would silently misreport "uncovered".
 */
const MAX_FILES = 20_000;

export async function enumerateUniverse(
  root: string,
  include: readonly string[],
  warn: (text: string) => void,
): Promise<CoverageUniverse | undefined> {
  const files: string[] = [];
  // Normalised so the emitted paths byte-match the reached side's relative
  // paths: "src/", "./src" and "src" are one directory, but unnormalised they
  // would enumerate under three prefixes and every file would show up twice —
  // once reached, once "uncovered".
  const dirs = [...new Set(include.map(normalizeDir))];
  for (const dir of dirs) {
    await walk(dir === "" ? root : join(root, dir), dir, files, warn);
    if (files.length > MAX_FILES) {
      warn(
        `coverage.include matched more than ${MAX_FILES} files — the universe was omitted ` +
          "rather than truncated. Narrow coverage.include to the directories the measurement covers.",
      );
      return undefined;
    }
  }
  if (files.length === 0) {
    // An empty universe would read as "everything reached is 100% of the
    // project" — the same silent misreport the truncation guard exists for.
    warn(
      "coverage.include matched no files — the universe was omitted. Check that the " +
        "directories exist relative to coverage.projectRoot.",
    );
    return undefined;
  }
  files.sort();
  return { include: [...include], files };
}

function normalizeDir(dir: string): string {
  const posix = dir
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  return posix === "." ? "" : posix;
}

async function walk(
  abs: string,
  rel: string,
  out: string[],
  warn: (text: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    // Tolerated — a configured include may be absent in this checkout — but
    // never silent: an unreadable directory shrinks the denominator, and a
    // shrunken denominator misreports "uncovered".
    const code = (err as { code?: string }).code ?? String(err);
    warn(`coverage universe: cannot read ${abs} (${code}) — its files are not counted.`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(abs, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`, out, warn);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      out.push(rel === "" ? entry.name : `${rel}/${entry.name}`);
    }
  }
}
