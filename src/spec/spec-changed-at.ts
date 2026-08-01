import { execFileP } from "../drift/affected.ts";

/**
 * When each spec was last edited, keyed by "feature/spec".
 *
 * A drift verdict is a claim about a (spec, product) pair, so either side
 * moving invalidates it. The hub already knows when the product moved — the
 * deploy log — but nothing tells it when a spec moved. Without that, a spec
 * repaired and merged stays `needsRepair` until the next deploy happens to
 * reach it, and a run that passed against the previous spec keeps answering
 * `verified` for the new one.
 *
 * The inventory is where this belongs: `ccqa perspectives` already walks every
 * spec from a checkout, and already runs on the push that changes them.
 *
 * Times, not commits. The hub cannot ask whether one commit contains another —
 * it has no repository — but it can compare an instant against the deploy log.
 */
export type SpecChangedAt = Map<string, string>;

/**
 * One `git log` over the spec tree, walked newest-first. The first time a spec's
 * directory appears is that spec's last edit.
 *
 * Best-effort: outside a repository (or with no history) this returns an empty
 * map and every caller falls back to what it did before. A missing timestamp
 * must never make a spec look fresher than it is.
 */
export async function readSpecChangedAt(cwd: string): Promise<SpecChangedAt> {
  const out = new Map<string, string>();
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      "git",
      // %x00 separates the header from the name list so a commit subject can
      // never be mistaken for a path.
      ["log", "--pretty=format:%x00%cI", "--name-only", "--", ".ccqa/features"],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return out;
  }

  let when = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("\0")) {
      when = line.slice(1).trim();
      continue;
    }
    const key = specKeyOf(line.trim());
    // Newest first, so the first sighting wins and later commits are ignored.
    if (key && when && !out.has(key)) out.set(key, when);
  }
  return out;
}

/**
 * "feature/spec" for a path under the spec tree, or null for anything else.
 * Every file in a case's directory counts: the generated code moving is as
 * much a change to the test as the spec.yaml moving.
 */
export function specKeyOf(path: string): string | null {
  const m = /^\.ccqa\/features\/([^/]+)\/test-cases\/([^/]+)\//.exec(path);
  return m ? `${m[1]}/${m[2]}` : null;
}
