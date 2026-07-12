/**
 * Pure report/run constants with no runtime dependencies. Kept separate from
 * `pipeline.ts` so modules that only need a constant (e.g. the `hub` CLI's
 * `--report` default, `run.ts`'s option text) don't import the whole pipeline
 * — which now pulls in `hub-conn.ts` and would otherwise create a module
 * initialization cycle (`hub.ts` → `pipeline.ts` → `hub-conn.ts`) that crashes
 * at startup with "Cannot access 'DEFAULT_REPORT_DIR' before initialization".
 */

export const REPORT_FORMATS = ["text", "json", "github"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const DEFAULT_REPORT_DIR = "ccqa-report";
export const EVIDENCE_SUBDIR = "evidence";
/** Per-spec run artifacts for external (runCommand) targets: `artifacts/<feature>__<spec>/`. */
export const ARTIFACTS_SUBDIR = "artifacts";
