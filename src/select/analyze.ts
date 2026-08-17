import { relative, resolve } from "node:path";
import { loadProjectConfig } from "../config/project-config.ts";
import { resolveRoot } from "../coverage/session.ts";
import { execFileP, type ChangedFile } from "../drift/affected.ts";
import { parseBlockPath, specKey } from "../store/index.ts";
import type { CoverageEdges } from "./coverage-edges.ts";
import type { SpecDescription } from "./inventory.ts";
import type { SelectReport, SpecSelection } from "./types.ts";

export interface SelectSpecsInput {
  changed: readonly ChangedFile[];
  specs: readonly SpecDescription[];
  cwd: string;
  base: string;
  head: string;
  /**
   * Measured reach per spec, from the hub (`loadCoverageEdges`). An empty
   * map — nothing measured yet, or the hub unreadable — leaves every
   * undecided spec `unknown`, which the caller runs.
   */
  edges: CoverageEdges;
}

/**
 * Decide which specs a change set reaches.
 *
 * Two passes, in this order and for this reason: what a change to ccqa's own
 * tree settles is settled first, and only the remainder is held against
 * measured reach. A change to a spec's own file, or to a block it includes,
 * means that spec must re-run — reach cannot see the test's own definition,
 * so no measurement is consulted for it. Everything else intersects the diff
 * with the files the spec's last measured run actually reached (ADR-0023);
 * a spec with no measurement stays `unknown`, because an unmeasured edge is
 * not an unreached one.
 */
export async function selectSpecs(input: SelectSpecsInput): Promise<SelectReport> {
  const { changed, specs, cwd, base, head, edges } = input;

  const { productChanges, mechanicallyNeeded } = partitionChanges(changed, specs);
  const byInventoryKey = new Map(specs.map((s) => [specKey(s), s]));
  const byKey = new Map<string, SpecSelection>();

  for (const [key, touchedBy] of mechanicallyNeeded) {
    const spec = byInventoryKey.get(key);
    if (!spec) continue;
    byKey.set(key, {
      featureName: spec.featureName,
      specName: spec.specName,
      verdict: "needed",
      source: "mechanical",
      reason: "the spec's own definition changed, or a block it includes did",
      touchedBy,
    });
  }

  const undecided = specs.filter((s) => !byKey.has(specKey(s)));

  if (productChanges.length === 0) {
    // Nothing outside `.ccqa/` moved, so no product behaviour can have
    // changed. Clearing the rest here costs nothing and consults no
    // measurement — the common case on a docs-only or spec-only commit.
    for (const spec of undecided) {
      byKey.set(specKey(spec), {
        featureName: spec.featureName,
        specName: spec.specName,
        verdict: "notNeeded",
        source: "mechanical",
        reason: "no file outside .ccqa/ changed in this range",
      });
    }
  } else if (undecided.length > 0) {
    for (const selection of await judgeWithCoverage({ pending: undecided, productChanges, cwd, edges })) {
      byKey.set(specKey(selection), selection);
    }
  }

  return {
    base,
    head,
    changedFiles: changed.length,
    // Inventory order, so two runs over the same tree produce comparable
    // output. Every spec is decided by one of the three passes above, but
    // flatMap over a possible miss is cheaper to reason about than asserting it.
    specs: specs.flatMap((s) => byKey.get(specKey(s)) ?? []),
  };
}

/**
 * Split the diff into the part measured reach has to answer for and the part
 * that decides itself.
 *
 * `.ccqa/` paths are ccqa's own: a spec directory names the spec it belongs
 * to, a block names the specs that include it. Product paths carry no such
 * mapping — those are what the coverage intersection exists to answer.
 */
function partitionChanges(
  changed: readonly ChangedFile[],
  specs: readonly SpecDescription[],
): { productChanges: ChangedFile[]; mechanicallyNeeded: Map<string, string[]> } {
  const productChanges: ChangedFile[] = [];
  const mechanicallyNeeded = new Map<string, string[]>();
  const addTouch = (key: string, path: string) => {
    const existing = mechanicallyNeeded.get(key);
    if (existing) existing.push(path);
    else mechanicallyNeeded.set(key, [path]);
  };

  // Reverse index built once, so a changed block is matched against its
  // including specs directly instead of scanning every spec per block file.
  const specsByBlock = new Map<string, SpecDescription[]>();
  for (const spec of specs) {
    for (const blockName of spec.includedBlocks) {
      const including = specsByBlock.get(blockName);
      if (including) including.push(spec);
      else specsByBlock.set(blockName, [spec]);
    }
  }

  for (const file of changed) {
    // A sibling package's `.ccqa/` is not ours: its spec and block names live
    // in a different tree and must not invalidate specs here.
    if (file.outsideCwd) {
      productChanges.push(file);
      continue;
    }

    const specDirKey = parseSpecDirPath(file.path);
    if (specDirKey) {
      addTouch(specDirKey, file.path);
      continue;
    }

    const blockName = parseBlockPath(file.path);
    if (blockName) {
      for (const spec of specsByBlock.get(blockName) ?? []) addTouch(specKey(spec), file.path);
      continue;
    }

    // Anything else under `.ccqa/` (config, sessions, reports) has no spec to
    // attribute it to, and is not product code either. Dropping it keeps it
    // out of the intersection rather than inviting a spurious match.
    if (!isCcqaPath(file.path)) productChanges.push(file);
  }

  return { productChanges, mechanicallyNeeded };
}

/** `<feature>/<spec>` for a path inside a spec's own directory, else null. */
export function parseSpecDirPath(path: string): string | null {
  const match = path.match(/(?:^|\/)\.ccqa\/features\/([^/]+)\/test-cases\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

function isCcqaPath(path: string): boolean {
  return /(?:^|\/)\.ccqa\//.test(path);
}

interface JudgeInput {
  pending: SpecDescription[];
  productChanges: ChangedFile[];
  cwd: string;
  edges: CoverageEdges;
}

/**
 * Hold each undecided spec's last measured reach against the diff.
 *
 * Three outcomes, and only the middle one is a positive claim: no
 * measurement means `unknown` (an unmeasured edge is not an unreached one —
 * the absence of evidence runs the spec); a non-empty intersection means
 * `needed`, with the intersecting paths as the reason; an empty one means
 * `notNeeded` — the measurement accounts for everything the spec reached,
 * and the diff missed all of it. That last claim holds only while some part
 * of the diff survived re-rooting; if none did, every pending spec stays
 * `unknown` instead.
 */
async function judgeWithCoverage(input: JudgeInput): Promise<SpecSelection[]> {
  const { pending, productChanges, cwd, edges } = input;

  const noMeasurement = "no measurement to consult: the hub holds no measured reach for this spec";
  if (edges.size === 0) {
    return pending.map((s) => unknownSelection(s, noMeasurement));
  }

  const roots = await resolveCoverageRoots(productChanges, cwd);
  const measuredChanges = rerootChangesForCoverage(productChanges, roots);

  // Every product change re-rooted outside the measured base, so no edge could
  // ever match — an empty intersection here is missing evidence, not evidence
  // of absence, and clearing specs against it would skip real regressions.
  if (productChanges.length > 0 && measuredChanges.length === 0) {
    return pending.map((s) =>
      unknownSelection(s, "the changes fell outside the measured root; nothing to compare"),
    );
  }

  return pending.map((spec) => {
    const edge = edges.get(specKey(spec));
    if (!edge) return unknownSelection(spec, noMeasurement);
    const touchedBy = measuredChanges.filter((c) => edge.files.has(c.measured)).map((c) => c.original);
    if (touchedBy.length > 0) {
      return {
        featureName: spec.featureName,
        specName: spec.specName,
        verdict: "needed" as const,
        source: "coverage" as const,
        reason: "the change touches files this spec's last measured run reached",
        touchedBy,
      };
    }
    return {
      featureName: spec.featureName,
      specName: spec.specName,
      verdict: "notNeeded" as const,
      source: "coverage" as const,
      reason: "the spec's last measured run reached none of the changed files",
    };
  });
}

function unknownSelection(spec: SpecDescription, reason: string): SpecSelection {
  return {
    featureName: spec.featureName,
    specName: spec.specName,
    verdict: "unknown",
    source: "coverage",
    reason,
  };
}

/** A product change addressed both ways: as the diff names it, and as a measurement would. */
export interface MeasuredChange {
  /** The diff's own path: cwd-relative, or repo-root relative when `outsideCwd`. */
  original: string;
  /** The same file relative to `coverage.projectRoot`, the base measured files are stored under. */
  measured: string;
}

/**
 * Re-root diff paths to the measurement's own base. The two sides must speak
 * the same paths or every intersection silently misses (ADR-0023): the diff
 * is cwd-relative (repo-root relative for `outsideCwd` entries) while
 * measured files are `coverage.projectRoot`-relative. A file resolving
 * outside the coverage root is dropped — the measurement drops those files
 * too, so it could never intersect an edge.
 */
export function rerootChangesForCoverage(
  changed: readonly ChangedFile[],
  roots: { cwd: string; repoRoot: string | null; coverageRoot: string },
): MeasuredChange[] {
  const out: MeasuredChange[] = [];
  for (const file of changed) {
    const base = file.outsideCwd ? roots.repoRoot : roots.cwd;
    // An outsideCwd entry with no repo root has nothing to anchor it; skipped
    // rather than guessed at, like the measurement itself would.
    if (base === null) continue;
    // Measured files are posix paths, whatever the host separator is.
    const measured = relative(roots.coverageRoot, resolve(base, file.path)).replaceAll("\\", "/");
    if (measured.startsWith("..")) continue;
    out.push({ original: file.path, measured });
  }
  return out;
}

/**
 * The roots `rerootChangesForCoverage` needs: `coverage.projectRoot` from
 * `.ccqa/config.yaml` (defaults to cwd), and the git repo root — resolved
 * only when an `outsideCwd` entry exists to anchor.
 *
 * The projectRoot goes through the measurement's own `resolveRoot` — env refs
 * expanded, the directory verified to exist and contain cwd — and a config it
 * rejects fails here too. Resolving it any other way would silently re-root
 * every path somewhere the measurement never stored files under.
 */
async function resolveCoverageRoots(
  changed: readonly ChangedFile[],
  cwd: string,
): Promise<{ cwd: string; repoRoot: string | null; coverageRoot: string }> {
  const config = await loadProjectConfig(cwd);
  const coverageRoot = (await resolveRoot(cwd, config.coverage?.projectRoot)) ?? resolve(cwd);
  let repoRoot: string | null = null;
  if (changed.some((f) => f.outsideCwd)) {
    try {
      const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd });
      repoRoot = stdout.trim();
    } catch {
      // Not a git repo: outsideCwd entries cannot be anchored, so the
      // re-root skips them.
    }
  }
  return { cwd: resolve(cwd), repoRoot, coverageRoot };
}
