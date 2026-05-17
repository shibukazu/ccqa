import { relative, resolve } from "node:path";
import { DRAFT_CATEGORY_LABEL, type DraftIssue } from "../types.ts";
import type { Format, SpecResult } from "./types.ts";

/**
 * Render drift results as a string. The CLI commands and the `run` failure
 * hook are the only callers; both want the formatted output returned so
 * they can prefix / interleave / pipe it as needed.
 */
export function renderDrift(results: SpecResult[], format: Format, cwd: string): string {
  if (format === "json") return renderJson(results);
  if (format === "github") return renderGithub(results, cwd);
  return renderText(results);
}

const HEAVY_RULE = "═".repeat(72);

function renderText(results: SpecResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    out.push("");
    const heading = `══ ${r.target.featureName}/${r.target.specName} `;
    const tail = "═".repeat(Math.max(3, 72 - heading.length));
    out.push(`${heading}${tail}`);

    if (r.error) {
      out.push(`  ERROR  ${r.error}`);
      continue;
    }

    const errors = r.issues.filter((i) => i.severity === "ERROR");
    const warnings = r.issues.filter((i) => i.severity === "WARN");
    const passed = r.issues.filter((i) => i.severity === "OK");

    if (errors.length === 0 && warnings.length === 0) {
      const label = passed.length === 1 ? "check" : "checks";
      const detail = passed.length > 0 ? `all ${passed.length} ${label} passed` : "no issues";
      out.push(`  ✓  ${detail}`);
      continue;
    }

    for (const issue of errors) appendFinding(out, "ERROR", issue);
    for (const issue of warnings) appendFinding(out, "WARN", issue);

    if (passed.length > 0) {
      const names = passed.map((i) => DRAFT_CATEGORY_LABEL[i.category]).join(", ");
      out.push("");
      out.push(`  ✓  passed (${passed.length}): ${names}`);
    }
  }

  out.push("");
  out.push(HEAVY_RULE);
  const totals = summarize(results);
  out.push(`  specs    ${results.length} (${totals.errored} errored)`);
  out.push(`  findings ${totals.error} error, ${totals.warn} warn, ${totals.ok} ok`);
  out.push("");
  return out.join("\n");
}

function appendFinding(out: string[], level: "ERROR" | "WARN", issue: DraftIssue): void {
  const stepPart = issue.stepId ? ` ${issue.stepId}` : "";
  out.push("");
  out.push(`  ${level}  ${DRAFT_CATEGORY_LABEL[issue.category]}${stepPart}`);
  out.push(`    ${issue.message}`);
  if (issue.detail) {
    out.push(`    └ ${issue.detail.replace(/\n/g, "\n      ")}`);
  }
}

function renderJson(results: SpecResult[]): string {
  const payload = {
    specs: results.map((r) => ({
      feature: r.target.featureName,
      spec: r.target.specName,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
      issues: r.issues.map((i) => ({
        severity: i.severity,
        category: i.category,
        stepId: i.stepId,
        message: i.message,
        ...(i.detail ? { detail: i.detail } : {}),
      })),
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderGithub(results: SpecResult[], cwd: string): string {
  const repoRoot = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const lines: string[] = [];
  for (const r of results) {
    const file = githubRelPath(cwd, repoRoot, r.target.featureName, r.target.specName);
    if (r.error) {
      lines.push(`::error file=${file}::${escapeGhMessage(r.error)}`);
      continue;
    }
    for (const issue of r.issues) {
      if (issue.severity === "OK") continue;
      const level = issue.severity === "ERROR" ? "error" : "warning";
      const title = `${r.target.featureName}/${r.target.specName} — ${issue.category}${issue.stepId ? ` (${issue.stepId})` : ""}`;
      const body = issue.detail ? `${issue.message}\n${issue.detail}` : issue.message;
      lines.push(`::${level} file=${file},title=${escapeGhProp(title)}::${escapeGhMessage(body)}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function githubRelPath(cwd: string, repoRoot: string, featureName: string, specName: string): string {
  const abs = resolve(cwd, ".ccqa", "features", featureName, "test-cases", specName, "spec.yaml");
  const rel = relative(repoRoot, abs);
  return rel.startsWith("..") ? abs : rel;
}

function escapeGhMessage(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeGhProp(s: string): string {
  return s
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/,/g, "%2C")
    .replace(/:/g, "%3A");
}

function summarize(results: SpecResult[]): {
  error: number;
  warn: number;
  ok: number;
  errored: number;
} {
  let error = 0;
  let warn = 0;
  let ok = 0;
  let errored = 0;
  for (const r of results) {
    if (r.error) errored++;
    for (const issue of r.issues) {
      if (issue.severity === "ERROR") error++;
      else if (issue.severity === "WARN") warn++;
      else ok++;
    }
  }
  return { error, warn, ok, errored };
}
