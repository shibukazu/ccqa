import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectIncludedBlockNames } from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  getCcqaDir,
  listAllSpecsWithSpecFile,
  parseSpecPath,
  specFilePath,
  specKey,
  loadAllBlocks,
} from "../store/index.ts";
import type { BlockSpec } from "../types.ts";
import { errMessage } from "../run/errors.ts";
import { caseFromSpec } from "./case.ts";
import type { CaseAdapter, CaseRead } from "./source.ts";

/**
 * ccqa's own `spec.yaml` as a case source.
 *
 * The functions that read a spec file live here rather than in the store, so
 * that a feature wanting a case document has no import that reaches one kind
 * of case directly. The store still says where the file is (`specFilePath`)
 * and still enumerates the tree — the layout is its business; reading a case
 * is not.
 */

/** One case's `spec.yaml`, null when there is no such file. */
export async function tryReadSpecFile(
  featureName: string,
  specName: string,
  cwd?: string,
): Promise<string | null> {
  return readFile(specFilePath(featureName, specName, cwd), "utf-8").catch(() => null);
}

export interface FeatureTreeSpec {
  specName: string;
  hasSpecFile: boolean;
  /** Names of blocks this spec includes. Empty array when none. */
  includedBlocks?: string[];
}

export interface FeatureTreeEntry {
  featureName: string;
  specs: FeatureTreeSpec[];
}

/**
 * Lists every feature/spec dir under .ccqa/features/, regardless of whether
 * the spec is fully drafted yet. Each spec file is read at most once.
 *
 * Only `ccqa draft` still asks for this: it authors ccqa's own format, so it
 * is the one command whose subject is the tree rather than the cases in it.
 */
export async function listFeatureTree(cwd?: string): Promise<FeatureTreeEntry[]> {
  const featuresDir = join(getCcqaDir(cwd), "features");
  const featureDirs = await readdir(featuresDir).catch(() => []);

  return Promise.all(
    featureDirs.map(async (featureName): Promise<FeatureTreeEntry> => {
      const testCasesDir = join(featuresDir, featureName, "test-cases");
      const specDirs = await readdir(testCasesDir).catch(() => []);
      const specs = await Promise.all(
        specDirs.map(async (specName): Promise<FeatureTreeSpec> => {
          const specFile = join(testCasesDir, specName, "spec.yaml");
          const content = await readFile(specFile, "utf-8").catch(() => null);
          if (content === null) return { specName, hasSpecFile: false };
          try {
            const spec = parseTestSpec(content, specFile);
            return {
              specName,
              hasSpecFile: true,
              includedBlocks: collectIncludedBlockNames(spec),
            };
          } catch {
            return { specName, hasSpecFile: true };
          }
        }),
      );
      return { featureName, specs };
    }),
  );
}

export function specCaseSource(cwd: string): CaseAdapter {
  // Blocks are shared by every spec, so the whole tree pays for one load.
  let blocks: Promise<Map<string, BlockSpec>> | null = null;
  return {
    async list(): Promise<string[]> {
      return (await listAllSpecsWithSpecFile(cwd)).map(specKey).sort();
    },
    // A spec id has its own spellings (`f/s`, `features/f/test-cases/s`), and
    // an unrecognised shape is the operator mistyping a CLI argument.
    idFor: (ref) => specKey(parseSpecPath(ref)),
    async read(id): Promise<CaseRead> {
      const { featureName, specName } = parseSpecPath(id);
      const path = specFilePath(featureName, specName, cwd);
      const yaml = await tryReadSpecFile(featureName, specName, cwd);
      if (yaml === null) {
        return { id, case: null, document: null, error: `Spec file not found: ${path}` };
      }
      const document = { path, text: yaml };
      blocks ??= loadAllBlocks(cwd);
      try {
        const read = caseFromSpec(featureName, specName, yaml, await blocks, cwd);
        return { id, case: read, document, error: null };
      } catch (err) {
        return { id, case: null, document, error: errMessage(err) };
      }
    },
  };
}
