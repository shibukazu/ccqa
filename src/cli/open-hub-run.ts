import { errMessage, RunUsageError } from "../run/errors.ts";
import { ciProvenance } from "../run/github-run.ts";
import type { HubClient, PatchRunRequest } from "../hub-client/index.ts";
import type { Run } from "../hub/contract/schema.ts";
import { detectBranch, getGitHead } from "./git-branch.ts";
import type { HubContext } from "./hub-conn.ts";
import * as log from "./logger.ts";

/** The one wording for "this flag needs a hub, and none is configured". */
export function needsHubConnection(flag: string): string {
  return `${flag} requires a hub connection (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN)`;
}

export const REPORT_TO_HUB_NEEDS_CONNECTION = needsHubConnection("--report-to-hub");

/** An open run on the hub, which the command patches its rows into and then seals. */
export interface HubRunPush {
  hub: HubClient;
  /** Named in the seal's failure message, so it says which run was left open. */
  kind: Run["kind"];
  runId: string;
  /** Resolved once at open, so the seal names the run's own commit. */
  gitHead: string | null;
}

/**
 * The connection a `--report-to-hub` command publishes through. Both CLI
 * callers check this before the expensive part — the audit's sweep, the
 * recording's spec lock and browser — so a job that cannot publish spends
 * nothing finding out.
 */
export function requireReportToHubConnection(conn: HubContext | null): HubContext {
  if (conn) return conn;
  log.error(REPORT_TO_HUB_NEEDS_CONNECTION);
  process.exit(2);
}

/**
 * Open the run a `--report-to-hub` command patches into. Failure is fatal: a
 * job that asked to publish and cannot reach the hub has not done what it was
 * told. Thrown rather than exited, so a caller's `finally` still runs (the
 * audit releases its spec claims there). Not retried: a dropped response after
 * the hub committed would leave a second orphan running run.
 */
export async function openHubRun(
  kind: Run["kind"],
  conn: HubContext,
  cwd: string,
  profile?: string,
): Promise<HubRunPush> {
  const [branch, gitHead] = await Promise.all([detectBranch(cwd), getGitHead(cwd)]);
  try {
    const run = await conn.hub.openRun({
      project: conn.project,
      kind,
      ...(branch ? { branch } : {}),
      ...(profile ? { profile } : {}),
      ...(gitHead ? { gitHead } : {}),
      ...ciProvenance(),
    });
    return { hub: conn.hub, kind, runId: run.id, gitHead };
  } catch (err) {
    throw new RunUsageError(`--report-to-hub: could not open a run on the hub (${errMessage(err)})`);
  }
}

/**
 * Close an open run with its final rows and envelope, answering whether it
 * closed. A failed seal leaves the run `running` with whatever rows landed — a
 * wrong record, not merely a missing one — so a CLI caller must not exit clean.
 * The exit is the caller's to make rather than taken here: `ccqa record` seals
 * from inside a teardown finalizer, and exiting there would skip the
 * browser-session reap queued behind it.
 */
export async function sealHubRun(
  push: HubRunPush,
  body: Pick<PatchRunRequest, "rows" | "reportMeta">,
): Promise<boolean> {
  try {
    await push.hub.patchRun(push.runId, { ...body, done: true });
    return true;
  } catch (err) {
    log.error(`hub: could not close the ${push.kind} run ${push.runId}: ${errMessage(err)}`);
    return false;
  }
}
