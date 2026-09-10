import { relative, resolve } from "node:path";
import * as log from "../cli/logger.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import { resolveRoot } from "../coverage/session.ts";
import { execFileP, type ChangedFile } from "../drift/affected.ts";
import { parseBlockPath, specKey } from "../store/index.ts";
import type { CoverageEdges, CoverageEdgesReadout } from "./coverage-edges.ts";
import type { SpecDescription } from "./inventory.ts";
import type { SelectReport, SpecSelection } from "./types.ts";

export interface SelectSpecsInput {
  changed: readonly ChangedFile[];
  specs: readonly SpecDescription[];
  cwd: string;
  /**
   * Git repository `changed`'s paths are relative to (`--repo`). Defaults to
   * `cwd` — the common case where the `.ccqa` root and the diffed checkout
   * are the same directory. Kept apart from `cwd` because when they differ,
   * the measured-change re-root must anchor `changed` on the repo that
   * actually produced it, not on where `.ccqa/config.yaml` lives.
   */
  repo?: string;
  base: string;
  head: string;
  /**
   * What reading the hub's measurements yielded (`loadCoverageEdges`). The
   * readout is taken whole because its halves must never travel separately:
   * an absent edge selects a spec (it runs until a measurement lands,
   * ADR-0026) only when the read actually answered — a degraded read leaves
   * undecided specs `unknown`, so a hub hiccup cannot stampede the whole
   * suite into a run.
   */
  edges: CoverageEdgesReadout;
}

/**
 * Decide which specs a change set reaches.
 *
 * Two passes, in this order and for this reason: what a change to ccqa's own
 * tree settles is settled first, and only the remainder is held against
 * measured reach. A change to a spec's own file, or to a block it includes,
 * means that spec must re-run — reach cannot see the test's own definition,
 * so no measurement is consulted for it. Everything else intersects the diff
 * with the files the spec's last measured run actually reached (ADR-0024);
 * a spec with no measurement is `needed` — it runs until a measurement
 * lands, which is also what records its first edge (ADR-0026). Only when
 * the measurements could not be read does absence degrade to `unknown`.
 */
export async function selectSpecs(input: SelectSpecsInput): Promise<SelectReport> {
  const { changed, specs, cwd, base, head, edges } = input;
  const repo = input.repo ?? cwd;

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
      testPath: spec.testPath,
    });
  }

  const undecided = specs.filter((s) => !byKey.has(specKey(s)));
  let uncoveredFiles: string[] = [];

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
        testPath: spec.testPath,
      });
    }
  } else {
    // Run even when every spec was already decided mechanically: a product
    // change that no spec's measured reach touches is still worth reporting
    // as uncovered, independent of whether it moved any verdict.
    const judged = await judgeWithCoverage({ pending: undecided, productChanges, cwd, repo, edges });
    for (const selection of judged.selections) byKey.set(specKey(selection), selection);
    uncoveredFiles = judged.uncoveredFiles;
  }

  return {
    base,
    head,
    changedFiles: changed.length,
    // Inventory order, so two runs over the same tree produce comparable
    // output. Every spec is decided by one of the three passes above, but
    // flatMap over a possible miss is cheaper to reason about than asserting it.
    specs: specs.flatMap((s) => byKey.get(specKey(s)) ?? []),
    uncoveredFiles,
  };
}

/**
 * Split the diff into the part measured reach has to answer for and the part
 * that decides itself.
 *
 * `.ccqa/` paths are ccqa's own: a spec directory names the spec it belongs
 * to, a block names the specs that include it. A markdown case's own document
 * is matched the same way but by exact path (`sourcePath`) rather than a
 * directory prefix — it lives in the project's own tree, not under `.ccqa/`,
 * so there is no directory to claim on its behalf. Product paths carry no
 * such mapping — those are what the coverage intersection exists to answer.
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

  // Reverse index for `sourcePath`, an exact match rather than a prefix — a
  // spec's own directory is already caught above, so in practice this is what
  // catches a markdown case's document.
  const specsBySourcePath = new Map<string, SpecDescription>();
  for (const spec of specs) specsBySourcePath.set(spec.sourcePath, spec);

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

    const bySourcePath = specsBySourcePath.get(file.path);
    if (bySourcePath) {
      addTouch(specKey(bySourcePath), file.path);
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
  repo: string;
  edges: CoverageEdgesReadout;
}

interface JudgeResult {
  selections: SpecSelection[];
  uncoveredFiles: string[];
}

/**
 * Hold each undecided spec's last measured reach against the diff, and name
 * the product changes no spec's reach touched at all.
 *
 * Three verdict outcomes, and only one is a positive claim: a non-empty
 * intersection means `needed`, with the intersecting paths as the reason; an
 * empty one means `notNeeded` — the measurement accounts for everything the
 * spec reached, and the diff missed all of it; no measurement at all is also
 * `needed` — the spec runs until a measurement records its reach (ADR-0026)
 * — unless the read was degraded, in which case absence proves nothing and
 * the spec is left `unknown`. Changes outside the measured root fall out
 * of the comparison entirely: the root is the declared boundary of what
 * measurement governs, so what lies beyond it clears specs quietly — one
 * warning names the dropped paths, because a root configured too narrow
 * looks exactly like this and hides real reach (see docs/coverage.md).
 *
 * That "clears quietly" only holds when something is still left to compare.
 * When the re-root drops every product change — `--repo` naming a checkout
 * disjoint from `coverage.projectRoot` does this to all of them at once —
 * a spec that does have a measurement was never actually held against the
 * diff, so `notNeeded` there would report a comparison that never happened;
 * it is left `unknown` instead. A spec with no measurement at all is
 * unaffected — "never measured" is already true independent of the diff.
 */
async function judgeWithCoverage(input: JudgeInput): Promise<JudgeResult> {
  const { pending, productChanges, cwd, repo } = input;
  const { edges, degraded } = input.edges;

  const unreadable = "the hub's measured reach could not be read; not guessing";
  const roots = await resolveCoverageRoots(productChanges, cwd, repo);
  const measuredChanges = rerootChangesForCoverage(productChanges, roots);

  // Not a verdict changer, deliberately: the measured root is the declared
  // boundary of what measurement governs, and changes beyond it clear specs
  // the same way any unreached file does. Loud in the log rather than the
  // verdicts — a root configured too narrow produces exactly this shape.
  const dropped = productChanges.length - measuredChanges.length;
  if (dropped > 0) {
    log.warn(
      `select-specs: ${dropped} of ${productChanges.length} changed files fall outside ` +
        "coverage.projectRoot and cannot be compared against measured reach",
    );
  }
  // A total drop means the intersection below would run against nothing, so
  // a spec with a measured edge would clear vacuously — "reached none of the
  // changed files" when no file could actually be checked against it.
  const totalDrop = productChanges.length > 0 && measuredChanges.length === 0;
  const rootMismatch =
    "every changed file fell outside coverage.projectRoot; the comparison could not be made, not guessing";

  const selections = pending.map((spec): SpecSelection => {
    const edge = edges.get(specKey(spec));
    // No measurement is not "unreached": the spec is selected, and running it
    // is exactly what records its first edge (ADR-0026). Only a degraded
    // read turns absence into `unknown` — the measurements may exist.
    if (!edge) {
      if (degraded) return unknownSelection(spec, unreadable);
      return {
        featureName: spec.featureName,
        specName: spec.specName,
        verdict: "needed" as const,
        source: "coverage" as const,
        reason: "never measured: the spec runs until a measurement records its reach",
        testPath: spec.testPath,
      };
    }
    if (totalDrop) return unknownSelection(spec, rootMismatch);
    const touchedBy = measuredChanges.filter((c) => edge.files.has(c.measured)).map((c) => c.original);
    if (touchedBy.length > 0) {
      return {
        featureName: spec.featureName,
        specName: spec.specName,
        verdict: "needed" as const,
        source: "coverage" as const,
        reason: "the change touches files this spec's last measured run reached",
        touchedBy,
        testPath: spec.testPath,
      };
    }
    return {
      featureName: spec.featureName,
      specName: spec.specName,
      verdict: "notNeeded" as const,
      source: "coverage" as const,
      reason: "the spec's last measured run reached none of the changed files",
      testPath: spec.testPath,
    };
  });

  // Degraded reach can't tell "no spec reached this" from "we couldn't read
  // any spec's reach" — reporting it as uncovered here would be exactly the
  // false positive the verdict side already refuses to guess at above.
  const uncoveredFiles = degraded ? [] : uncoveredProductFiles(measuredChanges, edges);

  return { selections, uncoveredFiles };
}

/** Measured changes (already confined to the coverage root) touched by no spec's edge, by original path. */
function uncoveredProductFiles(measuredChanges: MeasuredChange[], edges: CoverageEdges): string[] {
  const reached = new Set<string>();
  for (const edge of edges.values()) {
    for (const file of edge.files) reached.add(file);
  }
  return measuredChanges.filter((c) => !reached.has(c.measured)).map((c) => c.original);
}

function unknownSelection(spec: SpecDescription, reason: string): SpecSelection {
  return {
    featureName: spec.featureName,
    specName: spec.specName,
    verdict: "unknown",
    source: "coverage",
    reason,
    testPath: spec.testPath,
  };
}

/** A product change addressed both ways: as the diff names it, and as a measurement would. */
export interface MeasuredChange {
  /** The diff's own path: relative to `repo` (or `cwd` when no `--repo`), or repo-root relative when `outsideCwd`. */
  original: string;
  /** The same file relative to `coverage.projectRoot`, the base measured files are stored under. */
  measured: string;
}

/**
 * Re-root diff paths to the measurement's own base. The two sides must speak
 * the same paths or every intersection silently misses (ADR-0024): the diff
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
 * `.ccqa/config.yaml` (defaults to `cwd` — config always lives at the `.ccqa`
 * root, even when `--repo` names a different checkout), and the git repo
 * root — resolved from `repo`, only when an `outsideCwd` entry exists to
 * anchor.
 *
 * The returned `cwd` is `repo`, not the `.ccqa` root: `changed`'s paths came
 * from a diff run in `repo` (`getChangedFilesBetween(..., repo, ...)`), so
 * that is what a non-`outsideCwd` entry is relative to.
 *
 * The projectRoot goes through the measurement's own `resolveRoot` — env refs
 * expanded, the directory verified to exist and contain cwd — and a config it
 * rejects fails here too. Resolving it any other way would silently re-root
 * every path somewhere the measurement never stored files under.
 */
async function resolveCoverageRoots(
  changed: readonly ChangedFile[],
  cwd: string,
  repo: string,
): Promise<{ cwd: string; repoRoot: string | null; coverageRoot: string }> {
  const config = await loadProjectConfig(cwd);
  const coverageRoot = (await resolveRoot(cwd, config.coverage?.projectRoot)) ?? resolve(cwd);
  let repoRoot: string | null = null;
  if (changed.some((f) => f.outsideCwd)) {
    try {
      const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd: repo });
      repoRoot = stdout.trim();
    } catch {
      // Not a git repo: outsideCwd entries cannot be anchored, so the
      // re-root skips them.
    }
  }
  return { cwd: resolve(repo), repoRoot, coverageRoot };
}
