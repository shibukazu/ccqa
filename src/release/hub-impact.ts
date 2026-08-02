/**
 * Which side of ccqa a release lands on.
 *
 * One npm package is two artifacts: a CLI a consumer's CI pins, and a hub they
 * deploy and leave running (ADR-0006). Only the version number reaches the
 * person holding the deployed hub, so it has to answer "must I redeploy?" on
 * its own — the rule it answers by, and why each path below is where it is,
 * are in [ADR-0018](../../docs/adr/0018-the-bump-answers-the-hub.md).
 */

export type Bump = "patch" | "minor" | "major";

/**
 * The wire contract: what a hub and a client must agree on to talk at all.
 *
 * `src/hub/contract/` is the REST request/response surface and says so in its
 * own header. `src/report/schema.ts` is the body a run pushes and the hub
 * validates, stores and serves back. `docs/hub-api.md` is where that contract
 * is stated for a client that is neither of ours. `src/hub-client/` is
 * deliberately not here: it implements the contract rather than defining it,
 * and it cannot need a newer hub unless something above moved first.
 */
export const WIRE_CONTRACT_PATHS = ["src/hub/contract/", "src/report/schema.ts", "docs/hub-api.md"] as const;

/**
 * What a deployed hub is made of. The contract paths above are under
 * `src/hub/` too and are subtracted, since they answer a stronger question.
 *
 * The bundled UI counts because the hub serves it — a UI fix reaches nobody
 * until the hub restarts. `src/cli/serve.ts` is the process a deployment runs:
 * its flags, its defaults and the env it demands. The last four build and run
 * that process and are never on a CLI consumer's path.
 */
export const HUB_SOURCE_PATHS = [
  "src/hub/",
  "src/cli/serve.ts",
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yaml",
  ".env.example",
] as const;

/**
 * `cli-only` — the deployed hub has nothing to do. `hub-source` — it is stale
 * until redeployed, but an older one still works. `wire-contract` — both sides
 * moved and compatibility is a human question. `unknown` — no previous tag to
 * compare against, so nothing was ruled out.
 */
export type HubImpact = "cli-only" | "hub-source" | "wire-contract" | "unknown";

export interface ReleaseVerdict {
  bump: Bump;
  impact: HubImpact;
  wirePaths: string[];
  hubPaths: string[];
  /** Names the wire contract declared at the base and no longer declares. */
  removed: string[];
  /** Null when the bump agrees with the diff; otherwise why, and the bump that would have. */
  disagreement: { reason: string; requiredBump: Bump } | null;
}

const BUMP_RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export function isBump(value: string): value is Bump {
  return value === "patch" || value === "minor" || value === "major";
}

/**
 * Read the release's hub impact off the paths it touched, and say whether the
 * chosen bump can carry it.
 *
 * `changedPaths` is null when there is no previous tag to diff against. That
 * is reported as `unknown` and does not block: the gate exists to catch a bump
 * contradicted by evidence, and refusing to release for want of a baseline
 * would make the first release after a wiped tag history impossible.
 */
export function classifyRelease(input: {
  bump: Bump;
  changedPaths: readonly string[] | null;
  removedWireNames: readonly string[];
}): ReleaseVerdict {
  const { bump, changedPaths, removedWireNames } = input;
  if (changedPaths === null) {
    return { bump, impact: "unknown", wirePaths: [], hubPaths: [], removed: [], disagreement: null };
  }

  // A unit test beside the hub's source is not part of it: `.dockerignore`
  // deletes `src/**/*.test.ts` out of the image build context.
  const shipped = changedPaths.filter((p) => !p.endsWith(".test.ts"));
  const wirePaths = shipped.filter((p) => matchesAny(p, WIRE_CONTRACT_PATHS));
  const hubPaths = shipped.filter((p) => matchesAny(p, HUB_SOURCE_PATHS) && !matchesAny(p, WIRE_CONTRACT_PATHS));
  const removed = [...removedWireNames];

  const impact: HubImpact =
    removed.length > 0 || wirePaths.length > 0 ? "wire-contract" : hubPaths.length > 0 ? "hub-source" : "cli-only";
  const requiredBump: Bump = removed.length > 0 ? "major" : impact === "cli-only" ? "patch" : "minor";
  const disagreement =
    BUMP_RANK[bump] < BUMP_RANK[requiredBump]
      ? { requiredBump, reason: disagreementReason(removed, wirePaths) }
      : null;

  return { bump, impact, wirePaths, hubPaths, removed, disagreement };
}

function matchesAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix));
}

function disagreementReason(removed: readonly string[], wirePaths: readonly string[]): string {
  if (removed.length > 0) {
    const names = removed.length === 1 ? "a name" : `${removed.length} names`;
    return `the wire contract dropped ${names} a client on the current version may still be sending`;
  }
  if (wirePaths.length > 0) {
    return "the wire contract changed, and a patch promises both sides can stay where they are";
  }
  return "the hub's own source changed, and a patch promises a deployed hub has nothing to do";
}

/** Long path lists are noise in a release note; the full set is in the diff. */
const MAX_LISTED = 10;

const HEADLINES: Record<HubImpact, { title: string; action: string }> = {
  "cli-only": {
    title: "no hub impact",
    action: "Pin the new version where the CLI runs. The deployed hub is unaffected.",
  },
  "hub-source": {
    title: "redeploy required",
    action: "An older hub keeps working. Redeploy it to pick this up.",
  },
  "wire-contract": {
    title: "both sides",
    action: "The hub and its clients share what changed. Check compatibility before moving one without the other.",
  },
  unknown: {
    title: "unknown",
    action: "No previous tag to compare against, so nothing was ruled out — assume a redeploy is needed.",
  },
};

/**
 * The verdict as Markdown, for both the job summary and the release body.
 * `override` is the reason a human gave for releasing past a disagreement; it
 * is rendered rather than swallowed, so the escape hatch is visible to whoever
 * reads the release later.
 */
export function renderVerdict(
  verdict: ReleaseVerdict,
  options: { base: string | null; override: string | null },
): string {
  const headline = HEADLINES[verdict.impact];
  const lines = [`### Hub impact: ${headline.title}`, ""];
  const against = options.base ? ` against \`${options.base}\`` : "";
  lines.push(`Released as \`${verdict.bump}\`${against}. ${headline.action}`, "");

  pushPathList(lines, "Wire contract touched", verdict.wirePaths);
  pushPathList(lines, "Hub source touched", verdict.hubPaths);
  pushPathList(lines, "Removed from the wire contract", verdict.removed);

  if (verdict.disagreement) {
    const { reason, requiredBump } = verdict.disagreement;
    const verb = options.override ? "Overridden" : "Release stopped";
    lines.push(`**${verb}:** ${reason} — \`${requiredBump}\` is the bump that carries this.`, "");
    if (options.override) {
      lines.push(`Released anyway: ${options.override}`, "");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function pushPathList(lines: string[], label: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`**${label}** (${items.length})`, "");
  for (const item of items.slice(0, MAX_LISTED)) lines.push(`- \`${item}\``);
  if (items.length > MAX_LISTED) lines.push(`- …and ${items.length - MAX_LISTED} more`);
  lines.push("");
}
