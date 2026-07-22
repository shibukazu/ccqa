import { execFileP, normalizeGithubBaseRef } from "../drift/affected.ts";
import { type BaseSource } from "../report/schema.ts";
import { RunUsageError } from "./errors.ts";

export type { BaseSource };

/** The `--failure-analysis` value that selects per-spec hub-ledger baselines. */
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
 * Resolve a `[base]` flag value (from `--failure-analysis [base]` or
 * `--changed [base]`) to a verified baseline, failing fast — before any spec
 * runs — when it cannot be resolved.
 *
 *   - a string value is an explicit ref;
 *   - bare `true` derives the ref from GITHUB_BASE_REF (pull_request events)
 *     and errors outside that context;
 *   - the ref must resolve to a local commit, so a shallow CI checkout that
 *     never fetched the base surfaces here as an actionable error instead of
 *     an empty diff downstream.
 *
 * `flagName` only shapes the error messages.
 */
export async function resolveAnalysisBase(
  flagValue: string | true,
  flagName: string,
  cwd: string,
): Promise<AnalysisBase> {
  let ref: string;
  let source: BaseSource;
  if (flagValue === LAST_GREEN) {
    // The pipeline resolves last-green itself (it needs the hub ledger);
    // reaching here means a flag that doesn't support it (e.g. --changed).
    throw new RunUsageError(
      `${flagName}=${LAST_GREEN} is not supported — last-green baselines are per-spec and only apply to --failure-analysis`,
    );
  }
  if (typeof flagValue === "string") {
    ref = flagValue;
    source = "explicit";
  } else {
    const ghBase = process.env["GITHUB_BASE_REF"];
    if (!ghBase) {
      throw new RunUsageError(
        `${flagName} without a base needs GITHUB_BASE_REF (a pull_request workflow); outside that context pass the base explicitly, e.g. ${flagName}=origin/main`,
      );
    }
    ref = normalizeGithubBaseRef(ghBase);
    source = "github-base-ref";
  }

  const sha = await resolveCommitSha(ref, cwd);
  if (sha === null) {
    throw new RunUsageError(
      `${flagName}: '${ref}' is not a resolvable git ref in this checkout. ` +
        `If this is CI, the base may not be fetched (try fetch-depth: 0). ` +
        `If '${ref}' was meant as a spec target, put spec targets before flags or use ${flagName}=<ref>.`,
    );
  }
  return { ref, sha, source };
}

