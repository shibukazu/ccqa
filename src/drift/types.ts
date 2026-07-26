import type { DraftIssue } from "../types.ts";

export type Format = "text" | "json" | "github";
export type Threshold = "warn" | "error";

export interface SpecTarget {
  featureName: string;
  specName: string;
}

export interface SpecResult {
  target: SpecTarget;
  ok: boolean;
  issues: DraftIssue[];
  /** Filled when the LLM call itself failed (network, parse, etc.). */
  error?: string;
}
