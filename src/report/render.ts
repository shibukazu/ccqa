import { DRAFT_CATEGORY_LABEL } from "../types.ts";
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

  // <-escape every "<" so "</script>" inside logs/reasoning can never
  // terminate the data island. The result is still valid JSON.
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccqa run report</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="header-top">
      <h1>ccqa run report</h1>
      <div class="meta">
        <span title="generated at">${esc(formatDate(data.createdAt))}</span>
        ${totalDuration > 0 ? `<span>${formatDuration(totalDuration)}</span>` : ""}
        ${data.runId ? `<span>CI run ${esc(data.runId)}</span>` : ""}
        ${data.git.head ? `<span><code>${esc(data.git.head)}</code>${data.git.base ? ` vs <code>${esc(data.git.base)}</code>` : ""}</span>` : ""}
        <span class="dim">prompt v${esc(data.promptVersion)}</span>
      </div>
    </div>
    <div class="toolbar">
      <div class="chips" id="filter-chips">
        <button type="button" class="chip active" data-filter="all">All <span class="count">${data.results.length}</span></button>
        <button type="button" class="chip chip-pass" data-filter="passed">${passedCount} passed</button>
        <button type="button" class="chip chip-fail" data-filter="failed">${failed.length} failed</button>
      </div>
      <input type="search" id="search" placeholder="Filter by name…" autocomplete="off">
    </div>
  </div>
</header>

<div class="page">
${analyzed.length > 0 ? metricsPanel() : ""}

<main id="spec-list">
${data.results.map((r, i) => renderResult(r, i)).join("\n")}
</main>
<p class="empty-note" id="no-match" hidden>No specs match the current filter.</p>
</div>

<script type="application/json" id="ccqa-report-data">${dataJson}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}

function metricsPanel(): string {
  return `<section class="panel" id="measure-panel">
  <div class="panel-head">
    <h2>Prediction accuracy</h2>
    <div class="measure-actions">
      <button type="button" id="export-labels">Export labels (JSON)</button>
      <label class="import-label">Import labels<input type="file" id="import-labels" accept="application/json"></label>
    </div>
  </div>
  <p class="hint">Grade each failed case below with its true cause; the matrix updates live. Labels are saved in this browser (localStorage) — export them to keep or merge.</p>
  <div id="metrics"></div>
</section>`;
}

function renderResult(r: ReportSpecResult, index: number): string {
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
      ? `<span class="badge ${r.analysis.label}">${r.analysis.label}</span>`
      : "";

  return `<details class="spec ${r.status}" data-status="${r.status}" data-case-id="${esc(id)}"${r.status === "failed" ? " open" : ""}>
  <summary>
    ${statusIcon(r.status)}
    <span class="spec-name">${esc(id)}</span>
    ${predictionChip}
    ${r.ndRun ? `<span class="badge nd" title="non-deterministic">ND</span>` : ""}
    <span class="spacer"></span>
    ${counts}
    ${duration}
  </summary>
  <div class="spec-body">
    ${renderAssertions(r)}
    ${r.ndRun ? renderNdRun(r.ndRun) : ""}
    ${r.status === "failed" ? (r.analysis ? renderAnalysis(r, index) : renderSkipped(r)) : ""}
    ${renderDriftIssues(r)}
    ${collapsible("Failure log", r.failureLogExcerpt)}
    ${collapsible("Source diff (scoped)", r.diffExcerpt, "diff")}
    ${collapsible("spec.yaml", r.specYaml)}
  </div>
</details>`;
}

function renderNdRun(nd: NonNullable<ReportSpecResult["ndRun"]>): string {
  const stepItems = nd.steps
    .map((s) => {
      const before = s.beforePng
        ? `<a class="shot" href="${esc(s.beforePng)}" target="_blank" rel="noopener"><img src="${esc(s.beforePng)}" alt="before ${esc(s.stepId)}" loading="lazy"><span>before</span></a>`
        : "";
      const after = s.afterPng
        ? `<a class="shot" href="${esc(s.afterPng)}" target="_blank" rel="noopener"><img src="${esc(s.afterPng)}" alt="after ${esc(s.stepId)}" loading="lazy"><span>after</span></a>`
        : "";
      const dur = s.durationMs > 0 ? `<span class="duration">${formatDuration(s.durationMs)}</span>` : "";
      const sourceBadge = s.source && s.source !== "spec" ? `<span class="nd-source">[${esc(s.source)}]</span>` : "";
      return `<li class="nd-step ${s.status}">
        <div class="nd-step-head">
          ${statusIcon(s.status)}
          <span class="step-name">${esc(s.stepId)}</span>
          ${sourceBadge}
          <span class="spacer"></span>
          ${dur}
        </div>
        <div class="nd-step-body">
          <p class="nd-instr"><strong>do:</strong> ${esc(s.instruction)}</p>
          <p class="nd-instr"><strong>expect:</strong> ${esc(s.expected)}</p>
          ${s.reasoning ? `<p class="nd-reasoning">${esc(s.reasoning)}</p>` : ""}
          ${before || after ? `<div class="nd-shots">${before}${after}</div>` : ""}
        </div>
      </li>`;
    })
    .join("\n");
  return `<section class="nd-run">
    <div class="nd-run-head">
      <span class="dim">run-nd</span>
      <code>${esc(nd.runId)}</code>
      <span class="dim">session</span>
      <code>${esc(nd.sessionName)}</code>
      <span class="spacer"></span>
      <span class="duration">${formatDuration(nd.durationMs)}</span>
    </div>
    <ol class="nd-steps">${stepItems}</ol>
  </section>`;
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

function renderAnalysis(r: ReportSpecResult, index: number): string {
  const a = r.analysis!;
  const pct = Math.round(a.confidence * 100);
  const evidence =
    a.evidence.length > 0
      ? `<ul class="evidence">${a.evidence
          .map((e) => `<li>${e.file ? `<code>${esc(e.file)}</code> — ` : ""}${esc(e.detail)}</li>`)
          .join("")}</ul>`
      : "";

  return `<div class="analysis">
  <div class="prediction">
    <span class="badge ${a.label}">${a.label}</span>
    <span class="confidence" title="confidence"><span class="confidence-bar"><span style="width:${pct}%"></span></span>${pct}%</span>
    ${a.subDiagnosis && a.subDiagnosis !== "NONE" ? `<span class="sub">${esc(a.subDiagnosis)}</span>` : ""}
  </div>
  <p class="reasoning">${esc(a.reasoning)}</p>
  ${evidence}
  <div class="truth">
    <span class="truth-title">True cause</span>
    ${FAILURE_LABELS
      .map(
        (label) =>
          `<label class="truth-option ${label}"><input type="radio" name="label--${index}" value="${label}"><span>${label}</span></label>`,
      )
      .join("\n    ")}
    <input type="text" class="note" placeholder="note (optional)" data-case-index="${index}">
  </div>
</div>`;
}

function renderSkipped(r: ReportSpecResult): string {
  return `<div class="analysis skipped">analysis skipped${r.analysisSkipped ? `: ${esc(r.analysisSkipped)}` : ""}</div>`;
}

function renderDriftIssues(r: ReportSpecResult): string {
  if (!r.driftIssues || r.driftIssues.length === 0) return "";
  const items = r.driftIssues
    .map(
      (i) =>
        `<li><span class="severity ${i.severity}">${i.severity}</span> (${esc(DRAFT_CATEGORY_LABEL[i.category])}${i.stepId ? `, step ${esc(i.stepId)}` : ""}) ${esc(i.message)}${i.detail ? ` — ${esc(i.detail)}` : ""}</li>`,
    )
    .join("");
  return `<details class="drift"><summary>Spec↔code drift audit (${r.driftIssues.length})</summary><ul>${items}</ul></details>`;
}

function collapsible(title: string, content: string | null, kind = ""): string {
  if (!content) return "";
  return `<details class="raw ${kind}"><summary>${esc(title)}</summary><pre>${esc(content)}</pre></details>`;
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
.reasoning { font-size: 13px; margin: 9px 0; white-space: pre-wrap; line-height: 1.55; }
.evidence { font-size: 12.5px; color: var(--text-dim); margin: 6px 0; padding-left: 18px; line-height: 1.5; }
.evidence code { background: var(--surface); border: 1px solid var(--border); padding: 0 5px; border-radius: 4px; font-size: 11px; }
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
table.matrix { border-collapse: collapse; font-size: 12.5px; margin: 10px 16px 10px 0; display: inline-table; vertical-align: top; }
table.matrix th, table.matrix td { border: 1px solid var(--border); padding: 4px 12px; text-align: center; }
table.matrix th { background: var(--surface-2); font-weight: 600; }
table.matrix td { font-variant-numeric: tabular-nums; }
table.matrix td.hit { background: var(--pass-bg); font-weight: 700; }
table.matrix td.miss-nonzero { background: var(--fail-bg); }
.stats { font-size: 13px; }
.stats .big { font-size: 17px; font-weight: 700; }
.measure-actions { display: flex; gap: 14px; align-items: center; font-size: 12.5px; }
.measure-actions button {
  font: inherit; font-size: 12.5px; padding: 4px 13px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text);
}
.measure-actions button:hover { background: var(--surface-2); }
.import-label { cursor: pointer; color: var(--text-dim); }
.import-label input { display: none; }
.empty-note { color: var(--text-dim); text-align: center; font-size: 13px; }

.badge.nd { background: rgba(31, 111, 235, 0.12); color: var(--accent); }
.nd-run { padding: 0 16px 12px; }
.nd-run-head { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--text-dim); margin-bottom: 8px; padding-top: 8px; }
.nd-run-head code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: 11.5px; color: var(--text); }
.nd-run-head .dim { color: var(--text-dim); }
.nd-steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.nd-step { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); overflow: hidden; }
.nd-step.failed { border-color: var(--fail); }
.nd-step.passed { border-color: rgba(26, 127, 55, 0.4); }
.nd-step.skipped { opacity: 0.6; }
.nd-step-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--border); font-size: 13px; }
.nd-step-body { padding: 10px 14px; font-size: 12.5px; line-height: 1.55; }
.nd-step-body p { margin: 4px 0; }
.nd-instr strong { color: var(--text-dim); font-weight: 600; margin-right: 4px; }
.nd-reasoning { color: var(--text); font-style: italic; background: var(--surface); padding: 6px 10px; border-radius: 6px; }
.nd-source { font-size: 11px; color: var(--text-dim); }
.nd-shots { display: flex; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
.nd-shots .shot { display: flex; flex-direction: column; align-items: center; gap: 4px; text-decoration: none; color: var(--text-dim); font-size: 11px; }
.nd-shots .shot img { max-width: 280px; max-height: 180px; border: 1px solid var(--border); border-radius: 4px; object-fit: contain; background: #fff; }
`;

// Vanilla JS, no client-side template literals, no closing-script-tag string
// anywhere. The one \${} below is server-side interpolation: it bakes the
// schema's label list into the script so the two cannot drift apart.
const CLIENT_JS = `
(function () {
  var dataEl = document.getElementById('ccqa-report-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
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

  function renderMetrics() {
    var target = document.getElementById('metrics');
    if (!target) return;

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

    var html = '';
    html += '<div class="stats"><span class="big">' +
      (labeled === 0 ? '–' : Math.round((correct / labeled) * 100) + '%') +
      '</span> accuracy · ' + labeled + ' labeled / ' + cases.length + ' analyzed failures' +
      (cases.length - labeled > 0 ? ' · <strong>' + (cases.length - labeled) + ' unlabeled</strong>' : '') +
      '</div>';

    html += '<table class="matrix"><thead><tr><th>predicted \\\\ actual</th>';
    LABELS.forEach(function (a) { html += '<th>' + a + '</th>'; });
    html += '</tr></thead><tbody>';
    PRED_LABELS.forEach(function (p) {
      html += '<tr><th>' + p + '</th>';
      LABELS.forEach(function (a) {
        var v = m[p][a];
        var cls = p === a ? 'hit' : (v > 0 ? 'miss-nonzero' : '');
        html += '<td class="' + cls + '">' + v + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';

    html += '<table class="matrix"><thead><tr><th>class</th><th>precision</th><th>recall</th><th>F1</th><th>support</th></tr></thead><tbody>';
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
      html += '<tr><th>' + cls + '</th><td>' + fmt(precision) + '</td><td>' + fmt(recall) +
        '</td><td>' + fmt(f1) + '</td><td>' + actualAs + '</td></tr>';
    });
    html += '</tbody></table>';

    target.innerHTML = html;
  }

  function fmt(v) { return v === null ? '–' : (Math.round(v * 100) / 100).toFixed(2); }

  function findCaseByIndex(index) {
    for (var i = 0; i < cases.length; i++) {
      if (cases[i].index === index) return cases[i];
    }
    return null;
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
        } catch (e) {
          alert('Could not parse labels JSON: ' + e.message);
        }
      };
      reader.readAsText(file);
    });
  }

  applyStateToInputs();
  renderMetrics();
})();
`;
