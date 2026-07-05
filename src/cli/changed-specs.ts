import {
  getChangedFiles,
  isPathAffectedBy,
  resolveBaseRef,
  type ChangedFile,
} from "../drift/affected.ts";
import { RunUsageError } from "../run/errors.ts";
import { listFeatureTree, parseBlockPath, type SpecRef } from "../store/index.ts";
import * as log from "./logger.ts";

/**
 * Filter specs to those affected by the git diff against the resolved base
 * ref. Powers `ccqa run --changed`; mirrors `ccqa drift --changed` minus the
 * LLM new-file router (kept off here for predictable CI cost).
 *
 * A spec is "affected" when it has no `relatedPaths` (conservatively
 * included), any changed file matches one of its `relatedPaths` globs, or it
 * includes a block whose YAML file changed.
 */
export async function collectChangedSpecs(
  specs: readonly SpecRef[],
  opts: { cwd: string; base?: string },
): Promise<SpecRef[]> {
  const { cwd, base } = opts;
  const baseRef = resolveBaseRef(base);

  let changed: ChangedFile[];
  try {
    changed = await getChangedFiles(baseRef, cwd);
  } catch (e) {
    throw new RunUsageError(`failed to run 'git diff' against ${baseRef}: ${(e as Error).message}`);
  }

  log.meta("changed-base", baseRef);
  log.meta("changed-files", changed.length);
  return filterAffectedSpecs(specs, changed, cwd);
}

/** Matching core: see `collectChangedSpecs` for the "affected" rules. */
async function filterAffectedSpecs(
  specs: readonly SpecRef[],
  changed: readonly { path: string }[],
  cwd: string,
): Promise<SpecRef[]> {
  if (changed.length === 0) return [];

  const tree = await listFeatureTree(cwd);
  const infoByKey = new Map(
    tree.flatMap((f) =>
      f.specs.map((sp) => [`${f.featureName}/${sp.specName}`, sp] as const),
    ),
  );

  const touchedBlockNames = new Set<string>();
  for (const f of changed) {
    const blockName = parseBlockPath(f.path);
    if (blockName) touchedBlockNames.add(blockName);
  }

  return specs.filter((s) => {
    const info = infoByKey.get(`${s.featureName}/${s.specName}`);
    if (!info?.relatedPaths) return true;
    const hit = changed.some((f) => isPathAffectedBy(f.path, info.relatedPaths!));
    if (hit) return true;
    return info.includedBlocks?.some((name) => touchedBlockNames.has(name)) ?? false;
  });
}
