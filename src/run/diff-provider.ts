import { execFileP, stripLeadingDotSlash } from "../drift/affected.ts";
import { capturePrDiff, type PatchSection, splitPatchByFile, truncatePatch } from "../report/diff.ts";
import type { SpecRef } from "../store/index.ts";
import type { AnalysisBase } from "./git-context.ts";

/**
 * Per-spec baseline resolution. `ok: false` means this spec has no usable
 * baseline (e.g. never green in the last-green ledger, or its baseline
 * commit isn't in this checkout) — the caller records `skip` as the row's
 * analysisSkipped instead of classifying.
 */
export type SpecBaseResolution = { ok: true; base: AnalysisBase } | { ok: false; skip: string };

export type { SpecRef };

/** The source-change context handed to one spec's failure analysis. */
export interface SpecDiff {
  /** The baseline this spec was diffed against. */
  base: AnalysisBase;
  /**
   * Unified patch, confined to the working directory and truncated. Null when
   * the capture failed.
   */
  patch: string | null;
  /** `git diff --name-status` for the same range — cheap, never truncated. */
  nameStatus: string | null;
  /** Why the diff is unavailable, or null when it was captured. */
  error: string | null;
  /**
   * How wide the base..HEAD range is — commits reachable from HEAD but not
   * the base, and calendar days between the base commit and HEAD. Feeds the
   * prompt's wide-baseline guidance. Null when the lookup failed.
   */
  range: { commitCount: number; days: number } | null;
  /**
   * On-demand hunk lookup over the full captured diff, backing the
   * classifier's `changed_file_diff` MCP tool: the inline `patch` is only the
   * truncated seed, and this is how a file dropped or cut by truncation is
   * pulled into context when (and only when) the model asks for it. Null
   * when `path` has no changes in the diff range or the capture failed.
   */
  fileDiff: (path: string) => string | null;
}

export type SpecDiffResult = ({ ok: true } & SpecDiff) | { ok: false; skip: string };

/**
 * Cap on one on-demand file-diff response. Larger than the inline seed's
 * per-file cap (the model explicitly asked for this file), but still bounded
 * so a generated-file hunk can't blow the context — the truncation note
 * points at Read for the file's full current state.
 */
export const FILE_DIFF_RESPONSE_CAP = 16 * 1024;

/** Find `path`'s section in a split patch and cap it. Exported for tests. */
export function lookupFileDiff(sections: PatchSection[], path: string): string | null {
  const normalized = stripLeadingDotSlash(path);
  const section = sections.find((s) => s.path === normalized);
  if (!section) return null;
  if (section.body.length <= FILE_DIFF_RESPONSE_CAP) return section.body;
  return `${section.body.slice(0, FILE_DIFF_RESPONSE_CAP)}\n[truncated: ${section.body.length - FILE_DIFF_RESPONSE_CAP} more chars — Read the file for its full current state]`;
}

/**
 * Resolves "what changed" for one failing spec.
 *
 * This exists to collapse two divergent implementations. The deterministic
 * path and the live path each used to resolve a base ref and capture a diff
 * on their own, which left two defects: a live-only run recorded no git
 * metadata at all, and neither could evolve its baseline (fixed ref vs
 * per-spec last-green) without the other drifting.
 *
 * The baseline comes from `resolveBase` per spec — a constant for
 * `--failure-analysis=<ref>`, a hub-ledger lookup for
 * `--failure-analysis=last-green`. Captures are lazy (nothing runs on a
 * green run) and memoized per base sha, so N failing specs sharing a
 * baseline commit cost one `git diff`.
 */
export interface DiffProvider {
  forSpec(spec: SpecRef): Promise<SpecDiffResult>;
}

interface CapturedDiff {
  sections: PatchSection[] | null;
  /**
   * Truncated to `TOTAL_PATCH_CAP`. Built once here, not per spec: with
   * `relatedPaths` scoping gone, every spec sharing this base sha truncates
   * the same sections to the same output, so recomputing it per failing spec
   * was pure waste.
   */
  patch: string | null;
  nameStatus: string | null;
  error: string | null;
  range: { commitCount: number; days: number } | null;
}

/**
 * Best-effort width of the base..HEAD range. Two-dot rev-list matches what
 * the three-dot diff shows: commits on the HEAD side since the merge base.
 */
async function measureRange(
  sha: string,
  cwd: string,
): Promise<{ commitCount: number; days: number } | null> {
  try {
    const [{ stdout: count }, { stdout: baseTime }, { stdout: headTime }] = await Promise.all([
      execFileP("git", ["rev-list", "--count", `${sha}..HEAD`], { cwd }),
      execFileP("git", ["log", "-1", "--format=%ct", sha], { cwd }),
      execFileP("git", ["log", "-1", "--format=%ct", "HEAD"], { cwd }),
    ]);
    const seconds = Number(headTime.trim()) - Number(baseTime.trim());
    return {
      commitCount: Number(count.trim()),
      days: Math.max(0, Math.round(seconds / 86_400)),
    };
  } catch {
    return null;
  }
}

export function createDiffProvider(args: {
  resolveBase: (spec: SpecRef) => Promise<SpecBaseResolution>;
  cwd: string;
}): DiffProvider {
  const { resolveBase, cwd } = args;
  // Keyed by base sha, not ref: refs can move mid-run, shas cannot — and the
  // per-spec baselines of last-green mode collapse into one capture whenever
  // they point at the same commit.
  const captures = new Map<string, Promise<CapturedDiff>>();

  function capture(sha: string): Promise<CapturedDiff> {
    const cached = captures.get(sha);
    if (cached) return cached;
    const pending = (async (): Promise<CapturedDiff> => {
      const [result, range] = await Promise.all([capturePrDiff(sha, cwd), measureRange(sha, cwd)]);
      if (!result.ok) return { sections: null, patch: null, nameStatus: null, error: result.error, range };
      const { patch: rawPatch, nameStatus } = result.diff;
      const sections = rawPatch.length > 0 ? splitPatchByFile(rawPatch) : [];
      return {
        sections,
        patch: truncatePatch(sections),
        nameStatus,
        error: null,
        range,
      };
    })();
    captures.set(sha, pending);
    return pending;
  }

  return {
    async forSpec(spec) {
      const resolved = await resolveBase(spec);
      if (!resolved.ok) return resolved;
      const captured = await capture(resolved.base.sha);
      return {
        ok: true,
        base: resolved.base,
        patch: captured.patch,
        nameStatus: captured.nameStatus,
        error: captured.error,
        range: captured.range,
        fileDiff: (path) => (captured.sections ? lookupFileDiff(captured.sections, path) : null),
      };
    },
  };
}
