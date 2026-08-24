import { CoverageEdgesDocSchema, type CoverageEdgesDoc } from "../../../contract/schema.ts";
import type { CoverageEdgeStore } from "../types.ts";
import { assertSafeName, readJson, updateJson } from "./fs-helpers.ts";
import { coverageEdgesPath } from "./paths.ts";

/**
 * Coverage-edge ledger (ADR-0026): one JSON document per project. `merge`
 * goes through `updateJson`, so two runs finishing at once queue their
 * read-modify-writes instead of clobbering each other, and each entry only
 * ever moves forward — a run's measurement replaces a spec's entry, never
 * deletes another spec's.
 */
export function createFileCoverageEdgeStore(root: string): CoverageEdgeStore {
  return {
    async get(project) {
      assertSafeName(project, "project");
      const raw = await readJson<unknown>(coverageEdgesPath(root, project));
      return raw === null ? null : parseDoc(raw, project);
    },

    async merge(project, specs, measuredAt) {
      assertSafeName(project, "project");
      await updateJson<CoverageEdgesDoc>(coverageEdgesPath(root, project), (current) => {
        const doc = current === null ? { specs: {} } : parseDoc(current, project);
        for (const [key, entry] of Object.entries(specs)) {
          doc.specs[key] = {
            files: [...entry.files].sort(),
            measuredAt,
            ...(entry.runId === undefined ? {} : { runId: entry.runId }),
          };
        }
        return doc;
      });
    },
  };
}

/**
 * A present document that does not parse is an error, never an empty ledger:
 * treating it as empty would let the next merge silently discard every other
 * spec's edge, and the data is regenerated only by running every spec
 * measured again.
 */
function parseDoc(raw: unknown, project: string): CoverageEdgesDoc {
  const parsed = CoverageEdgesDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`coverage-edges document for project "${project}" does not match the schema`);
  }
  return parsed.data;
}
