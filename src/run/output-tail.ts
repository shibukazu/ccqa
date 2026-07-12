/** Cap on the per-spec output tail kept for the report / analysis prompt. */
export const OUTPUT_TAIL_CAP = 64 * 1024;

/**
 * Keeps the LAST `cap` characters appended — test runners put the failure
 * summary at the end of their output, so the tail is what's worth keeping on
 * overflow. Dependency-free so both the vitest pipeline and the runCommand
 * runner (src/targets/run-command-runner.ts) can use it without importing the
 * whole pipeline.
 */
export class TailBuffer {
  private buf = "";
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  append(s: string): void {
    this.buf += s;
    // Trim lazily at 2x so each append isn't a slice.
    if (this.buf.length > this.cap * 2) this.buf = this.buf.slice(-this.cap);
  }

  toString(): string {
    if (this.buf.length <= this.cap) return this.buf;
    return `[...output truncated...]\n${this.buf.slice(-this.cap)}`;
  }
}
