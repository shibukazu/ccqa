import type { LastGreenEntry } from "../hub/contract/schema.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import { detectBranch } from "../cli/git-branch.ts";
import { execFileP } from "../drift/affected.ts";
import * as log from "../cli/logger.ts";
import { specKey } from "../store/index.ts";
import { LAST_GREEN, resolveCommitSha } from "./git-context.ts";
import { RunUsageError } from "./errors.ts";
import type { SpecBaseResolution, SpecRef } from "./diff-provider.ts";

/**
 * The repo's default branch name (e.g. "main"), from origin's HEAD ref.
 * Falls back to "main" when origin isn't configured — the lookup then just
 * queries a possibly-empty ledger bucket, which is harmless.
 */
async function detectDefaultBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
    const ref = stdout.trim(); // "origin/main"
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref || "main";
  } catch {
    return "main";
  }
}

/**
 * Fetch the last-green ledger for this run — one hub round trip, logged as
 * the run's analysis-base meta line. Fails fast (RunUsageError) when the hub
 * can't serve it: `--failure-analysis=last-green` explicitly opted into
 * hub-backed baselines, so a broken hub connection is a usage error, never a
 * silent no-baseline run.
 */
export async function fetchLastGreenLedger(
  hubCtx: HubContext,
  profile: string | undefined,
  cwd: string,
): Promise<Record<string, LastGreenEntry>> {
  const [fallbackBranch, detectedBranch] = await Promise.all([
    detectDefaultBranch(cwd),
    detectBranch(cwd),
  ]);
  const branch = detectedBranch ?? fallbackBranch;
  let entries: Record<string, LastGreenEntry>;
  try {
    entries = await hubCtx.hub.getLastGreen(hubCtx.project, {
      branch,
      fallbackBranch,
      ...(profile ? { profile } : {}),
    });
  } catch (err) {
    throw new RunUsageError(
      `--failure-analysis=${LAST_GREEN}: could not fetch the last-green ledger from the hub: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const n = Object.keys(entries).length;
  const scope = branch === fallbackBranch ? branch : `${branch} → ${fallbackBranch}`;
  log.meta("analysis-base", `${LAST_GREEN} (${n} spec baseline${n === 1 ? "" : "s"}, branch ${scope})`);
  return entries;
}

/**
 * Per-spec baseline resolver for `--failure-analysis=last-green`. A spec
 * missing from the ledger (never green on a pushed run yet) or whose
 * baseline commit isn't in this checkout resolves to a skip — the run
 * continues; only that spec's classification is withheld, with the reason
 * recorded in its report row. Sha existence checks are memoized per commit.
 */
export function createLastGreenResolver(
  entries: Record<string, LastGreenEntry>,
  cwd: string,
): (spec: SpecRef) => Promise<SpecBaseResolution> {
  const shaChecks = new Map<string, Promise<string | null>>();
  const checkSha = (sha: string): Promise<string | null> => {
    const cached = shaChecks.get(sha);
    if (cached) return cached;
    const pending = resolveCommitSha(sha, cwd);
    shaChecks.set(sha, pending);
    return pending;
  };

  return async (spec) => {
    const entry = entries[specKey(spec)];
    if (!entry) {
      return {
        ok: false,
        skip: "no last-green baseline for this spec on the hub yet (recorded once the spec passes on a pushed run)",
      };
    }
    const sha = await checkSha(entry.gitHead);
    if (!sha) {
      return {
        ok: false,
        skip: `last-green commit ${entry.gitHead.slice(0, 12)} is not in this checkout (shallow clone? try fetch-depth: 0)`,
      };
    }
    return { ok: true, base: { ref: LAST_GREEN, sha, source: "last-green" } };
  };
}
