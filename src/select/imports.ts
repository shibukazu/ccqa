import { resolve } from "node:path";
import type { ChangedFile } from "../drift/affected.ts";
import { specKey } from "../store/index.ts";
import {
  loadTsconfigPaths,
  walkSupportFiles,
  SELECTION_IMPORT_DEPTH,
} from "../targets/support-files.ts";
import type { SpecDescription } from "./inventory.ts";
import type { SpecSelection } from "./types.ts";

/**
 * Selection by import edge: a case is selected when the diff touches the test
 * it compiled to, or any project file that test imports.
 *
 * Measured reach answers one question — which product files did this case's
 * browser load — and a page object or helper living in the test tree is loaded
 * by none of them. Held against measured reach alone, editing one therefore
 * clears every case that uses it, which is the opposite of the truth. An
 * import edge is the same fact the audit already reads a case's support files
 * by (`collectSupportFiles`), so selection reads it the same way.
 *
 * This pass only ever answers `needed`. It has no verdict that clears a case,
 * so it needs no flag and composes over whatever another pass decided.
 *
 * The walk is per case, with no sharing across cases, so its cost is bounded
 * per case rather than per suite. If hundreds of cases share deep support
 * trees, the fix is a shared resolution cache inside `collectSupportFiles`,
 * not here.
 */

/** A changed file addressed as a path on disk, beside the path the diff named it by. */
export interface ProjectChange {
  /** The diff's own path — what `touchedBy` must report. */
  original: string;
  abs: string;
}

/** One case's import graph, as far as the walk got. */
export interface CaseImports {
  files: ReadonlySet<string>;
  /** The walk hit a cap, so absence from `files` is not evidence of absence. */
  truncated: boolean;
}

/**
 * The cases the diff reaches through an import edge, by spec key. `imports`
 * holds each case's test and everything that test imports, absolute.
 *
 * A case whose walk was truncated is selected whatever the diff touched: what
 * it imports is not fully known, so nothing downstream may clear it on the
 * strength of a set that is missing entries. Conservative in the one direction
 * this pass can be — it has no verdict that clears anything.
 *
 * Pure — the walking happens in `selectByImports` — so the composition this
 * feeds can be exercised without a tree on disk.
 */
export function importSelections(
  cases: readonly SpecDescription[],
  changed: readonly ProjectChange[],
  imports: ReadonlyMap<string, CaseImports>,
): Map<string, SpecSelection> {
  const selections = new Map<string, SpecSelection>();
  for (const testCase of cases) {
    const key = specKey(testCase);
    const walk = imports.get(key);
    if (!walk) continue;
    const touched = changed.filter((c) => walk.files.has(c.abs));
    const base = {
      featureName: testCase.featureName,
      specName: testCase.specName,
      verdict: "needed" as const,
      source: "mechanical" as const,
      testPath: testCase.testPath,
    };
    if (touched.length > 0) {
      selections.set(key, {
        ...base,
        reason: `the change touches the case's test or a file it imports: ${touched[0]!.original}`,
        touchedBy: touched.map((c) => c.original),
      });
    } else if (walk.truncated) {
      selections.set(key, {
        ...base,
        reason:
          "the case imports more files than the walk reads, so whether the change reaches it " +
          "could not be decided",
      });
    }
  }
  return selections;
}

/**
 * The whole pass: which of `pending` the changes reach by import, if any.
 *
 * The gate is here rather than at the call site, so the walk is paid for only
 * when it could answer: with no changed file inside the project tree there is
 * nothing an import edge could match, and a diff confined to a sibling
 * checkout is exactly that.
 */
export async function selectByImports(
  pending: readonly SpecDescription[],
  changed: readonly ChangedFile[],
  cwd: string,
  repo: string,
): Promise<Map<string, SpecSelection>> {
  const inProject = projectChanges(changed, repo, cwd);
  if (inProject.length === 0) return new Map();
  return importSelections(pending, inProject, await caseImports(pending, cwd));
}

/**
 * Changed files lying inside the project tree, absolutised. `outsideCwd`
 * entries are dropped rather than anchored: the import walk never leaves
 * `cwd`, so a file outside it can be in no case's support set.
 */
function projectChanges(
  changed: readonly ChangedFile[],
  repo: string,
  cwd: string,
): ProjectChange[] {
  const root = resolve(cwd);
  const inProject: ProjectChange[] = [];
  for (const file of changed) {
    if (file.outsideCwd) continue;
    const abs = resolve(repo, file.path);
    if (!abs.startsWith(`${root}/`)) continue;
    inProject.push({ original: file.path, abs });
  }
  return inProject;
}

/**
 * Walk each case's test out to the files it imports, never into
 * `node_modules`, with the `tsconfig` aliases read once and shared. Deeper
 * than the audit's walk: a page object that reaches a fixture that reaches a
 * helper is three hops before the case's own test is counted, and a chain cut
 * there would leave the diff's file outside a set this pass reads as complete.
 * A live case compiled nothing, so it has no entry to walk from.
 */
async function caseImports(
  cases: readonly SpecDescription[],
  cwd: string,
): Promise<Map<string, CaseImports>> {
  const compiled = cases.filter((c) => c.testPath !== "");
  if (compiled.length === 0) return new Map();
  const tsconfig = await loadTsconfigPaths(cwd);
  const walked = await Promise.all(
    compiled.map(async (testCase) => {
      const testAbs = resolve(cwd, testCase.testPath);
      const walk = await walkSupportFiles(testAbs, cwd, {
        tsconfig,
        maxDepth: SELECTION_IMPORT_DEPTH,
      });
      const imports: CaseImports = {
        files: new Set([testAbs, ...walk.files.map((s) => s.abs)]),
        truncated: walk.truncated,
      };
      return [specKey(testCase), imports] as const;
    }),
  );
  return new Map(walked);
}
