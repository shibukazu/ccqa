import { DRAFT_CATEGORY_LABEL } from "../types.ts";
import { MAX_EVIDENCE_ITEMS } from "./analyze.ts";
import { reportStrings, type ReportStrings } from "./i18n.ts";
import { FAILURE_LABELS, type ReportSpecResult, type RunReportData } from "./schema.ts";

/**
 * Render the run report as ONE self-contained HTML file (inline CSS/JS, no
 * network). It is meant to be uploaded as a CI artifact like Playwright's
 * HTML report and opened locally; the layout deliberately mirrors that
 * report's conventions — header stats that double as filters, a search box,
 * collapsible per-spec cards with a step list and durations, automatic
 * light/dark theme.
 *
 * The measurement loop lives client-side: each analyzed failure gets
 * ground-truth radio buttons, and a vanilla-JS block recomputes accuracy /
 * confusion matrix / per-class precision-recall on every change. Labels
 * persist in localStorage and can be exported/imported as JSON
 * (LabelsExportSchema) so the grading work survives the browser session.
 */
export function renderRunReport(data: RunReportData): string {
  const failed = data.results.filter((r) => r.status === "failed");
  const analyzed = failed.filter((r) => r.analysis !== null);
  const passedCount = data.results.length - failed.length;
  const totalDuration = data.results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const s = reportStrings(data.language);
  const htmlLang = resolveHtmlLang(data.language);

  // <-escape every "<" so "</script>" inside logs/reasoning can never
  // terminate the data island. The result is still valid JSON.
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const stringsJson = JSON.stringify({
    kpiLabeled: s.kpiLabeled,
    kpiAccuracy: s.kpiAccuracy,
    kpiRemaining: s.kpiRemaining,
    failureLabelDisplay: s.failureLabelDisplay,
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="${esc(htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="header-top">
      <h1>${esc(s.title)}</h1>
      <div class="meta">
        <span title="generated at">${esc(formatDate(data.createdAt))}</span>
        ${totalDuration > 0 ? `<span>${formatDuration(totalDuration)}</span>` : ""}
        ${data.runId ? `<span>CI run ${esc(data.runId)}</span>` : ""}
        ${data.git.head ? `<span><code>${esc(data.git.head)}</code>${data.git.base ? ` vs <code>${esc(data.git.base)}</code>` : ""}</span>` : ""}
      </div>
    </div>
    <div class="toolbar">
      <div class="chips" id="filter-chips">
        <button type="button" class="chip active" data-filter="all">${esc(s.filterAll)} <span class="count">${data.results.length}</span></button>
        <button type="button" class="chip chip-pass" data-filter="passed">${passedCount} ${esc(s.filterPassed)}</button>
        <button type="button" class="chip chip-fail" data-filter="failed">${failed.length} ${esc(s.filterFailed)}</button>
      </div>
      <input type="search" id="search" placeholder="${esc(s.filterPlaceholder)}" autocomplete="off">
    </div>
  </div>
</header>

<div class="page">
${analyzed.length > 0 ? metricsPanel(s) : ""}

<main id="spec-list">
${data.results.map((r, i) => renderResult(r, i, s)).join("\n")}
</main>
<p class="empty-note" id="no-match" hidden>${esc(s.emptyNote)}</p>
</div>

<script type="application/json" id="ccqa-report-data">${dataJson}</script>
<script type="application/json" id="ccqa-report-strings">${stringsJson}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}

function resolveHtmlLang(lang: string | null): string {
  if (!lang) return "en";
  const base = lang.toLowerCase().split(/[-_]/)[0] ?? "";
  return base === "ja" ? "ja" : "en";
}

function metricsPanel(s: ReportStrings): string {
  return `<section class="panel" id="measure-panel">
  <div class="panel-head">
    <h2>${esc(s.predictionAccuracy)}</h2>
    <div class="measure-actions">
      <button type="button" id="export-labels">${esc(s.exportLabels)}</button>
      <label class="import-label">${esc(s.importLabels)}<input type="file" id="import-labels" accept="application/json"></label>
    </div>
  </div>
  <div class="metrics-summary" id="metrics-summary"></div>
  <p class="hint">${esc(s.predictionHint)}</p>
  <details class="metrics-detail">
    <summary>${esc(s.confusionMatrix)} <span class="metrics-detail-sub">${esc(s.confusionMatrixSub)}</span></summary>
    <div id="metrics-matrix"></div>
  </details>
  <details class="metrics-detail">
    <summary>${esc(s.perClassMetrics)} <span class="metrics-detail-sub">${esc(s.perClassMetricsSub)}</span></summary>
    <div id="metrics-perclass"></div>
  </details>
</section>`;
}

function renderResult(r: ReportSpecResult, index: number, s: ReportStrings): string {
  const id = `${r.feature}/${r.spec}`;
  const duration =
    r.durationMs != null && r.durationMs > 0
      ? `<span class="duration">${formatDuration(r.durationMs)}</span>`
      : "";
  const counts = r.testCounts
    ? `<span class="counts">${r.testCounts.passed}/${r.testCounts.total}</span>`
    : "";
  const predictionChip =
    r.status === "failed" && r.analysis
      ? `<span class="badge ${r.analysis.label}">${esc(displayLabel(r.analysis.label, s))}</span>`
      : "";
  // Failed specs that have an analysis but no human grade yet get a chip the
  // reviewer can scan for. The client JS hides it once the radio is selected.
  const needsGradingChip =
    r.status === "failed" && r.analysis
      ? `<span class="needs-grading-chip" data-case-id="${esc(id)}">${esc(s.needsGrading)}</span>`
      : "";

  return `<details class="spec ${r.status}" data-status="${r.status}" data-case-id="${esc(id)}"${r.status === "failed" ? " open" : ""}>
  <summary>
    ${statusIcon(r.status)}
    <span class="spec-name">${esc(id)}</span>
    ${predictionChip}
    ${needsGradingChip}
    <span class="spacer"></span>
    ${counts}
    ${duration}
  </summary>
  <div class="spec-body">
    ${renderAssertions(r)}
    ${renderEvidence(r, s)}
    ${r.status === "failed" ? (r.analysis ? renderAnalysis(r, index, s) : renderSkipped(r, s)) : ""}
    ${renderDriftIssues(r, s)}
    ${collapsible(s.collFailureLog, s.collFailureLogHelp, r.failureLogExcerpt)}
    ${collapsible(s.collSourceDiff, s.collSourceDiffHelp, r.diffExcerpt, "diff")}
    ${collapsible(s.collSpecYaml, s.collSpecYamlHelp, r.specYaml)}
  </div>
</details>`;
}

function renderEvidence(r: ReportSpecResult, s: ReportStrings): string {
  if (!r.evidence || r.evidence.length === 0) return "";
  const thumbs = r.evidence.map((e) => renderEvidenceThumb(e, s)).join("");
  return `<details class="evidence-block" open>
  <summary>${esc(s.stepEvidence(r.evidence.length))}</summary>
  <div class="evidence-grid">${thumbs}</div>
</details>`;
}

function renderEvidenceThumb(e: NonNullable<ReportSpecResult["evidence"]>[number], s: ReportStrings): string {
  const caption = esc(e.stepId);
  const isFailed = e.status === "failed";
  const statusBadge = `<span class="evidence-status evidence-status-${isFailed ? "failed" : "passed"}">${esc(isFailed ? s.statusFailed : s.statusPassed)}</span>`;
  const description = e.description
    ? `<p class="evidence-description">${esc(e.description)}</p>`
    : "";
  const failureBlock = isFailed && e.failureSummary
    ? `<div class="evidence-failure">
    <span class="evidence-failure-icon" aria-hidden="true">✖</span>
    <span class="evidence-failure-text">${esc(e.failureSummary)}</span>
  </div>`
    : "";
  const footerRows: string[] = [];
  if (e.url) {
    const shortUrl = shortenUrl(e.url);
    footerRows.push(
      `<div class="evidence-meta-row"><span class="evidence-meta-label">${esc(s.metaUrl)}</span><span class="evidence-meta-value" title="${esc(e.url)}">${esc(shortUrl)}</span></div>`,
    );
  }
  if (e.title) {
    footerRows.push(
      `<div class="evidence-meta-row"><span class="evidence-meta-label">${esc(s.metaPage)}</span><span class="evidence-meta-value">${esc(e.title)}</span></div>`,
    );
  }
  const footer =
    footerRows.length > 0 ? `<div class="evidence-meta">${footerRows.join("")}</div>` : "";
  return `<figure class="evidence-thumb evidence-thumb-${isFailed ? "failed" : "passed"}">
  ${statusBadge}
  <a href="${esc(e.pngPath)}" target="_blank" rel="noopener"><img src="${esc(e.pngPath)}" alt="${caption}" loading="lazy"></a>
  <figcaption>
    <strong class="evidence-stepid">${caption}</strong>
    ${description}
    ${failureBlock}
    ${footer}
  </figcaption>
</figure>`;
}

/**
 * Compact a URL for the caption footer: drop the scheme, drop query/hash, drop
 * a trailing slash on `/`. The full URL is preserved verbatim in the link's
 * `title` attribute so reviewers can still recover it on hover. We keep the
 * shortening conservative — no host truncation, no path eliding — so the
 * displayed text is always a strict prefix of the real URL.
 */
function shortenUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host;
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${host}${path}`;
  } catch {
    return raw;
  }
}

function statusIcon(status: "passed" | "failed" | "skipped"): string {
  if (status === "passed") return `<span class="status-icon pass" aria-label="passed">✓</span>`;
  if (status === "failed") return `<span class="status-icon fail" aria-label="failed">✕</span>`;
  return `<span class="status-icon skip" aria-label="skipped">◌</span>`;
}

function renderAssertions(r: ReportSpecResult): string {
  if (!r.assertions || r.assertions.length === 0) return "";
  const rows = r.assertions
    .map((a) => {
      const dur =
        a.durationMs != null ? `<span class="duration">${formatDuration(a.durationMs)}</span>` : "";
      return `<li>${statusIcon(a.status)}<span class="step-name">${esc(a.name)}</span><span class="spacer"></span>${dur}</li>`;
    })
    .join("");
  return `<ul class="steps">${rows}</ul>`;
}

function renderAnalysis(r: ReportSpecResult, index: number, s: ReportStrings): string {
  const a = r.analysis!;
  const pct = Math.round(a.confidence * 100);
  // headline / recommendation / reasoning are schema-defaulted to "" so
  // `.trim()` (not `?.trim()`) is enough — they are always strings.
  const headlineText = a.headline.trim();
  const recommendationText = a.recommendation.trim();
  const reasoningText = a.reasoning.trim();
  const headline = headlineText
    ? `<p class="analysis-headline">${esc(headlineText)}</p>`
    : "";
  const evidence =
    a.evidence.length > 0
      ? `<ul class="evidence">${a.evidence
          .slice(0, MAX_EVIDENCE_ITEMS)
          .map((e) => `<li>${e.file ? `<code>${esc(e.file)}</code> — ` : ""}${esc(e.detail)}</li>`)
          .join("")}</ul>`
      : "";
  const recommendation = recommendationText
    ? `<p class="analysis-recommendation"><span class="analysis-recommendation-label">${esc(s.recommendation)}</span> ${esc(recommendationText)}</p>`
    : "";
  const reasoning = reasoningText
    ? `<details class="analysis-reasoning"><summary>${esc(s.moreContext)}</summary><p>${esc(reasoningText)}</p></details>`
    : "";

  const subDiag = a.subDiagnosis && a.subDiagnosis !== "NONE" ? a.subDiagnosis : "";
  const subDiagBlock = subDiag
    ? `<div class="sub-cause">
        <span class="sub-cause-arrow" aria-hidden="true">↳</span>
        <span class="sub-cause-label">${esc(s.subCause)}</span>
        <span class="sub-cause-value">${esc(subDiag)}</span>
        ${s.subDiagnosisHelp[subDiag] ? labelWithHelp("", s.subDiagnosisHelp[subDiag] ?? "") : ""}
      </div>`
    : "";

  return `<div class="analysis">
  <div class="prediction">
    <span class="badge ${a.label}">${esc(displayLabel(a.label, s))}</span>
    ${labelHelpBubble(a.label, s)}
    <span class="confidence" title="confidence"><span class="confidence-bar"><span style="width:${pct}%"></span></span>${pct}%</span>
  </div>
  ${subDiagBlock}
  ${headline}
  ${evidence}
  ${recommendation}
  ${reasoning}
  <div class="truth">
    <span class="truth-title">${esc(s.trueCause)}</span>
    ${FAILURE_LABELS
      .map(
        (label) =>
          `<label class="truth-option ${label}"><input type="radio" name="label--${index}" value="${label}"><span>${esc(displayLabel(label, s))}</span>${labelHelpBubble(label, s)}</label>`,
      )
      .join("\n    ")}
    <input type="text" class="note" placeholder="${esc(s.noteOptional)}" data-case-index="${index}">
  </div>
</div>`;
}

function renderSkipped(r: ReportSpecResult, s: ReportStrings): string {
  return `<div class="analysis skipped">${esc(s.analysisSkipped)}${r.analysisSkipped ? `: ${esc(r.analysisSkipped)}` : ""}</div>`;
}

function renderDriftIssues(r: ReportSpecResult, s: ReportStrings): string {
  if (!r.driftIssues || r.driftIssues.length === 0) return "";
  const items = r.driftIssues
    .map(
      (i) =>
        `<li><span class="severity ${i.severity}">${i.severity}</span> (${esc(DRAFT_CATEGORY_LABEL[i.category])}${i.stepId ? `, step ${esc(i.stepId)}` : ""}) ${esc(i.message)}${i.detail ? ` — ${esc(i.detail)}` : ""}</li>`,
    )
    .join("");
  return `<details class="drift"><summary>${labelWithHelp(esc(s.collDriftAudit(r.driftIssues.length)), s.collDriftAuditHelp)}</summary><ul>${items}</ul></details>`;
}

function collapsible(title: string, help: string | null, content: string | null, kind = ""): string {
  if (!content) return "";
  return `<details class="raw ${kind}"><summary>${labelWithHelp(esc(title), help)}</summary><pre>${esc(content)}</pre></details>`;
}

/** Human-facing name for a failure label. Falls back to the enum string. */
function displayLabel(label: string, s: ReportStrings): string {
  return s.failureLabelDisplay[label] ?? label;
}

/** Standalone help bubble for a failure label. Empty string when no help exists. */
function labelHelpBubble(label: string, s: ReportStrings): string {
  const help = s.failureLabelHelp[label];
  if (!help) return "";
  return labelWithHelp("", help);
}

/**
 * Append a `?` help bubble with a CSS-driven tooltip that opens on hover AND
 * keyboard focus (the native `title` attribute only fires on hover and has a
 * built-in ~700ms delay). The tooltip itself is `aria-hidden` because the
 * accessible name on the button already exposes the same text to screen
 * readers.
 */
function labelWithHelp(label: string, help: string | null): string {
  if (!help) return label;
  return `${label} <span class="help-wrap"><span class="help" tabindex="0" role="button" aria-label="${esc(help)}">?</span><span class="help-tip" role="tooltip" aria-hidden="true">${esc(help)}</span></span>`;
}

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]!);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #f8f9fa;
  --border: #e1e4e8;
  --text: #1f2328;
  --text-dim: #656d76;
  --accent: #1f6feb;
  --pass: #1a7f37;
  --pass-bg: #dafbe1;
  --fail: #cf222e;
  --fail-bg: #ffebe9;
  --skip: #9a6700;
  --code-bg: #0d1117;
  --code-text: #e6edf3;
  --shadow: 0 1px 3px rgba(31, 35, 40, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-2: #1c2129;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --pass: #3fb950;
    --pass-bg: rgba(63, 185, 80, 0.15);
    --fail: #f85149;
    --fail-bg: rgba(248, 81, 73, 0.15);
    --skip: #d29922;
    --code-bg: #010409;
    --code-text: #e6edf3;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif;
  margin: 0; background: var(--bg); color: var(--text); font-size: 14px;
}
header {
  position: sticky; top: 0; z-index: 10;
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.header-inner { max-width: 1080px; margin: 0 auto; padding: 14px 24px 10px; }
.header-top { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap; }
h1 { font-size: 17px; margin: 0; font-weight: 650; }
h2 { font-size: 14px; margin: 0; font-weight: 650; }
.meta { font-size: 12px; color: var(--text-dim); display: flex; gap: 14px; flex-wrap: wrap; }
.meta code { background: var(--surface-2); border: 1px solid var(--border); padding: 0 5px; border-radius: 4px; font-size: 11px; }
.dim { color: var(--text-dim); }
.toolbar { display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
.chips { display: flex; gap: 6px; }
.chip {
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  padding: 3px 12px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text-dim);
}
.chip .count { opacity: 0.7; }
.chip.active { background: var(--text); color: var(--surface); border-color: var(--text); }
.chip-pass.active { background: var(--pass); border-color: var(--pass); color: #fff; }
.chip-fail.active { background: var(--fail); border-color: var(--fail); color: #fff; }
#search {
  font: inherit; font-size: 13px; flex: 1; min-width: 180px; max-width: 320px; margin-left: auto;
  padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface-2); color: var(--text);
}
#search:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.page { max-width: 1080px; margin: 16px auto; padding: 0 24px; }
.panel {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px 18px; margin-bottom: 16px; box-shadow: var(--shadow);
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--text-dim); margin: 6px 0 10px; }
.spec {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  margin-bottom: 8px; box-shadow: var(--shadow);
}
.spec > summary {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  cursor: pointer; list-style: none; user-select: none;
}
.spec > summary::-webkit-details-marker { display: none; }
.spec > summary::before {
  content: "▸"; color: var(--text-dim); font-size: 11px;
  transition: transform 0.12s ease; flex: 0 0 auto;
}
.spec[open] > summary::before { transform: rotate(90deg); }
.spec-name { font-weight: 600; font-size: 13.5px; }
.spacer { flex: 1; }
.counts { font-size: 12px; color: var(--text-dim); }
.duration { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.status-icon { font-weight: 700; font-size: 13px; flex: 0 0 auto; }
.status-icon.pass { color: var(--pass); }
.status-icon.fail { color: var(--fail); }
.status-icon.skip { color: var(--skip); }
.spec-body { padding: 2px 16px 12px 36px; border-top: 1px solid var(--border); }
.steps { list-style: none; margin: 10px 0; padding: 0; }
.steps li {
  display: flex; align-items: center; gap: 8px; padding: 3px 8px;
  font-size: 13px; border-radius: 5px;
}
.steps li:hover { background: var(--surface-2); }
.step-name { overflow-wrap: anywhere; }
.analysis {
  border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 6px; background: var(--surface-2);
  padding: 10px 14px; margin: 10px 0;
}
.analysis.skipped { color: var(--text-dim); font-size: 13px; font-style: italic; border-left-color: var(--border); }
.prediction { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.badge {
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em;
  padding: 2px 10px; border-radius: 4px; color: #fff; flex: 0 0 auto;
}
.badge.TEST_DRIFT { background: #b45309; }
.badge.SPEC_CHANGE { background: #1d4ed8; }
.badge.PRODUCT_BUG { background: #b91c1c; }
.badge.UNKNOWN { background: #6b7280; }
.confidence { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: var(--text-dim); }
.confidence-bar {
  display: inline-block; width: 64px; height: 6px; border-radius: 999px;
  background: var(--border); overflow: hidden;
}
.confidence-bar > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
.sub { font-size: 11px; background: var(--surface); border: 1px solid var(--border); color: var(--text-dim); padding: 1px 8px; border-radius: 999px; }
.sub-cause {
  display: flex; align-items: center; gap: 6px;
  margin: 4px 0 0 6px; padding-left: 6px;
  font-size: 12px; color: var(--text-dim);
}
.sub-cause-arrow { color: var(--text-dim); font-size: 13px; }
.sub-cause-label {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-dim);
}
.sub-cause-value {
  font-size: 11.5px; font-weight: 700; color: var(--text);
  background: var(--surface); border: 1px solid var(--border);
  padding: 1px 8px; border-radius: 4px;
}
.needs-grading-chip {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 2px 8px; border-radius: 999px;
  background: rgba(212, 167, 44, 0.18); color: var(--skip);
  border: 1px solid var(--skip);
}
.analysis-headline { font-size: 13.5px; margin: 9px 0 6px; font-weight: 600; line-height: 1.5; }
.evidence { font-size: 12.5px; color: var(--text-dim); margin: 6px 0; padding-left: 18px; line-height: 1.5; }
.evidence code { background: var(--surface); border: 1px solid var(--border); padding: 0 5px; border-radius: 4px; font-size: 11px; }
.analysis-recommendation { font-size: 13px; margin: 9px 0 4px; line-height: 1.5; }
.analysis-recommendation-label {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--accent); margin-right: 6px;
}
.analysis-reasoning { margin: 6px 0; font-size: 12.5px; color: var(--text-dim); }
.analysis-reasoning > summary { cursor: pointer; }
.analysis-reasoning p { margin: 6px 0 0; white-space: pre-wrap; line-height: 1.55; }
.truth {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: var(--surface); border: 1px dashed var(--border); border-radius: 6px;
  padding: 8px 12px; margin-top: 10px; font-size: 12.5px;
}
.truth-title { font-weight: 650; color: var(--text-dim); }
.truth-option {
  display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px;
}
.truth-option:has(input:checked) { border-color: var(--accent); background: var(--surface-2); font-weight: 650; }
.note { flex: 1; min-width: 150px; font: inherit; font-size: 12px; padding: 4px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-2); color: var(--text); }
details.raw, details.drift { margin: 7px 0; font-size: 13px; }
details.raw summary, details.drift summary { cursor: pointer; color: var(--text-dim); }
details.raw pre {
  background: var(--code-bg); color: var(--code-text);
  font-size: 11.5px; line-height: 1.5; padding: 12px 14px; border-radius: 6px;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 6px 0;
}
.severity { font-size: 10.5px; font-weight: 700; padding: 0 6px; border-radius: 4px; margin-right: 4px; }
.severity.ERROR { background: var(--fail-bg); color: var(--fail); }
.severity.WARN { background: rgba(212, 167, 44, 0.18); color: var(--skip); }
.severity.OK { background: var(--pass-bg); color: var(--pass); }
.drift ul { padding-left: 18px; font-size: 12.5px; line-height: 1.55; }
.help-wrap { position: relative; display: inline-block; }
.help {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 6px;
  border: 1px solid var(--border); border-radius: 50%;
  font-size: 9.5px; font-weight: 700; color: var(--text-dim);
  background: var(--surface-2); cursor: help; vertical-align: middle;
}
.help:hover, .help:focus { color: var(--text); border-color: var(--text-dim); outline: none; }
.help-tip {
  position: absolute; left: 0; top: calc(100% + 8px); z-index: 5;
  display: none; width: max-content; max-width: 320px;
  padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text); box-shadow: var(--shadow);
  font-size: 12px; font-weight: 400; line-height: 1.5; text-transform: none;
  letter-spacing: 0; white-space: normal; word-break: break-word;
}
.help-wrap:hover .help-tip, .help-wrap:focus-within .help-tip { display: block; }
table.matrix { border-collapse: collapse; font-size: 12.5px; margin: 10px 16px 10px 0; display: inline-table; vertical-align: top; }
table.matrix th, table.matrix td { border: 1px solid var(--border); padding: 4px 12px; text-align: center; }
table.matrix th { background: var(--surface-2); font-weight: 600; }
table.matrix td { font-variant-numeric: tabular-nums; }
table.matrix td.hit { background: var(--pass-bg); font-weight: 700; }
table.matrix td.miss-nonzero { background: var(--fail-bg); }
.metrics-summary {
  display: grid; grid-template-columns: repeat(3, minmax(140px, 1fr));
  gap: 12px; margin: 12px 0 8px;
}
.metric-tile {
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface-2);
}
.metric-tile-value { font-size: 20px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1.1; }
.metric-tile-label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); }
.metric-tile-attention { border-color: var(--accent); }
.metric-tile-attention .metric-tile-value { color: var(--accent); }
.metrics-detail { margin: 6px 0; font-size: 13px; }
.metrics-detail > summary { cursor: pointer; padding: 4px 0; color: var(--text); font-weight: 600; }
.metrics-detail-sub { font-weight: 400; color: var(--text-dim); font-size: 12px; margin-left: 6px; }
.metrics-detail[open] > summary { margin-bottom: 8px; }
.measure-actions { display: flex; gap: 14px; align-items: center; font-size: 12.5px; }
.measure-actions button {
  font: inherit; font-size: 12.5px; padding: 4px 13px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text);
}
.measure-actions button:hover { background: var(--surface-2); }
.import-label { cursor: pointer; color: var(--text-dim); }
.import-label input { display: none; }
.empty-note { color: var(--text-dim); text-align: center; font-size: 13px; }
.evidence-block { margin: 10px 0; font-size: 13px; }
.evidence-block > summary { cursor: pointer; color: var(--text-dim); }
.evidence-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px; margin-top: 10px;
}
.evidence-thumb {
  margin: 0; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface-2); overflow: hidden; position: relative;
}
.evidence-thumb-failed { border-color: var(--fail); box-shadow: inset 0 0 0 1px var(--fail); }
.evidence-thumb img { display: block; width: 100%; height: 140px; object-fit: cover; object-position: top left; background: #fff; }
.evidence-thumb figcaption { padding: 8px 10px 10px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.evidence-stepid { font-weight: 650; font-size: 12px; color: var(--text-dim); letter-spacing: 0.02em; }
.evidence-description { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text); white-space: pre-line; overflow-wrap: anywhere; }
.evidence-status {
  position: absolute; top: 8px; left: 8px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
  padding: 2px 8px; border-radius: 4px; color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
.evidence-status-passed { background: var(--pass); }
.evidence-status-failed { background: var(--fail); }
.evidence-failure {
  display: flex; align-items: flex-start; gap: 6px;
  margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--fail);
  font-size: 12px; color: var(--fail); line-height: 1.45; overflow-wrap: anywhere;
}
.evidence-failure-icon { font-weight: 700; flex: 0 0 auto; }
.evidence-failure-text { flex: 1; }
.evidence-meta {
  display: grid; grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 2px;
  font-size: 11px; padding-top: 6px; border-top: 1px solid var(--border);
}
.evidence-meta-row { display: contents; }
.evidence-meta-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
  color: var(--text-dim); text-transform: uppercase; padding-top: 1px;
}
.evidence-meta-value { color: var(--text); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
`;

// Vanilla JS, no client-side template literals, no closing-script-tag string
// anywhere. The one \${} below is server-side interpolation: it bakes the
// schema's label list into the script so the two cannot drift apart.
const CLIENT_JS = `
(function () {
  var dataEl = document.getElementById('ccqa-report-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var stringsEl = document.getElementById('ccqa-report-strings');
  var STRINGS = stringsEl ? JSON.parse(stringsEl.textContent) : {};
  var L_LABELED = STRINGS.kpiLabeled || 'Labeled';
  var L_ACCURACY = STRINGS.kpiAccuracy || 'Accuracy';
  var L_REMAINING = STRINGS.kpiRemaining || 'Remaining';
  var LABEL_DISPLAY = STRINGS.failureLabelDisplay || {};
  function displayLabel(name) { return LABEL_DISPLAY[name] || name; }
  var LABELS = ${JSON.stringify(FAILURE_LABELS)};
  var PRED_LABELS = LABELS.concat(['UNKNOWN']);
  var storageKey = 'ccqa-report:' + (data.runId || data.createdAt);

  // ---- filtering ------------------------------------------------------
  var activeFilter = 'all';
  var searchQuery = '';

  function applyFilters() {
    var sections = document.querySelectorAll('.spec');
    var visible = 0;
    sections.forEach(function (el) {
      var statusOk = activeFilter === 'all' || el.getAttribute('data-status') === activeFilter;
      var name = (el.getAttribute('data-case-id') || '').toLowerCase();
      var searchOk = !searchQuery || name.indexOf(searchQuery) >= 0;
      var show = statusOk && searchOk;
      el.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    var note = document.getElementById('no-match');
    if (note) note.hidden = visible > 0;
  }

  var chips = document.querySelectorAll('#filter-chips .chip');
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      activeFilter = chip.getAttribute('data-filter') || 'all';
      chips.forEach(function (c) { c.classList.toggle('active', c === chip); });
      applyFilters();
    });
  });

  var search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', function () {
      searchQuery = search.value.trim().toLowerCase();
      applyFilters();
    });
  }

  // ---- measurement ----------------------------------------------------
  // cases: analyzed failures only — they carry a prediction we can grade.
  var cases = [];
  for (var i = 0; i < data.results.length; i++) {
    var r = data.results[i];
    if (r.status === 'failed' && r.analysis) {
      cases.push({ index: i, feature: r.feature, spec: r.spec, predicted: r.analysis.label });
    }
  }

  var state = {};
  try { state = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (e) { state = {}; }

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) {}
  }

  function caseKey(c) { return c.feature + '/' + c.spec; }

  function applyStateToInputs() {
    cases.forEach(function (c) {
      var entry = state[caseKey(c)];
      if (!entry) return;
      // Guard: only known labels may flow into the attribute selector below
      // (localStorage is user-controlled; anything else is dropped).
      if (entry.label && LABELS.indexOf(entry.label) >= 0) {
        var radio = document.querySelector('input[name="label--' + c.index + '"][value="' + entry.label + '"]');
        if (radio) radio.checked = true;
      }
      var note = document.querySelector('.note[data-case-index="' + c.index + '"]');
      if (note && entry.note) note.value = entry.note;
    });
  }

  // All metric DOM is built with createElement + textContent so the entries
  // here cannot inject markup. Labels themselves come from the server-baked
  // FAILURE_LABELS constant; numbers come from local counters. Keeping the
  // pipeline strict so future additions (e.g. user-provided notes) cannot
  // sneak in via innerHTML.
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function makeTile(value, label, attention) {
    var tile = el('div', { 'class': 'metric-tile' + (attention ? ' metric-tile-attention' : '') });
    tile.appendChild(el('span', { 'class': 'metric-tile-value' }, value));
    tile.appendChild(el('span', { 'class': 'metric-tile-label' }, label));
    return tile;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function renderMetrics() {
    var summary = document.getElementById('metrics-summary');
    var matrixTarget = document.getElementById('metrics-matrix');
    var perClassTarget = document.getElementById('metrics-perclass');
    if (!summary || !matrixTarget || !perClassTarget) return;

    var m = {};
    PRED_LABELS.forEach(function (p) {
      m[p] = {};
      LABELS.forEach(function (a) { m[p][a] = 0; });
    });

    var labeled = 0;
    var correct = 0;
    cases.forEach(function (c) {
      var entry = state[caseKey(c)];
      if (!entry || !entry.label || LABELS.indexOf(entry.label) < 0) return;
      labeled++;
      m[c.predicted][entry.label]++;
      if (c.predicted === entry.label) correct++;
    });

    var total = cases.length;
    var remaining = total - labeled;
    var accuracyText = labeled === 0 ? '–' : Math.round((correct / labeled) * 100) + '%';

    clear(summary);
    summary.appendChild(makeTile(labeled + ' / ' + total, L_LABELED, false));
    summary.appendChild(makeTile(accuracyText, L_ACCURACY, false));
    summary.appendChild(makeTile(remaining, L_REMAINING, remaining > 0));

    clear(matrixTarget);
    var matrix = el('table', { 'class': 'matrix' });
    var matrixHead = el('thead');
    var matrixHeadRow = el('tr');
    matrixHeadRow.appendChild(el('th', null, 'predicted \\ actual'));
    LABELS.forEach(function (a) { matrixHeadRow.appendChild(el('th', null, displayLabel(a))); });
    matrixHead.appendChild(matrixHeadRow);
    matrix.appendChild(matrixHead);
    var matrixBody = el('tbody');
    PRED_LABELS.forEach(function (p) {
      var row = el('tr');
      row.appendChild(el('th', null, displayLabel(p)));
      LABELS.forEach(function (a) {
        var v = m[p][a];
        var cls = p === a ? 'hit' : (v > 0 ? 'miss-nonzero' : '');
        row.appendChild(el('td', cls ? { 'class': cls } : null, v));
      });
      matrixBody.appendChild(row);
    });
    matrix.appendChild(matrixBody);
    matrixTarget.appendChild(matrix);

    clear(perClassTarget);
    var perClass = el('table', { 'class': 'matrix' });
    var perClassHead = el('thead');
    var perClassHeadRow = el('tr');
    ['class', 'precision', 'recall', 'F1', 'support'].forEach(function (h) {
      perClassHeadRow.appendChild(el('th', null, h));
    });
    perClassHead.appendChild(perClassHeadRow);
    perClass.appendChild(perClassHead);
    var perClassBody = el('tbody');
    LABELS.forEach(function (cls) {
      var tp = m[cls][cls];
      var predictedAs = 0;
      LABELS.forEach(function (a) { predictedAs += m[cls][a]; });
      var actualAs = 0;
      PRED_LABELS.forEach(function (p) { actualAs += m[p][cls]; });
      var precision = predictedAs > 0 ? tp / predictedAs : null;
      var recall = actualAs > 0 ? tp / actualAs : null;
      var f1 = precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall) : null;
      var row = el('tr');
      row.appendChild(el('th', null, displayLabel(cls)));
      row.appendChild(el('td', null, fmt(precision)));
      row.appendChild(el('td', null, fmt(recall)));
      row.appendChild(el('td', null, fmt(f1)));
      row.appendChild(el('td', null, actualAs));
      perClassBody.appendChild(row);
    });
    perClass.appendChild(perClassBody);
    perClassTarget.appendChild(perClass);
  }

  function fmt(v) { return v === null ? '–' : (Math.round(v * 100) / 100).toFixed(2); }

  function findCaseByIndex(index) {
    for (var i = 0; i < cases.length; i++) {
      if (cases[i].index === index) return cases[i];
    }
    return null;
  }

  function updateNeedsGradingChips() {
    var chips = document.querySelectorAll('.needs-grading-chip');
    chips.forEach(function (chip) {
      var id = chip.getAttribute('data-case-id') || '';
      var entry = state[id];
      var graded = entry && entry.label && LABELS.indexOf(entry.label) >= 0;
      chip.style.display = graded ? 'none' : '';
    });
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.name && t.name.indexOf('label--') === 0) {
      var index = parseInt(t.name.slice('label--'.length), 10);
      var c = findCaseByIndex(index);
      if (!c) return;
      var key = caseKey(c);
      state[key] = state[key] || {};
      state[key].label = t.value;
      save();
      renderMetrics();
      updateNeedsGradingChips();
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('note')) {
      var index = parseInt(t.getAttribute('data-case-index'), 10);
      var c = findCaseByIndex(index);
      if (!c) return;
      var key = caseKey(c);
      state[key] = state[key] || {};
      state[key].note = t.value;
      save();
    }
  });

  var exportBtn = document.getElementById('export-labels');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      var labels = [];
      cases.forEach(function (c) {
        var entry = state[caseKey(c)];
        if (!entry || !entry.label) return;
        var item = { feature: c.feature, spec: c.spec, predicted: c.predicted, label: entry.label };
        if (entry.note) item.note = entry.note;
        labels.push(item);
      });
      var payload = {
        schemaVersion: 1,
        runId: data.runId,
        promptVersion: data.promptVersion,
        exportedAt: new Date().toISOString(),
        labels: labels
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ccqa-labels-' + (data.runId || data.createdAt).replace(/[^A-Za-z0-9_-]/g, '_') + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  var importInput = document.getElementById('import-labels');
  if (importInput) {
    importInput.addEventListener('change', function () {
      var file = importInput.files && importInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var payload = JSON.parse(String(reader.result));
          (payload.labels || []).forEach(function (item) {
            var key = item.feature + '/' + item.spec;
            state[key] = state[key] || {};
            if (item.label) state[key].label = item.label;
            if (item.note) state[key].note = item.note;
          });
          save();
          applyStateToInputs();
          renderMetrics();
          updateNeedsGradingChips();
        } catch (e) {
          alert('Could not parse labels JSON: ' + e.message);
        }
      };
      reader.readAsText(file);
    });
  }

  applyStateToInputs();
  renderMetrics();
  updateNeedsGradingChips();
})();
`;
