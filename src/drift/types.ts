import type { DraftIssue } from "../types.ts";

export type Format = "text" | "json" | "github";
export type Threshold = "warn" | "error";

export interface SpecTarget {
  featureName: string;
  specName: string;
  /** null = unscoped spec; treat as always-affected under --changed. */
  relatedPaths?: string[] | null;
  /**
   * Names of blocks this spec includes. Used by --changed to mark the
   * spec affected whenever one of these blocks' spec.yaml is touched.
   */
  includedBlocks?: string[];
}

export interface SpecResult {
  target: SpecTarget;
  ok: boolean;
  issues: DraftIssue[];
  /** Filled when the LLM call itself failed (network, parse, etc.). */
  error?: string;
}
