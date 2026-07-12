import type { HubStorage } from "../types.ts";
import { createFileArtifactStore } from "./artifact-store.ts";
import { createFileJobStore } from "./job-store.ts";
import { createFilePerspectivesStore } from "./perspectives-store.ts";
import { createFilePromptStore } from "./prompt-store.ts";
import { createFileRunStore } from "./run-store.ts";
import { createFileSecretStore } from "./secret-store.ts";
import { createFileTriageStore } from "./triage-store.ts";

/** Reference `HubStorage` implementation: everything lives as files under `dataDir`. */
export function createFileHubStorage(dataDir: string): HubStorage {
  return {
    runs: createFileRunStore(dataDir),
    artifacts: createFileArtifactStore(dataDir),
    sessions: createFileSecretStore(dataDir, "sessions"),
    variables: createFileSecretStore(dataDir, "variables"),
    triage: createFileTriageStore(dataDir),
    prompts: createFilePromptStore(dataDir),
    perspectives: createFilePerspectivesStore(dataDir),
    jobs: createFileJobStore(dataDir),
  };
}
