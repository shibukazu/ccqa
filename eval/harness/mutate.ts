import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Mutation } from "./cases.ts";

/** A mutation that no longer fits the baseline. Always fatal to the run. */
export class MutationError extends Error {}

/**
 * Apply a case's mutations to a checkout of the baseline app.
 *
 * Every miss throws. A mutation that silently fails to apply leaves the
 * baseline unchanged, the audit honestly reports "clean", and the case scores
 * as a correct answer — the accuracy number inflates in exactly the direction
 * nobody double-checks.
 *
 * Two passes, and the exactly-once rule is enforced in both: first every
 * search is counted against the untouched baseline, so an earlier mutation's
 * `replace` cannot manufacture a later mutation's match; then the mutations
 * apply sequentially, re-counting at apply time, so an earlier mutation
 * cannot have consumed or duplicated a later match either.
 */
export async function applyMutations(rootDir: string, mutations: readonly Mutation[]): Promise<void> {
  for (const mutation of mutations) await checkAgainstBaseline(rootDir, mutation);
  for (const mutation of mutations) await applyOne(rootDir, mutation);
}

/**
 * The exact checks `applyMutations` performs, without writing anything: the
 * same baseline pass, then the apply pass replayed against an in-memory
 * overlay standing in for the earlier mutations' writes. Lets a guard test
 * validate every committed case against the real app dir directly instead of
 * copying it.
 */
export async function validateMutations(rootDir: string, mutations: readonly Mutation[]): Promise<void> {
  for (const mutation of mutations) await checkAgainstBaseline(rootDir, mutation);
  /** Resolved path → content after the simulated writes; null = deleted. */
  const overlay = new Map<string, string | null>();
  for (const mutation of mutations) {
    const path = resolveInside(rootDir, mutation.file);
    const current = overlay.has(path)
      ? overlay.get(path)!
      : await readFile(path, "utf8").catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        });
    if ("delete" in mutation) {
      if (current === null) {
        throw new MutationError(`cannot delete ${mutation.file}: file not found in the baseline`);
      }
      overlay.set(path, null);
      continue;
    }
    if (current === null) {
      throw new MutationError(`cannot mutate ${mutation.file}: file not found in the baseline`);
    }
    const occurrences = countOccurrences(current, mutation.search);
    if (occurrences !== 1) {
      throw new MutationError(
        `mutation clashes with an earlier one in the same case: ${JSON.stringify(mutation.search)} ` +
          `occurs ${occurrences} time(s) in ${mutation.file} after the preceding mutations`,
      );
    }
    overlay.set(path, current.replace(mutation.search, () => mutation.replace));
  }
}

async function checkAgainstBaseline(rootDir: string, mutation: Mutation): Promise<void> {
  const path = resolveInside(rootDir, mutation.file);
  if ("delete" in mutation) {
    try {
      await access(path);
    } catch (err) {
      throw translateEnoent(err, `cannot delete ${mutation.file}: file not found in the baseline`);
    }
    return;
  }
  const content = await readBaselineFile(path, mutation.file);
  const occurrences = countOccurrences(content, mutation.search);
  if (occurrences !== 1) {
    throw new MutationError(
      `mutation no longer applies to ${mutation.file}: expected exactly 1 occurrence of ` +
        `${JSON.stringify(mutation.search)} in the baseline, found ${occurrences} — update the case or the baseline`,
    );
  }
}

async function applyOne(rootDir: string, mutation: Mutation): Promise<void> {
  const path = resolveInside(rootDir, mutation.file);
  if ("delete" in mutation) {
    try {
      await unlink(path);
    } catch (err) {
      throw translateEnoent(err, `cannot delete ${mutation.file}: file not found in the baseline`);
    }
    return;
  }

  const content = await readBaselineFile(path, mutation.file);
  const occurrences = countOccurrences(content, mutation.search);
  if (occurrences !== 1) {
    throw new MutationError(
      `mutation clashes with an earlier one in the same case: ${JSON.stringify(mutation.search)} ` +
        `occurs ${occurrences} time(s) in ${mutation.file} after the preceding mutations`,
    );
  }
  // Replacer function, not a replacement string: `$&`-style patterns in the
  // declared replacement must land verbatim, never be interpreted.
  await writeFile(path, content.replace(mutation.search, () => mutation.replace), "utf8");
}

/** A `file` escaping the checkout would edit a real repo file and report success. */
function resolveInside(rootDir: string, file: string): string {
  const root = resolve(rootDir);
  const path = resolve(root, file);
  if (!path.startsWith(root + sep)) {
    throw new MutationError(`mutation path escapes the checkout: ${file}`);
  }
  return path;
}

async function readBaselineFile(path: string, file: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw translateEnoent(err, `cannot mutate ${file}: file not found in the baseline`);
  }
}

/** Only a missing file is a case problem; EISDIR, EACCES etc. surface as themselves. */
function translateEnoent(err: unknown, message: string): Error {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return new MutationError(message);
  return err instanceof Error ? err : new Error(String(err));
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
