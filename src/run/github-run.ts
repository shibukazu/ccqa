/**
 * The GitHub Actions run URL for the current job, built from the standard
 * Actions environment variables. Returns null unless all three are present,
 * so nothing is ever invented for a local run — the same "only when in CI"
 * contract the report envelope's `runId` (GITHUB_RUN_ID) already follows.
 */
export function githubRunUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const server = env["GITHUB_SERVER_URL"];
  const repo = env["GITHUB_REPOSITORY"];
  const runId = githubRunId(env);
  if (!server || !repo || !runId) return null;
  return `${server}/${repo}/actions/runs/${runId}`;
}

/** The current GitHub Actions run id (GITHUB_RUN_ID); null outside Actions. */
export function githubRunId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env["GITHUB_RUN_ID"] ?? null;
}

/**
 * The CI provenance every hub record carries, ready to spread into a request
 * body. Empty outside Actions, so a local invocation sends neither field
 * rather than a null one.
 */
export function ciProvenance(env: NodeJS.ProcessEnv = process.env): { ciRunId?: string; runUrl?: string } {
  const ciRunId = githubRunId(env);
  const runUrl = githubRunUrl(env);
  return { ...(ciRunId ? { ciRunId } : {}), ...(runUrl ? { runUrl } : {}) };
}
