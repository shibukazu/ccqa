import {
  capturePrDiff,
  type PatchSection,
  scopePatchForSpec,
  splitPatchByFile,
} from "../report/diff.ts";
import { listFeatureTree } from "../store/index.ts";
import type { AnalysisBase } from "./git-context.ts";

export interface SpecKey {
  featureName: string;
  specName: string;
}

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
}

/**
 * Resolves "what changed" for one failing spec.
 *
 * This exists to collapse two divergent implementations. The deterministic
 * path and the live path each used to resolve a base ref and capture a diff
 * on their own, which left three defects: a live-only run recorded no git
 * metadata at all, the live path fed the classifier the *entire* patch
 * instead of scoping it to the spec's relatedPaths, and neither could evolve
 * its baseline (e.g. per-spec last-green) without the other drifting.
 *
 * Captures are lazy (nothing runs on a green run) and memoized per base sha,
 * so N failing specs sharing a baseline cost one `git diff`.
 */
export interface DiffProvider {
  forSpec(spec: SpecKey): Promise<SpecDiff>;
}

interface CapturedDiff {
  sections: PatchSection[] | null;
  nameStatus: string | null;
  error: string | null;
}

export function createDiffProvider(args: { base: AnalysisBase; cwd: string }): DiffProvider {
  const { base, cwd } = args;
  // Keyed by base sha, not ref: refs can move mid-run, shas cannot — and the
  // per-spec baselines of a future `last-green` mode collapse into one
  // capture whenever they point at the same commit.
  const captures = new Map<string, Promise<CapturedDiff>>();
  let relatedPathsIndex: Promise<Map<string, string[] | null>> | null = null;

  function capture(b: AnalysisBase): Promise<CapturedDiff> {
    const cached = captures.get(b.sha);
    if (cached) return cached;
    const pending = (async (): Promise<CapturedDiff> => {
      const result = await capturePrDiff(b.sha, cwd);
      if (!result.ok) return { sections: null, nameStatus: null, error: result.error };
      const { patch, nameStatus } = result.diff;
      return {
        sections: patch.length > 0 ? splitPatchByFile(patch) : [],
        nameStatus,
        error: null,
      };
    })();
    captures.set(b.sha, pending);
    return pending;
  }

  /** relatedPaths for every spec, read once from the feature tree. */
  function relatedPaths(): Promise<Map<string, string[] | null>> {
    relatedPathsIndex ??= listFeatureTree(cwd).then(
      (tree) =>
        new Map(
          tree.flatMap((f) =>
            f.specs.map((s) => [`${f.featureName}/${s.specName}`, s.relatedPaths ?? null] as const),
          ),
        ),
    );
    return relatedPathsIndex;
  }

  return {
    async forSpec(spec) {
      const [captured, index] = await Promise.all([capture(base), relatedPaths()]);
      const scope = index.get(`${spec.featureName}/${spec.specName}`) ?? null;
      return {
        base,
        patch: captured.sections ? scopePatchForSpec(captured.sections, scope) : null,
        nameStatus: captured.nameStatus,
        error: captured.error,
      };
    },
  };
}
