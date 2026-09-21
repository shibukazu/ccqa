import { join, relative, resolve } from "node:path";
import { driftSeverity, type Format, type SpecResult } from "./types.ts";

/**
 * Render drift results for a terminal. `json` is not one of these: it prints
 * the same payload the report file holds, which is assembled asynchronously
 * and so is built once by the caller rather than rendered from results here
 * (`buildAuditReport`).
 */
export function renderDrift(
  results: SpecResult[],
  format: Exclude<Format, "json">,
  cwd: string,
): string {
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

    if (!r.drift) {
      out.push("  ✓  no drift");
      continue;
    }

    const level = driftSeverity(r.drift.label) === "error" ? "ERROR" : "WARN";
    out.push("");
    out.push(`  ${level}  ${r.drift.label} [${r.drift.surface}] (${Math.round(r.drift.confidence * 100)}%)`);
    out.push(`    ${r.drift.headline}`);
    if (r.drift.recommendation) out.push(`    → ${r.drift.recommendation}`);
    for (const e of r.drift.evidence) {
      out.push(`    · ${e.file ? `${e.file}: ` : ""}${e.detail}`);
    }
  }

  out.push("");
  out.push(HEAVY_RULE);
  const totals = summarize(results);
  out.push(`  specs    ${results.length} (${totals.errored} errored)`);
  out.push(`  findings ${totals.error} error, ${totals.warn} warn, ${totals.clean} clean`);
  out.push("");
  return out.join("\n");
}

function renderGithub(results: SpecResult[], cwd: string): string {
  const repoRoot = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const lines: string[] = [];
  for (const r of results) {
    const file = githubRelPath(cwd, repoRoot, r);
    if (r.error) {
      lines.push(`::error file=${file}::${escapeGhMessage(r.error)}`);
      continue;
    }
    if (!r.drift) continue;
    const level = driftSeverity(r.drift.label) === "error" ? "error" : "warning";
    const title = `${r.target.featureName}/${r.target.specName} — ${r.drift.label} [${r.drift.surface}]`;
    const body = r.drift.recommendation
      ? `${r.drift.headline}\n${r.drift.recommendation}`
      : r.drift.headline;
    lines.push(`::${level} file=${file},title=${escapeGhProp(title)}::${escapeGhMessage(body)}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * The file an annotation points at: the document this case is stated in.
 *
 * Falls back to the case's directory when the audit never got far enough to
 * read one — an annotation on a directory still lands a reviewer in the right
 * place, and one on a `spec.yaml` that a project does not use lands nowhere.
 */
function githubRelPath(cwd: string, repoRoot: string, result: SpecResult): string {
  const abs = resolve(
    cwd,
    result.documentPath ??
      join(".ccqa", "features", result.target.featureName, "test-cases", result.target.specName),
  );
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
  clean: number;
  errored: number;
} {
  let error = 0;
  let warn = 0;
  let clean = 0;
  let errored = 0;
  for (const r of results) {
    if (r.error) {
      errored++;
    } else if (!r.drift) {
      clean++;
    } else if (driftSeverity(r.drift.label) === "error") {
      error++;
    } else {
      warn++;
    }
  }
  return { error, warn, clean, errored };
}
