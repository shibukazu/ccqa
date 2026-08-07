import { AttestationsSchema, type Attestations } from "../../../contract/schema.ts";
import type { AttestationStore } from "../types.ts";
import { readJson, updateJson } from "./fs-helpers.ts";
import { attestationsPath } from "./paths.ts";

function toAttestations(doc: unknown): Attestations {
  const parsed = AttestationsSchema.safeParse(doc);
  return parsed.success ? parsed.data : { specs: {} };
}

export function createFileAttestationStore(root: string): AttestationStore {
  return {
    async get(project, profile) {
      return toAttestations(await readJson<unknown>(attestationsPath(root, project, profile)));
    },

    async update(project, profile, mutate) {
      return updateJson<Attestations>(attestationsPath(root, project, profile), (current) =>
        mutate(toAttestations(current)),
      );
    },
  };
}
