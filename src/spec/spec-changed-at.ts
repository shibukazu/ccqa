import { relative } from "node:path";
import { execFileP } from "../drift/affected.ts";

/**
 * When each test case was last edited, keyed by the absolute path of the
 * document that states it.
 *
 * A drift verdict is a claim about a (case, product) pair, so either side
 * moving invalidates it. The hub already knows when the product moved — the
 * deploy log — but nothing tells it when a case moved. Without that, a case
 * repaired and merged stays `needsRepair` until the next deploy happens to
 * reach it, and a run that passed against the previous case keeps answering
 * `verified` for the new one.
 *
 * The inventory is where this belongs: `ccqa perspectives` already reads every
 * case from a checkout, and already runs on the push that changes them.
 *
 * Times, not commits. The hub cannot ask whether one commit contains another —
 * it has no repository — but it can compare an instant against the deploy log.
 */
export type CaseChangedAt = Map<string, string>;

/**
 * One `git log` over the cases' own files, walked newest-first. The first time
 * a case's file appears is that case's last edit.
 *
 * Asked about the documents rather than a directory, because where a case is
 * filed is the project's business: ccqa's own specs live under `.ccqa`, and a
 * project that writes its own cases keeps them wherever it keeps them.
 *
 * Best-effort: outside a repository (or with no history) this returns an empty
 * map and every caller falls back to what it did before. A missing timestamp
 * must never make a case look fresher than it is.
 */
export async function readCaseChangedAt(
  cwd: string,
  documentPaths: readonly string[],
): Promise<CaseChangedAt> {
  const out = new Map<string, string>();
  // Repo-relative, which is what `git log --name-only` prints back. A document
  // above `cwd` belongs to another checkout and cannot appear in this log.
  const byRelPath = new Map(
    documentPaths
      .map((abs) => [toPosix(relative(cwd, abs)), abs] as const)
      .filter(([rel]) => rel !== "" && !rel.startsWith("../")),
  );
  const paths = [...byRelPath.keys()];
  // Chunked: the pathspec list is one argument per case, and a suite of a few
  // thousand would exceed the command-line limit and return nothing at all.
  for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
    await readChunk(cwd, paths.slice(i, i + PATHSPEC_CHUNK), byRelPath, out);
  }
  return out;
}

const PATHSPEC_CHUNK = 500;

async function readChunk(
  cwd: string,
  paths: readonly string[],
  byRelPath: ReadonlyMap<string, string>,
  out: Map<string, string>,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      "git",
      // `--relative` because the names are matched against paths relative to
      // `cwd`: without it git prints them from the repository root, and in a
      // monorepo package every lookup below misses.
      //
      // %x00 separates the header from the name list so a commit subject can
      // never be mistaken for a path.
      ["log", "--pretty=format:%x00%cI", "--name-only", "--relative", "--", ...paths],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return;
  }

  let when = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("\0")) {
      when = line.slice(1).trim();
      continue;
    }
    const abs = byRelPath.get(line.trim());
    // Newest first, so the first sighting wins and later commits are ignored.
    if (abs && when && !out.has(abs)) out.set(abs, when);
  }
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}
