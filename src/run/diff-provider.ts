import { stripLeadingDotSlash } from "../drift/affected.ts";
import {
  capturePrDiff,
  type PatchSection,
  scopePatchForSpec,
  splitPatchByFile,
} from "../report/diff.ts";
import { listFeatureTree, specKey, type SpecRef } from "../store/index.ts";
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
   * Unified patch, confined to the working directory and scoped to the spec's
   * relatedPaths, then truncated. Null when the capture failed.
   */
  patch: string | null;
  /** `git diff --name-status` for the same range — cheap, never truncated. */
  nameStatus: string | null;
  /** Why the diff is unavailable, or null when it was captured. */
  error: string | null;
  /**
   * On-demand hunk lookup over the FULL (unscoped) captured diff, backing the
   * classifier's `changed_file_diff` MCP tool: the inline `patch` is only the
   * relatedPaths-scoped seed, and this is how changes outside that scope are
   * pulled into context when (and only when) the model asks for them. Null
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
 * on their own, which left three defects: a live-only run recorded no git
 * metadata at all, the live path fed the classifier the *entire* patch
 * instead of scoping it to the spec's relatedPaths, and neither could evolve
 * its baseline (fixed ref vs per-spec last-green) without the other drifting.
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
  nameStatus: string | null;
  error: string | null;
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
  let relatedPathsIndex: Promise<Map<string, string[] | null>> | null = null;

  function capture(sha: string): Promise<CapturedDiff> {
    const cached = captures.get(sha);
    if (cached) return cached;
    const pending = (async (): Promise<CapturedDiff> => {
      const result = await capturePrDiff(sha, cwd);
      if (!result.ok) return { sections: null, nameStatus: null, error: result.error };
      const { patch, nameStatus } = result.diff;
      return {
        sections: patch.length > 0 ? splitPatchByFile(patch) : [],
        nameStatus,
        error: null,
      };
    })();
    captures.set(sha, pending);
    return pending;
  }

  /** relatedPaths for every spec, read once from the feature tree. */
  function relatedPaths(): Promise<Map<string, string[] | null>> {
    relatedPathsIndex ??= listFeatureTree(cwd).then(
      (tree) =>
        new Map(
          tree.flatMap((f) =>
            f.specs.map((s) => [specKey({ featureName: f.featureName, specName: s.specName }), s.relatedPaths ?? null] as const),
          ),
        ),
    );
    return relatedPathsIndex;
  }

  return {
    async forSpec(spec) {
      const resolved = await resolveBase(spec);
      if (!resolved.ok) return resolved;
      const [captured, index] = await Promise.all([capture(resolved.base.sha), relatedPaths()]);
      const scope = index.get(specKey(spec)) ?? null;
      const sections = captured.sections;
      return {
        ok: true,
        base: resolved.base,
        patch: sections ? scopePatchForSpec(sections, scope) : null,
        nameStatus: captured.nameStatus,
        error: captured.error,
        fileDiff: (path) => (sections ? lookupFileDiff(sections, path) : null),
      };
    },
  };
}
