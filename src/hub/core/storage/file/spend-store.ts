import { SpendEntrySchema, type SpendEntry, type SpendLog } from "../../../contract/schema.ts";
import type { SpendStore } from "../types.ts";
import { assertSafeName, readJson, updateJson } from "./fs-helpers.ts";
import { spendPath } from "./paths.ts";
import { windowFilter } from "./time-window.ts";

/** How long a reported batch is kept; fixed, not configurable (docs/hub-api.md#spend). */
export const SPEND_RETENTION_DAYS = 90;

/** Spend storage: one JSON document per project, pruned as it is appended to. */
export function createFileSpendStore(root: string): SpendStore {
  return {
    async append(project, entry) {
      assertSafeName(project, "project");
      const path = spendPath(root, project);
      const cutoff = Date.now() - SPEND_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      // Pruned and keyed inside the read-modify-write, so a push landing at the
      // same moment cannot reinstate what this one dropped.
      await updateJson<unknown>(path, (current) => {
        const retained = readEntries(current, path).filter(
          (e) => Date.parse(e.at) >= cutoff && !supersededBy(e, entry),
        );
        return { entries: [...retained, entry] } satisfies SpendLog;
      });
      return entry;
    },

    async list(project, window) {
      assertSafeName(project, "project");
      const path = spendPath(root, project);
      const inWindow = windowFilter(window);
      return readEntries(await readJson<unknown>(path), path)
        .filter((e) => inWindow(e.at))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },
  };
}

/**
 * A second push from the same CI run under the same label replaces the first
 * rather than adding to it: a retried job really does spend again, but it also
 * rewrites its cost file from scratch, so its new total is the whole of it.
 */
function supersededBy(stored: SpendEntry, incoming: SpendEntry): boolean {
  return incoming.ciRunId !== undefined && stored.ciRunId === incoming.ciRunId && stored.label === incoming.label;
}

/**
 * Entries parsed one at a time, keeping the survivors: a whole-document parse
 * would answer "this project spent nothing" for one bad entry, and a budget
 * reads that as zero rather than as an error. What is lost is logged, since
 * nothing else would ever say so.
 */
function readEntries(raw: unknown, path: string): SpendEntry[] {
  if (raw === null || raw === undefined) return [];
  const stored = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(stored)) {
    console.error(`hub: spend log at ${path} is not a spend document; ignoring what it holds`);
    return [];
  }
  const entries: SpendEntry[] = [];
  for (const value of stored) {
    const parsed = SpendEntrySchema.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  if (entries.length < stored.length) {
    console.error(`hub: skipping ${stored.length - entries.length} unreadable spend entries in ${path}`);
  }
  return entries;
}
