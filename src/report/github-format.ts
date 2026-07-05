import type { RunReportData } from "./schema.ts";

/**
 * Build GitHub Actions `::error::` annotation lines for every failed spec in
 * a run report. Pure function, driven by `ccqa run --report --format github`.
 */
export function emitGithubAnnotations(data: RunReportData): string[] {
  const lines: string[] = [];
  for (const r of data.results) {
    if (r.status !== "failed") continue;
    const source = r.analysis?.headline || r.analysis?.reasoning || "test failed";
    const headline = source.split("\n")[0]?.trim() || "test failed";
    lines.push(`::error title=${r.feature}/${r.spec}::${headline.replace(/[\r\n]+/g, " ")}`);
  }
  return lines;
}
