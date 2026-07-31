import type { HubApiError } from "../hub-client/index.ts";
import { RunUsageError } from "./errors.ts";

/**
 * Shared shape of the two hub-backed selections, `--only-hub-rerun-needed` and
 * `--only-hub-audit-needed`. Both fail loudly on every "I cannot ask": an
 * unanswerable question that silently selects nothing is the failure mode that
 * makes either flag dangerous.
 */

/**
 * The release whose hub serves these endpoints in their current shape — the
 * newest reshape of either, since one number is what a reader can act on. An
 * older hub either 404s (audit-need, which did not exist before 1.16) or
 * answers a vocabulary the caller now rejects (re-run, whose verdict values
 * changed in 1.20).
 */
const MIN_HUB_VERSION = "1.20";

/**
 * Which of the two 404s this was. The handlers answer `no_perspectives` when
 * the route exists but the project has no document; any other code on a 404
 * means the hub does not serve the route at all.
 */
export function explainHubNotFound(
  flag: string,
  project: string,
  err: HubApiError,
  question: string,
): string {
  if (err.code === "no_perspectives") {
    return (
      `${flag}: project "${project}" has no perspectives document on the hub, so no spec is ` +
      `registered to compare against a deploy. Run \`ccqa perspectives\` first.`
    );
  }
  return (
    `${flag}: this hub cannot answer ${question} — it needs ccqa ${MIN_HUB_VERSION} or newer. ` +
    `Upgrade the hub, or select with --only-affected-by <ref> instead.`
  );
}

/**
 * The profile a hub-backed selection asks about. Mandatory: the deploy log it
 * reads is per-profile, so the question has no profile-free answer.
 */
export function requireHubProfile(flag: string, profile: string | undefined, question: string): string {
  if (profile === undefined) {
    throw new RunUsageError(
      `${flag} requires --hub-profile <name>: the deploy log it reads is per-profile, ` +
        `so ${question} has no answer without one`,
    );
  }
  return profile;
}

/**
 * Worst-known-first order, derived from a total `Record` so the compiler
 * demands a rank for every value. A plain array would let a new state be added
 * and silently vanish from the line the caller promises accounts for every
 * spec.
 */
export function rankedOrder<T extends string>(rank: Record<T, number>): readonly T[] {
  return (Object.keys(rank) as T[]).sort((a, b) => rank[a] - rank[b]);
}

/** "3 rerunNeeded, 1 inProgress, 12 verified" — every offered spec accounted for. */
export function formatCounts<T extends string>(
  order: readonly T[],
  counts: ReadonlyMap<T, number>,
): string {
  return order
    .filter((key) => counts.has(key))
    .map((key) => `${counts.get(key)} ${key}`)
    .join(", ");
}
