import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CostFileTotal } from "../../src/cli/cost-line.ts";

const EVAL_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const DEFAULT_APP_DIR = join(EVAL_ROOT, "app");
export const DEFAULT_CASES_DIR = join(EVAL_ROOT, "cases");
export const DEFAULT_RESULTS_DIR = join(EVAL_ROOT, "results");

/**
 * Provenance every result file carries. Without the prompt version and model
 * the numbers cannot be compared across runs, which is the only thing they
 * are for. `cost` comes from the `CCQA_COST_FILE` tally of the run's own
 * ccqa invocations; null when the file never appeared (nothing invoked).
 */
export interface ResultMeta {
  kind: "audit" | "select";
  startedAt: string;
  model: string;
  /** The audit's `DRIFT_PROMPT_VERSION`; null for select, which declares none. */
  promptVersion: string | null;
  cost: CostFileTotal | null;
}

export async function writeResultFile(
  resultsDir: string,
  meta: ResultMeta,
  payload: Record<string, unknown>,
): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const stamp = meta.startedAt.replace(/[:.]/g, "-");
  const path = join(resultsDir, `${meta.kind}-${stamp}.json`);
  await writeFile(path, `${JSON.stringify({ ...meta, ...payload }, null, 2)}\n`, "utf8");
  return path;
}

/** Left-aligned column table for the human summary on stdout. */
export function renderTable(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd())
    .join("\n");
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
