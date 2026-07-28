import { execFileP } from "../drift/affected.ts";
import { type BaseSource } from "../report/schema.ts";
import { RunUsageError } from "./errors.ts";

export type { BaseSource };

/**
 * Marks a baseline as "each spec's own last green commit" rather than one
 * shared ref. Not a flag value — `--on-fail-explain` uses per-spec baselines
 * unless `--on-fail-explain-base` names a ref — but the report and the log
 * lines need a word for it.
 */
export const LAST_GREEN = "last-green";

/** A resolved, verified-to-exist analysis baseline. */
export interface AnalysisBase {
  /** The base ref expression as given/derived (e.g. "origin/main"). */
  ref: string;
  /** `ref` resolved to a full commit sha at run start. */
  sha: string;
  source: BaseSource;
}

/**
 * The run's git coordinates, resolved once at run start.
 *
 * `head` is recorded unconditionally — it used to be derived from the
 * captured source diff, so a run with no deterministic failures (a live-only
 * run, the common CI shape) left `git.head` null even though the commit was
 * perfectly knowable. Downstream — the hub's `Run.gitHead`, and any baseline
 * that wants to answer "what changed since this spec last passed" — needs the
 * head of every run, green or red, analyzed or not.
 *
 * `base` is null exactly when failure analysis was not requested: the
 * three-way classification is defined in terms of a source diff (TEST_DRIFT /
 * SPEC_CHANGE must cite it, PRODUCT_BUG claims it explains nothing), so
 * analysis is opt-in via `--failure-analysis [base]` and a baseline that
 * cannot be resolved is a startup usage error, never a silent fallback.
 */
export interface GitContext {
  /** Full HEAD sha. Null only when `cwd` is not a git repo. */
  head: string | null;
  /**
   * `sha` is null exactly in last-green mode: there is no single run-level
   * base commit — each analyzed spec carries its own in `analysisBase`.
   */
  base: { ref: string; sha: string | null; source: BaseSource } | null;
}

/** Resolve `ref` to a full commit sha, or null when it does not exist locally. */
export async function resolveCommitSha(ref: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a base ref to a verified baseline, failing fast — before any spec
 * runs — when it cannot be resolved. The ref must resolve to a local commit,
 * so a shallow CI checkout that never fetched the base surfaces here as an
 * actionable error instead of an empty diff downstream.
 *
 * `flagName` only shapes the error messages.
 */
export async function resolveAnalysisBase(
  ref: string,
  flagName: string,
  cwd: string,
): Promise<AnalysisBase> {
  const source: BaseSource = "explicit";
  const sha = await resolveCommitSha(ref, cwd);
  if (sha === null) {
    throw new RunUsageError(
      `${flagName}: '${ref}' is not a resolvable git ref in this checkout. ` +
        `If this is CI, the base may not be fetched (try fetch-depth: 0). ` +
        `If '${ref}' was meant as a spec target, put spec targets before flags.`,
    );
  }
  return { ref, sha, source };
}

