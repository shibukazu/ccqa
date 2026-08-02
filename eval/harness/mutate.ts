import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mutation } from "./cases.ts";

/** A mutation that no longer fits the baseline. Always fatal to the run. */
export class MutationError extends Error {}

/**
 * Apply a case's mutations to a checkout of the baseline app.
 *
 * Every miss throws. A mutation that silently fails to apply leaves the
 * baseline unchanged, the audit honestly reports "clean", and the case scores
 * as a correct answer — the accuracy number inflates in exactly the direction
 * nobody double-checks. The search string must occur exactly once, so a match
 * that became ambiguous fails just as loudly as one that disappeared.
 */
export async function applyMutations(rootDir: string, mutations: readonly Mutation[]): Promise<void> {
  for (const mutation of mutations) {
    const path = join(rootDir, mutation.file);
    if ("delete" in mutation) {
      try {
        await unlink(path);
      } catch {
        throw new MutationError(`cannot delete ${mutation.file}: file not found in the baseline`);
      }
      continue;
    }

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      throw new MutationError(`cannot mutate ${mutation.file}: file not found in the baseline`);
    }
    const occurrences = countOccurrences(content, mutation.search);
    if (occurrences !== 1) {
      throw new MutationError(
        `mutation no longer applies to ${mutation.file}: expected exactly 1 occurrence of ` +
          `${JSON.stringify(mutation.search)}, found ${occurrences} — update the case or the baseline`,
      );
    }
    // Replacer function, not a replacement string: `$&`-style patterns in the
    // declared replacement must land verbatim, never be interpreted.
    await writeFile(path, content.replace(mutation.search, () => mutation.replace), "utf8");
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
