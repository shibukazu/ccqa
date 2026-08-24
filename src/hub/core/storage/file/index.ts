import type { HubStorage } from "../types.ts";
import { createFileAckStore } from "./ack-store.ts";
import { createFileAttestationStore } from "./attestation-store.ts";
import { createFileAuditDismissalStore } from "./audit-dismissal-store.ts";
import { createFileArtifactStore } from "./artifact-store.ts";
import { createFileCoverageEventStore } from "./coverage-event-store.ts";
import { createFileSourceMapStore } from "./sourcemap-store.ts";
import { createFileDeployStore } from "./deploy-store.ts";
import { createFileLockStore } from "./lock-store.ts";
import { createFileDriftLedgerStore } from "./drift-ledger-store.ts";
import { createFileJobStore } from "./job-store.ts";
import { createFileSpecLedgerStore } from "./ledger-store.ts";
import { createFileCoverageEdgeStore } from "./coverage-edge-store.ts";
import { createFilePerspectivesStore } from "./perspectives-store.ts";
import { createFilePromptStore } from "./prompt-store.ts";
import { createFileRunStore } from "./run-store.ts";
import { createFileSecretStore } from "./secret-store.ts";
import { createFileSpendStore } from "./spend-store.ts";
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
    coverageEdges: createFileCoverageEdgeStore(dataDir),
    jobs: createFileJobStore(dataDir),
    ledger: createFileSpecLedgerStore(dataDir),
    driftLedger: createFileDriftLedgerStore(dataDir),
    deploys: createFileDeployStore(dataDir),
    locks: createFileLockStore(dataDir),
    acks: createFileAckStore(dataDir),
    spend: createFileSpendStore(dataDir),
    attestations: createFileAttestationStore(dataDir),
    auditDismissals: createFileAuditDismissalStore(dataDir),
    coverageEvents: createFileCoverageEventStore(dataDir),
    sourceMaps: createFileSourceMapStore(dataDir),
  };
}
