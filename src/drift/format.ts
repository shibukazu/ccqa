import { relative, resolve } from "node:path";
import { z } from "zod";
import { driftSeverity, type Format, type SpecResult } from "./types.ts";

/**
 * What `--report-format json` prints: one row per audited spec, plus
 * `skipped` on the nothing-to-audit path (`exitWithNoSpecs` in
 * `src/cli/audit.ts`). Declared beside `renderJson` so the emitter and any
 * reader share one shape. Deliberately lenient — drift fields as plain
 * strings, extra keys stripped — so a reader parsing with it survives a
 * vocabulary or shape addition upstream.
 */
export const AuditJsonPayloadSchema = z.object({
  specs: z.array(
    z.object({
      feature: z.string(),
      spec: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      drift: z
        .object({
          label: z.string(),
          surface: z.string().optional(),
          subDiagnosis: z.string().optional(),
          specChangeKind: z.string().optional(),
          headline: z.string().optional(),
          confidence: z.number().optional(),
        })
        .nullable(),
    }),
  ),
  skipped: z.string().optional(),
});
export type AuditJsonPayload = z.infer<typeof AuditJsonPayloadSchema>;

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

function renderJson(results: SpecResult[]): string {
  const payload: AuditJsonPayload = {
    specs: results.map((r) => ({
      feature: r.target.featureName,
      spec: r.target.specName,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
      drift: r.drift,
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
