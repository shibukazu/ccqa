import { AuditDismissalsSchema, type AuditDismissals } from "../../../contract/schema.ts";
import type { AuditDismissalStore } from "../types.ts";
import { readJson, updateJson } from "./fs-helpers.ts";
import { auditDismissalsPath } from "./paths.ts";

function toDismissals(doc: unknown): AuditDismissals {
  const parsed = AuditDismissalsSchema.safeParse(doc);
  return parsed.success ? parsed.data : { specs: {} };
}

export function createFileAuditDismissalStore(root: string): AuditDismissalStore {
  return {
    async get(project) {
      return toDismissals(await readJson<unknown>(auditDismissalsPath(root, project)));
    },

    async update(project, mutate) {
      return updateJson<AuditDismissals>(auditDismissalsPath(root, project), (current) =>
        mutate(toDismissals(current)),
      );
    },
  };
}
