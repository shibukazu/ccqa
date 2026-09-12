/** The project's own name for the unique values a test creates. */
export function runId(): string {
  return `run-${Date.now()}`;
}
