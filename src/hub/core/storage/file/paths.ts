import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SecretScope } from "../types.ts";

/**
 * On-disk layout for the local-directory `HubStorage` backend, all rooted
 * under `--data-dir`:
 *
 *   runs/<id>/run.json                          (Run record, immutable once pushed)
 *   artifacts/<runId>/...                       (report dir, mirrored verbatim)
 *   sessions/<project>/<profile>/<name>.bin      (encrypted blob)
 *   variables/<project>/<profile>/<name>.bin     (encrypted blob + meta)
 *   variables/<project>/<profile>/<name>.meta.json
 *   triage/<runId>.json                         (TriageRecord[])
 *   jobs/<id>/job.json                          (LearningJob record, mutated as it runs)
 *
 * IDs and names are validated by their callers (run ids are server-minted
 * UUIDs; project/profile/name come from validated request params) before
 * ever reaching these path builders, so this module doesn't re-validate — it
 * just joins.
 */

export function runsDir(root: string): string {
  return join(root, "runs");
}

export function runDir(root: string, id: string): string {
  return join(runsDir(root), id);
}

export function runMetaPath(root: string, id: string): string {
  return join(runDir(root, id), "run.json");
}

export function artifactsRunDir(root: string, runId: string): string {
  return join(root, "artifacts", runId);
}

export function jobsDir(root: string): string {
  return join(root, "jobs");
}

export function jobDir(root: string, id: string): string {
  return join(jobsDir(root), id);
}

export function jobMetaPath(root: string, id: string): string {
  return join(jobDir(root, id), "job.json");
}

export function secretKindDir(root: string, kind: "sessions" | "variables"): string {
  return join(root, kind);
}

export function secretProjectDir(root: string, kind: "sessions" | "variables", project: string): string {
  return join(secretKindDir(root, kind), project);
}

export function secretScopeDir(root: string, kind: "sessions" | "variables", scope: SecretScope): string {
  return join(secretKindDir(root, kind), scope.project, scope.profile);
}

export function secretBlobPath(root: string, kind: "sessions" | "variables", scope: SecretScope, name: string): string {
  return join(secretScopeDir(root, kind, scope), `${name}.bin`);
}

export function secretMetaPath(root: string, kind: "sessions" | "variables", scope: SecretScope, name: string): string {
  return join(secretScopeDir(root, kind, scope), `${name}.meta.json`);
}

export function triagePath(root: string, runId: string): string {
  return join(root, "triage", `${runId}.json`);
}

// Prompts are project-scoped (not per-profile) and stored as plain text with
// no encryption: prompts/<project>/<name>.txt (+ .meta.json).
export function promptsKindDir(root: string): string {
  return join(root, "prompts");
}

export function promptProjectDir(root: string, project: string): string {
  return join(promptsKindDir(root), project);
}

export function promptBlobPath(root: string, project: string, name: string): string {
  return join(promptProjectDir(root, project), `${name}.txt`);
}

export function promptMetaPath(root: string, project: string, name: string): string {
  return join(promptProjectDir(root, project), `${name}.meta.json`);
}

// Perspectives are one JSON document per project, no meta file — the document
// carries its own `generatedAt`: perspectives/<project>.json.
export function perspectivesKindDir(root: string): string {
  return join(root, "perspectives");
}

export function perspectivesPath(root: string, project: string): string {
  return join(perspectivesKindDir(root), `${project}.json`);
}

// Last-green ledger: last-green/<project>/<profile>/<branch>.json. Unlike
// project/profile (validated as bare names at the API layer), a branch name
// is free-form git — it can contain '/', '..', etc. — so it is
// percent-encoded into a single flat filename. Encoding can expand 3x (every
// escaped byte becomes %XX; a fully-CJK branch triples), so past 200 chars
// the name switches to a truncated-prefix + content-hash form to stay under
// the ~255-byte filename limit — deterministic, so reads and writes agree.
export function lastGreenPath(root: string, project: string, profile: string, branch: string): string {
  const encoded = encodeURIComponent(branch);
  const name =
    encoded.length <= 200
      ? encoded
      : `${encoded.slice(0, 64)}-${createHash("sha256").update(branch).digest("hex").slice(0, 32)}`;
  return join(root, "last-green", project, profile, `${name}.json`);
}
