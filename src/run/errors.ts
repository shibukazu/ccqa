/**
 * Usage error (bad flag combination, broken profile, failed `git diff`, …)
 * thrown by the `run` pipeline and the helpers it calls, e.g.
 * `collectChangedSpecs`. `executeRun` never calls `process.exit`, so each
 * host maps this itself: the CLI action catches it and exits with
 * `exitCode`; the hub runner records it as a run-level error.
 */
export class RunUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "RunUsageError";
  }
}
