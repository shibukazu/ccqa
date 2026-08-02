import { causesForKind, predictedForKind, PREDICTED_LABELS } from "../../report/schema.ts";
import { AGENT_BROWSER_TARGET } from "../../spec/yaml-schema.ts";
import { GUIDANCE_KINDS } from "../../prompts/prompt-names.ts";
import { RunStatusSchema } from "../contract/schema.ts";

/**
 * The hub's bundled WebUI: a single static HTML page with vanilla JS, in a
 * "one template-literal string, no build step" pattern. It is the run report —
 * there is no standalone HTML file; results render from report.json + evidence
 * PNGs fetched over the API. It talks to the hub exclusively through
 * `/api/v1/*` — the same public REST contract documented in
 * docs/hub-api.md and consumed by `ccqa/hub-client`.
 *
 * This is a structural constraint, not just a style choice: this module
 * must never import from `../core/*` or `../api/*` (enforced by
 * `ui-isolation.test.ts`). An intranet team can replace this entire file
 * with their own frontend without touching anything else in the hub,
 * because the UI has no privileged access the public API doesn't also
 * grant any other client. Importing types/constants from `../../report/*`
 * and `../../hub/contract/*` is fine — neither is core or api.
 *
 * Security stance (see docs/hub.md): the Secrets tab sends plaintext values
 * over the same TLS-protected API the CLI uses. The bearer token is persisted
 * to localStorage (key "ccqa-hub-token") so the operator doesn't re-enter it
 * every load, and is auto-reconnected on boot. This is a deliberate trade-off:
 * the hub is expected to run behind TLS on a trusted network (VPN/SSO), and
 * this UI renders every user- or API-derived string via
 * textContent/createElement — never innerHTML (innerHTML carries only static,
 * constant markup) — so its XSS surface is minimal. Plaintext SECRET VALUES
 * are never written to localStorage; only the token is. A "Disconnect"
 * control clears it. If the trust model does not hold for a given deployment,
 * an intranet team can swap this whole file for their own frontend.
 */
export function renderHubUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccqa hub</title>
<style>${CSS}</style>
</head>
<body>
${HTML_BODY}
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

// Every screen's "Refresh" button, from one builder so they are identical:
// same icon, same i18n label. data-i18n sits on the inner <span> (not the
// button) so applyStaticI18n's textContent swap replaces the label without
// dropping the icon.
function refreshButton(id: string): string {
  return `<button class="btn ghost sm" id="${id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> <span data-i18n="common.refresh">Refresh</span></button>`;
}

// Static page chrome (appbar/sidebar/views/sheet). All dynamic content is
// populated by CLIENT_JS via createElement/textContent — this string never
// carries API- or user-derived data.
const HTML_BODY = `
<div id="login" class="login" hidden>
  <div class="login-card">
    <div class="login-brand"><div class="glyph">c</div><span class="wm">ccqa hub</span></div>
    <h1 class="login-title" data-i18n="login.title">Connect to your hub</h1>
    <p class="login-sub" data-i18n="login.sub">Enter your bearer token to continue.</p>
    <label class="login-label" for="login-token" data-i18n="login.token">Token</label>
    <input id="login-token" class="input mono" type="password" spellcheck="false" placeholder="Bearer token" autocomplete="off">
    <button class="btn primary login-connect" id="login-connect" type="button" data-i18n="login.connect">Connect</button>
    <p id="login-error" class="login-error" hidden></p>
    <div class="note warn login-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg><span data-i18n="login.note">The token is stored only in this browser; secret values never are. Use the hub only behind TLS on a trusted network.</span></div>
  </div>
</div>
<div class="app" id="app" hidden>
  <header class="appbar">
    <div class="logo"><div class="glyph">c</div><span class="wm">ccqa hub</span></div>
    <div class="sw-wrap">
      <button class="sw-btn" id="project-switch" type="button" aria-haspopup="menu" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/></svg>
        <span class="k" data-i18n="app.project">project</span> <span class="v" id="project-current">none</span> <span class="chev">▾</span>
      </button>
      <div class="proj-menu" id="project-menu" role="menu" hidden></div>
    </div>
    <div class="spacer"></div>
    <div class="seg-toggle" role="group" aria-label="Language">
      <button class="seg" id="lang-en" type="button" aria-pressed="true">EN</button>
      <button class="seg" id="lang-ja" type="button" aria-pressed="false">日本語</button>
    </div>
    <button class="icon-btn" id="theme-toggle" type="button" aria-pressed="false" aria-label="Toggle theme" title="Toggle theme">
      <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
    <button class="btn ghost sm" id="disconnect" hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
      <span data-i18n="app.disconnect">Disconnect</span>
    </button>
  </header>

  <aside class="sidebar">
    <nav class="nav nav-top">
      <a href="#/projects" class="nav-projects"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg> <span data-i18n="nav.projects">Projects</span></a>
    </nav>
    <div class="nav-group" id="sidebar-project">no project</div>
    <nav class="nav">
      <a href="#/runs" class="nav-runs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg> <span data-i18n="nav.runs">Runs</span></a>
      <a href="#/perspectives" class="nav-perspectives"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg> <span data-i18n="nav.perspectives">Perspectives</span></a>
      <a href="#/secrets" class="nav-secrets"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> <span data-i18n="nav.secrets">Secrets</span></a>
      <a href="#/prompts" class="nav-prompts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/><path d="M8 13h6M8 17h6"/></svg> <span data-i18n="nav.prompts">Prompts</span></a>
      <a href="#/jobs" class="nav-jobs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg> <span data-i18n="nav.learning">Learning</span></a>
    </nav>
  </aside>

  <div class="main">

    <!-- ===== PROJECTS ===== -->
    <section id="view-projects" hidden>
      <div class="page-bar">
        <h1 data-i18n="projects.title">Projects</h1>
        <div class="spacer"></div>
        ${refreshButton("projects-refresh")}
        <button class="btn primary sm" id="projects-new">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> <span data-i18n="projects.new">New project</span>
        </button>
      </div>
      <div class="content">
        <p id="projects-status" class="empty-note" hidden></p>
        <div class="proj-grid" id="projects-grid"></div>
      </div>
    </section>

    <!-- ===== RUNS LIST ===== -->
    <section id="view-runs">
      <div class="page-bar">
        <h1 data-i18n="runs.title">Runs</h1>
        <span class="total" id="runs-total-cost" hidden></span>
        <span class="total" id="runs-capped" hidden></span>
        <!-- Ruled off from the two above because it counts something else: the
             project's whole spend, not what the listed runs cost. -->
        <span class="total apart" id="runs-spend-24h" hidden></span>
        <div class="spacer"></div>
        ${refreshButton("runs-refresh")}
      </div>
      <div class="content">
        <!-- Deliberately selects and a native date input, not the .fchip
             toggles the rest of the page uses: these three refetch, and a chip
             group beside a date box would be the odd one out. Their options
             are built by syncRunsFilters. -->
        <div class="toolbar">
          <div class="fgroup">
            <label class="fgroup-label" for="runs-f-date" data-i18n="runs.filter.date">Date</label>
            <input class="fctl" type="date" id="runs-f-date">
          </div>
          <div class="fgroup">
            <label class="fgroup-label" for="runs-f-kind" data-i18n="runs.filter.kind">Kind</label>
            <select class="fctl" id="runs-f-kind"></select>
          </div>
          <div class="fgroup">
            <label class="fgroup-label" for="runs-f-status" data-i18n="runs.filter.status">Status</label>
            <select class="fctl" id="runs-f-status"></select>
          </div>
        </div>
        <div class="card" id="runs-card">
          <div class="table-wrap">
            <table>
              <thead><tr><th data-i18n="runs.col.run">Run</th><th data-i18n="runs.col.status">Status</th><th data-i18n="runs.col.cost">Cost</th><th data-i18n="runs.col.created">Created</th></tr></thead>
              <tbody id="runs-tbody"></tbody>
            </table>
          </div>
        </div>
        <p class="empty-note" id="runs-empty" hidden data-i18n="runs.empty">Select a project to see its runs.</p>
      </div>
    </section>

    <!-- ===== PERSPECTIVES ===== -->
    <section id="view-perspectives" hidden>
      <div class="page-bar">
        <h1 data-i18n="perspectives.title">Perspectives</h1>
        <span class="updated" id="persp-updated"></span>
        <div class="spacer"></div>
        ${refreshButton("persp-refresh")}
      </div>
      <div class="content">
        <p id="persp-status" class="empty-note" hidden></p>
        <div id="persp-body" hidden>
          <div class="ov" id="persp-ov"></div>
          <div class="note info persp-note" id="persp-rerun-note" hidden></div>
          <div class="toolbar">
            <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="persp-q" type="search" data-i18n-ph="perspectives.search" aria-label="Search cases"></label>
            <!-- Each chip carries the count of what it would leave behind, so
                 data-i18n sits on the inner label span: applyStaticI18n swaps
                 textContent, which on the button would delete the count. Two
                 labelled groups rather than one row: mode and verdict are
                 different questions, and mixing their chips together read as
                 one. -->
            <div class="fgroup">
              <span class="fgroup-label" data-i18n="perspectives.filter.group.mode">Mode</span>
              <button class="fchip" data-f="all" aria-pressed="true" type="button"><span data-i18n="perspectives.filter.all">All</span><span class="fcount"></span></button>
              <button class="fchip" data-f="deterministic" aria-pressed="false" type="button"><span data-i18n="perspectives.filter.deterministic">Deterministic</span><span class="fcount"></span></button>
              <button class="fchip" data-f="live" aria-pressed="false" type="button"><span data-i18n="perspectives.filter.live">Live</span><span class="fcount"></span></button>
            </div>
            <!-- Same words as the 判定 column (perspectives.rerun.state.*) and
                 the same group label as its header (perspectives.col.verdict)
                 — a filter chip must never coin its own name for a verdict. -->
            <div class="fgroup" id="persp-verdict-chips" hidden>
              <span class="fgroup-label" data-i18n="perspectives.col.verdict">Verdict</span>
              <button class="fchip" id="persp-chip-needsrepair" data-f="needsRepair" aria-pressed="false" type="button"><span data-i18n="perspectives.rerun.state.needsRepair">Needs repair</span><span class="fcount"></span></button>
              <button class="fchip" id="persp-chip-rerunneeded" data-f="rerunNeeded" aria-pressed="false" type="button"><span data-i18n="perspectives.rerun.state.rerunNeeded">Re-run needed</span><span class="fcount"></span></button>
              <button class="fchip" id="persp-chip-inprogress" data-f="inProgress" aria-pressed="false" type="button"><span data-i18n="perspectives.rerun.state.inProgress">In progress</span><span class="fcount"></span></button>
              <button class="fchip" id="persp-chip-verified" data-f="verified" aria-pressed="false" type="button"><span data-i18n="perspectives.rerun.state.verified">Verified</span><span class="fcount"></span></button>
            </div>
            <div class="spacer"></div>
            <span class="muted persp-head" id="persp-deploy-head" hidden></span>
            <div class="sw-wrap" id="persp-profile-wrap">
              <button class="sw-btn" id="persp-profile-switch" type="button" aria-haspopup="menu" aria-expanded="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span class="k" data-i18n="app.profile">profile</span> <span class="v" id="persp-profile-current">default</span> <span class="chev">▾</span>
              </button>
              <div class="proj-menu right" id="persp-profile-menu" role="menu" hidden></div>
            </div>
          </div>
          <div class="tblcard"><div class="table-wrap"><table>
            <thead><tr><th data-i18n="perspectives.col.case">Case</th><th data-i18n="perspectives.col.mode">Mode</th><th id="persp-th-verdict" data-i18n="perspectives.col.verdict" hidden>Verdict</th><th id="persp-th-run" data-i18n="perspectives.col.run" hidden>Execution</th><th id="persp-th-audit" data-i18n="perspectives.col.audit" hidden>Audit</th><th></th></tr></thead>
            <tbody id="persp-tbody"></tbody>
          </table></div></div>
          <p class="empty-note" id="persp-no-hit" hidden data-i18n="perspectives.noHit">No matching cases.</p>
        </div>
      </div>
    </section>

    <!-- ===== RUN DETAIL ===== -->
    <section id="view-detail" hidden>
      <div class="page-bar">
        <button class="back" id="detail-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg> <span data-i18n="detail.back">Runs</span></button>
        <span class="muted">/</span>
        <h1 class="mono" id="detail-title" style="font-size:17px"></h1>
      </div>
      <div class="content">
        <div class="rd-head" id="rd-head"></div>

        <!-- Triage first: grading + learning is the most important action, so it
             sits above the spec list rather than being buried below it. The
             heading row carries the graded counter; one card below it holds
             the confusion matrix (or its empty state) with the learn CTA as
             the card footer — grades are the learning job's input, so
             grade → tally → learn reads top to bottom. -->
        <div class="triage-head" id="triage-head">
          <h3 style="font-size:14px" data-i18n="detail.triage">Triage</h3>
          <span class="triage-summary" id="triage-summary"></span>
        </div>
        <div class="card triage-card" id="triage-card">
          <div id="matrix-card"></div>
          <div class="learn-cta" id="learn-cta" hidden>
            <div class="learn-cta-text">
              <div class="t" data-i18n="learn.cta.title">Learn from these grades</div>
              <div class="d" data-i18n="learn.cta.desc">Turn the graded cases into a custom prompt that calibrates future failure classification.</div>
            </div>
            <div class="learn-cta-actions">
              <button class="btn primary sm" id="learn-run" data-i18n="learn.cta.run">Learn</button>
            </div>
          </div>
        </div>

        <div class="toolbar" style="margin-top:24px">
          <h3 style="font-size:14px"><span data-i18n="detail.specs">Specs</span> <span class="muted" id="detail-spec-count" style="font-weight:500"></span></h3>
          <div class="spacer"></div>
        </div>

        <div id="detail-error" class="empty-note" hidden></div>
        <div id="spec-cards"></div>
      </div>
    </section>

    <!-- ===== LEARNING JOBS ===== -->
    <section id="view-jobs" hidden>
      <div class="page-bar">
        <h1 data-i18n="learning.title">Learning</h1>
        <div class="spacer"></div>
        ${refreshButton("jobs-refresh")}
      </div>
      <div class="content">
        <p id="jobs-status" class="empty-note" hidden></p>
        <div class="card" id="jobs-list-card">
          <div class="table-wrap"><table><thead><tr><th data-i18n="jobs.col.job">Job</th><th data-i18n="jobs.col.status">Status</th><th data-i18n="jobs.col.customPrompt">Custom prompt</th><th data-i18n="jobs.col.created">Created</th></tr></thead><tbody id="jobs-tbody"></tbody></table></div>
        </div>
        <div id="job-detail" hidden></div>
      </div>
    </section>

    <!-- ===== SECRETS ===== -->
    <section id="view-secrets" hidden>
      <div class="page-bar">
        <h1 data-i18n="secrets.title">Secrets</h1>
        <div class="sw-wrap" id="sec-profile-wrap" style="margin-left:12px">
          <button class="sw-btn" id="sec-profile-switch" type="button" aria-haspopup="menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span class="k" data-i18n="app.profile">profile</span> <span class="v" id="sec-profile-current">default</span> <span class="chev">▾</span>
          </button>
          <div class="proj-menu" id="sec-profile-menu" role="menu" hidden></div>
        </div>
        <div class="spacer"></div>
        ${refreshButton("sec-load")}
      </div>
      <div class="content">
        <div class="scope-note">
          <span class="lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> AES-256-GCM at rest</span>
        </div>
        <p id="secrets-status" class="empty-note" hidden></p>
        <div class="split">
          <div class="card">
            <div class="panel-head"><h3><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg> Variables <span class="count" id="vars-count">0</span></h3><button class="btn sm primary" id="var-open-sheet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> <span data-i18n="common.add">Add</span></button></div>
            <div class="table-wrap"><table><thead><tr><th data-i18n="common.name">Name</th><th data-i18n="common.value">Value</th><th></th></tr></thead><tbody id="vars-tbody"></tbody></table></div>
          </div>
          <div class="card">
            <div class="panel-head"><h3><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v12H4z"/><path d="M2 20h20"/></svg> Sessions <span class="count" id="sessions-count">0</span></h3><button class="btn sm primary" id="session-open-sheet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg> <span data-i18n="common.add">Add</span></button></div>
            <div class="table-wrap"><table><thead><tr><th data-i18n="common.name">Name</th><th data-i18n="common.updated">Updated</th><th></th></tr></thead><tbody id="sessions-tbody"></tbody></table></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== PROMPTS ===== -->
    <section id="view-prompts" hidden>
      <div class="page-bar">
        <h1 data-i18n="prompts.title">Prompts</h1>
        <div class="spacer"></div>
        ${refreshButton("pr-load")}
      </div>
      <div class="content">
        <p id="prompts-status" class="empty-note" hidden></p>
        <div id="prompt-cards"></div>
      </div>
    </section>

  </div>
</div>

<div id="lightbox" class="lightbox" hidden><img id="lightbox-img" alt=""></div>
<div id="scrim" class="scrim" hidden></div>
<aside id="sheet" class="sheet" hidden>
  <div class="sheet-head">
    <h2 id="sheet-title">Add variable</h2>
    <p>Encrypted at rest; fetched at run time by <span class="mono" style="font-size:12px">ccqa run</span>.</p>
    <div class="scope"><span class="chip" id="sheet-scope-project">—</span> <span class="muted" style="margin:0 4px">/</span> <span class="chip" id="sheet-scope-profile">—</span></div>
  </div>
  <div class="sheet-body" id="sheet-body-var">
    <div class="form-row"><label data-i18n="common.name">Name</label><input class="input mono" id="var-name" spellcheck="false" placeholder="NAME"></div>
    <div class="form-row"><label data-i18n="common.value">Value</label><input class="input mono" id="var-value" spellcheck="false" placeholder="value"></div>
    <div class="switch-row"><div><div class="t">Sensitive</div><div class="d">Hidden from listings; still provided to runs.</div></div><button class="toggle" id="var-sensitive" type="button" aria-pressed="false"><i></i></button></div>
  </div>
  <div class="sheet-body" id="sheet-body-session" hidden>
    <div class="form-row"><label data-i18n="common.name">Name</label><input class="input mono" id="session-name" spellcheck="false" placeholder="session name"></div>
    <div class="form-row">
      <label>Storage-state JSON</label>
      <div class="note info" style="margin-bottom:8px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        <div style="min-width:0">
          <div style="font-weight:600" data-i18n="session.help.title">How to get this JSON</div>
          <ol class="help-steps">
            <li><span class="step-n">1</span><div class="step-b"><span data-i18n="session.help.step1">Run this in your terminal and log in by hand when the browser opens:</span>
              <div class="cmd"><code id="session-help-cmd">ccqa hub session capture &lt;name&gt;</code><button type="button" class="copy" id="session-help-copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span data-i18n="common.copy">Copy</span></button></div>
            </div></li>
            <li><span class="step-n">2</span><div class="step-b"><span data-i18n="session.help.step2">Open the saved file and paste its contents below:</span>
              <div style="margin-top:5px"><span class="path">.ccqa/sessions/&lt;profile&gt;/&lt;name&gt;.json</span></div>
            </div></li>
          </ol>
        </div>
      </div>
      <textarea class="textarea" id="session-state" spellcheck="false" placeholder='{"cookies":[...],"origins":[...]}'></textarea>
    </div>
  </div>
  <div style="padding:0 22px 4px"><div class="note warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg><span>Values transit the API in plaintext — use the hub only behind TLS on a trusted network. Secret values are never stored in your browser; only the connection token is (clear it with “Disconnect”).</span></div></div>
  <div class="sheet-foot"><button class="btn" id="sheet-cancel" data-i18n="common.cancel">Cancel</button><button class="btn primary" id="sheet-save" data-i18n="common.save">Save</button></div>
</aside>

<div id="project-dialog" class="dialog" hidden role="dialog" aria-modal="true" aria-labelledby="pd-title">
  <div class="dialog-head"><h2 id="pd-title" data-i18n="projects.new">New project</h2></div>
  <div class="dialog-body">
    <div class="form-row">
      <label for="pd-name" data-i18n="common.name">Name</label>
      <input id="pd-name" class="input mono" spellcheck="false" autocomplete="off" placeholder="my-project">
    </div>
    <p id="pd-error" class="dialog-error" hidden></p>
    <p class="dialog-hint">Letters, digits, and <span class="mono">. _ -</span> (must start alphanumeric).</p>
  </div>
  <div class="dialog-foot"><button class="btn" id="pd-cancel" data-i18n="common.cancel">Cancel</button><button class="btn primary" id="pd-create" data-i18n="common.create">Create</button></div>
</div>
`;

const CSS = `
  /* Light-default palette, calibrated to shadcn/ui's canonical "neutral" ramp
     (zinc grays, near-black primary, quiet 1px borders, flat cards). The .dark
     block below overrides the same tokens, so every component rule re-themes
     automatically. --accent maps to a neutral (near-black light / near-white
     dark) primary — no brand hue. */
  :root {
    --bg: #ffffff; --surface: #ffffff; --surface-2: #f4f4f5; --surface-3: #e4e4e7;
    --border: #e4e4e7; --border-strong: #d4d4d8;
    --fg: #18181b; --fg-dim: #3f3f46; --muted: #71717a; --muted-2: #a1a1aa;
    /* "accent" is a neutral primary: near-black surface, near-white text. */
    --accent: #18181b; --accent-2: #18181b; --accent-fg: #fafafa;
    --accent-border: #d4d4d8;
    --ring: rgba(161,161,170,0.5);
    --pass: #16a34a; --pass-bg: #f0fdf4; --pass-border: #bbf7d0;
    --fail: #dc2626; --fail-bg: #fef2f2; --fail-border: #fecaca;
    --info: #2563eb; --info-bg: #eff6ff; --info-border: #bfdbfe;
    --amber: #a16207; --amber-bg: #fefce8; --amber-border: #fde68a;
    /* Fill counterpart of --amber. The token above is tuned for *text* on
       --amber-bg, so at swatch size it reads brown; a filled area needs the
       actual yellow the badge is understood to mean. Same value in both
       themes, since a fill has no contrast-on-background constraint. */
    --amber-fill: #eab308;
    --violet: #7c3aed; --violet-bg: #f5f3ff; --violet-border: #ddd6fe;
    --radius: 10px; --radius-md: 8px; --radius-sm: 6px;
    --shadow: 0 10px 38px -10px rgba(0,0,0,0.20), 0 4px 12px -4px rgba(0,0,0,0.10);
    --font: "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  .dark {
    --bg: #0a0a0a; --surface: #171717; --surface-2: #262626; --surface-3: #2e2e2e;
    --border: rgba(255,255,255,0.10); --border-strong: rgba(255,255,255,0.16);
    --fg: #fafafa; --fg-dim: #d4d4d8; --muted: #a1a1aa; --muted-2: #71717a;
    --accent: #fafafa; --accent-2: #fafafa; --accent-fg: #18181b;
    --accent-border: rgba(255,255,255,0.16);
    --ring: rgba(113,113,122,0.6);
    --pass: #4ade80; --pass-bg: rgba(74,222,128,0.10); --pass-border: rgba(74,222,128,0.25);
    --fail: #f87171; --fail-bg: rgba(248,113,113,0.10); --fail-border: rgba(248,113,113,0.25);
    --info: #60a5fa; --info-bg: rgba(96,165,250,0.10); --info-border: rgba(96,165,250,0.25);
    --amber: #eab308; --amber-bg: rgba(234,179,8,0.10); --amber-border: rgba(234,179,8,0.25);
    --amber-fill: #eab308;
    --violet: #a78bfa; --violet-bg: rgba(167,139,250,0.10); --violet-border: rgba(167,139,250,0.25);
    --shadow: 0 10px 38px -10px rgba(0,0,0,0.6), 0 4px 12px -4px rgba(0,0,0,0.4);
  }
  * { box-sizing: border-box; }
  /* Honor the HTML hidden attribute even on elements whose class sets a
     display value (.sheet/.scrim/.sheet-body use flex, which would otherwise
     win over hidden's default display:none and show the sheet on load). */
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  h1,h2,h3 { margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  button { font-family: inherit; cursor: pointer; color: inherit; }
  code { font-family: var(--mono); }
  /* One consistent focus ring on every interactive control (shadcn calm). */
  a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible {
    outline: none; box-shadow: 0 0 0 3px var(--ring);
  }

  .app { display: grid; grid-template-columns: 208px 1fr; grid-template-rows: 52px 1fr; min-height: 100vh; }

  .appbar { grid-column: 1/3; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .logo { display: flex; align-items: center; gap: 9px; width: 176px; }
  .logo .glyph { width: 26px; height: 26px; border-radius: 7px; background: var(--accent); display: grid; place-items: center; color: var(--accent-fg); font-weight: 700; font-size: 14px; }
  .logo .wm { font-weight: 600; font-size: 15px; letter-spacing: -0.02em; }
  .sw-btn { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface-2); font-size: 13px; font-weight: 500; position: relative; }
  .sw-btn:hover { background: var(--surface-3); }
  .sw-btn svg { width: 14px; height: 14px; color: var(--muted); }
  .sw-btn .k { color: var(--muted-2); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .sw-btn .v { color: var(--fg); font-family: var(--mono); font-size: 12.5px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sw-btn .chev { color: var(--muted-2); font-size: 10px; }

  /* project dropdown (replaces the old floating <select>) */
  .sw-wrap { position: relative; }
  .sw-btn[aria-expanded="true"] { background: var(--surface-3); border-color: var(--accent-border); }
  .proj-menu {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 60;
    min-width: 232px; max-height: 60vh; overflow-y: auto;
    background: var(--surface-2); border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm); box-shadow: var(--shadow); padding: 5px;
  }
  .proj-menu .mi {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 7px 9px; border-radius: 6px; border: none; background: none;
    color: var(--fg); font: inherit; font-size: 13px; text-align: left;
  }
  .proj-menu .mi:hover { background: var(--surface-3); }
  .proj-menu .mi .name { font-family: var(--mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-menu .mi.current { color: var(--fg); font-weight: 600; }
  .proj-menu .mi.current::after { content: "✓"; margin-left: auto; color: var(--fg); font-size: 12px; }
  .proj-menu .mi.action { color: var(--fg); font-weight: 600; }
  .proj-menu .mi.action svg { width: 14px; height: 14px; stroke-width: 2; }
  .proj-menu .sep { height: 1px; background: var(--border); margin: 5px 4px; }
  .proj-menu .mi-empty { padding: 8px 9px; color: var(--muted); font-size: 12.5px; }

  .appbar .spacer { flex: 1; }

  .sidebar { border-right: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; padding: 14px 12px; }
  .nav-group { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted-2); font-weight: 600; padding: 4px 8px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav a { display: flex; align-items: center; gap: 11px; padding: 8px 10px; border-radius: var(--radius-sm); color: var(--muted); text-decoration: none; font-weight: 500; font-size: 13.5px; }
  .nav a svg { width: 17px; height: 17px; stroke-width: 1.9; opacity: 0.9; }
  .nav a:hover { background: var(--surface-2); color: var(--fg); }
  .nav a.active { background: var(--surface-2); color: var(--fg); font-weight: 600; }
  .nav a.disabled { opacity: 0.4; pointer-events: none; }
  .nav.nav-top { margin-bottom: 2px; }

  /* projects view */
  .proj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .proj-card {
    display: flex; align-items: center; gap: 12px; text-align: left;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px; color: var(--fg); font: inherit; cursor: pointer;
  }
  .proj-card:hover { border-color: var(--border-strong); background: var(--surface-2); }
  .proj-card .pglyph {
    width: 34px; height: 34px; border-radius: 8px; flex: none;
    background: var(--surface-2); border: 1px solid var(--border);
    display: grid; place-items: center; color: var(--fg-dim);
    font-family: var(--mono); font-weight: 700; font-size: 14px; text-transform: uppercase;
  }
  .proj-card .pname { font-family: var(--mono); font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-card.current { border-color: var(--fg); }
  .proj-card .pcur { margin-left: auto; font-size: 11px; color: var(--fg-dim); font-weight: 600; }
  .proj-card.new { border-style: dashed; color: var(--fg-dim); justify-content: center; font-weight: 500; }
  .proj-card.new svg { width: 16px; height: 16px; stroke-width: 2; }

  .main { overflow-y: auto; min-width: 0; }
  .page-bar { display: flex; align-items: center; gap: 12px; padding: 16px 24px 0; }
  .page-bar h1 { font-size: 20px; }
  .page-bar .back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; background: none; border: none; padding: 0; }
  .page-bar .back:hover { color: var(--fg); }
  .page-bar .back svg { width: 15px; height: 15px; }
  .page-bar .filters { display: flex; gap: 8px; margin-left: 8px; }
  .page-bar .total { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .page-bar .total.apart { padding-left: 12px; border-left: 1px solid var(--border); }
  .page-bar .spacer { flex: 1; }
  .content { padding: 18px 24px 48px; }

  .pill { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); font-size: 13px; color: var(--fg-dim); }
  .seg-input { background: var(--surface-3); border: none; border-radius: 5px; padding: 1px 7px; font-weight: 600; font-size: 12px; color: var(--fg); font: inherit; width: 90px; }
  .seg-input:focus { outline: none; box-shadow: 0 0 0 3px var(--ring); }

  .btn { display: inline-flex; align-items: center; gap: 7px; height: 33px; padding: 0 13px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface-2); font-size: 13px; font-weight: 500; color: var(--fg); text-decoration: none; }
  .btn:hover { background: var(--surface-3); }
  .btn svg { width: 15px; height: 15px; stroke-width: 2; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn.primary:hover { opacity: 0.9; }
  .btn.sm { height: 28px; padding: 0 9px; font-size: 12px; }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .btn.ghost:hover { background: var(--surface-2); color: var(--fg); }
  .btn[disabled] { opacity: 0.5; cursor: default; pointer-events: none; }

  /* icon-only button (theme toggle) */
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); background: var(--surface); color: var(--muted); }
  .icon-btn:hover { background: var(--surface-2); color: var(--fg); }
  .icon-btn svg { width: 16px; height: 16px; }
  .icon-btn .moon { display: none; }
  .dark .icon-btn .sun { display: none; }
  .dark .icon-btn .moon { display: inline; }

  /* segmented control — shared by the header language switch and triage grading */
  .seg-toggle { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-md); overflow: hidden; background: var(--surface); }
  .seg-toggle .seg { height: 30px; padding: 0 12px; border: 0; background: transparent; color: var(--muted); font-size: 13px; font-weight: 500; border-right: 1px solid var(--border); }
  .seg-toggle .seg:last-child { border-right: 0; }
  .seg-toggle .seg:hover { background: var(--surface-2); color: var(--fg); }
  .seg-toggle .seg[aria-pressed="true"] { background: var(--surface-2); color: var(--fg); font-weight: 600; }

  .toolbar { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
  .toolbar .spacer { flex: 1; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 14px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  thead th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 11px 16px; border-bottom: 1px solid var(--border); background: var(--surface-2); white-space: nowrap; }
  tbody td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.row { cursor: pointer; }
  tbody tr.row:hover { background: var(--surface-2); }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); }
  .num { font-variant-numeric: tabular-nums; }
  .empty-note { color: var(--muted); font-size: 13px; padding: 16px 2px; }

  .runid { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  /* Chips wrap when a run carries several labels. Laid out as inline content
     they wrapped to a line indented by the chips' own left margin, and the two
     lines sat at text leading — too tight to read as separate rows. Flex with a
     gap aligns every line at the same left edge and spaces them the same way
     horizontally and vertically. */
  .subline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
  .ci-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-family: var(--mono); color: var(--muted); background: var(--surface-3); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
  .ci-badge.local { color: var(--muted-2); }
  a.ci-badge { text-decoration: none; }
  a.ci-badge:hover { color: var(--fg); border-color: var(--fg-dim); }

  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 7px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; border: 1px solid transparent; white-space: nowrap; }
  .badge .d { width: 6px; height: 6px; border-radius: 50%; }
  .badge.pass, .badge.passed { background: var(--pass-bg); color: var(--pass); border-color: var(--pass-border); }
  .badge.pass .d, .badge.passed .d { background: var(--pass); }
  .badge.fail, .badge.failed { background: var(--fail-bg); color: var(--fail); border-color: var(--fail-border); }
  .badge.fail .d, .badge.failed .d { background: var(--fail); }
  .badge.skipped { background: var(--surface-3); color: var(--muted); border-color: var(--border); }
  .badge.skipped .d { background: var(--muted); }
  .badge.running { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .badge.running .d { background: var(--amber); }
  /* A drift verdict is a diagnosis, not a broken test: amber, never fail-red.
     Without these the badge rendered as bare text next to the pill-shaped
     pass/fail ones, and read as a different kind of thing. */
  .badge.dr-found { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .badge.dr-found .d { background: var(--amber); }
  .badge.dr-clean { background: var(--pass-bg); color: var(--pass); border-color: var(--pass-border); }
  .badge.dr-clean .d { background: var(--pass); }
  .badge.dr-unknown { background: var(--surface-3); color: var(--muted); border-color: var(--border); }
  .badge.dr-unknown .d { background: var(--muted); }
  .badge-live, .badge-det { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; border: 1px solid transparent; }
  .badge-live { background: var(--violet-bg); color: var(--violet); border-color: var(--violet-border); }
  .badge-det { background: var(--surface-3); color: var(--muted); border-color: var(--border); }
  /* which generation target ran the spec (agent-browser / playwright / runn) */
  .badge-target { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; font-family: var(--mono); background: var(--surface-3); color: var(--muted); border: 1px solid var(--border); }
  .chip { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 6px; background: var(--surface-3); border: 1px solid var(--border); color: var(--fg-dim); font-size: 12px; font-family: var(--mono); white-space: nowrap; }
  .chip.icon-chip { gap: 5px; padding-left: 6px; }
  .chip.icon-chip svg { width: 12px; height: 12px; flex: none; opacity: .7; }
  /* Below .chip in source order so these override its background/border/color
     when combined as class="chip drift-count-chip" (same specificity — source
     order decides). One amber look for every drift label chip — a label chip
     is a finding, not a severity, so it does not split into fail-red/amber
     the way the old errors/warnings counts did. */
  .chip.kind-chip { color: var(--violet); background: var(--violet-bg); border-color: var(--violet-border); font-family: var(--font); }
  .chip.drift-count-chip { color: var(--amber); background: var(--amber-bg); border-color: var(--amber-border); }
  /* Prose, not an identifier — and neutral, since it qualifies the label chip
     beside it rather than claiming a severity of its own. */
  .chip.spec-change-chip { font-family: var(--font); }
  .drift-meta-box { display: flex; flex-direction: column; gap: 4px; }
  /* The chips carry their own margin for the run list, where they sit inline
     after other chips. Here the container owns the spacing, so the margin only
     indents the first one away from the label and the ratio line below it. */
  .drift-meta-chips { display: flex; gap: 6px; }
  .drift-meta-chips .chip { margin-left: 0; }

  /* run detail */
  .rd-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 16px; }
  .rd-head .idblock { display: flex; flex-direction: column; gap: 6px; }
  .rd-head .idblock .t { display: flex; align-items: center; gap: 10px; }
  .rd-head .idblock .t .runid { font-size: 17px; }
  .rd-head .meta { display: flex; gap: 22px; margin-left: auto; flex-wrap: wrap; }
  .rd-head .meta .m .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted-2); font-weight: 600; }
  .rd-head .meta .m .v { font-size: 13.5px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .rd-actions { display: flex; gap: 8px; margin-top: 14px; width: 100%; }

  .lbl { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; border: 1px solid var(--border); background: var(--surface-2); color: var(--fg-dim); }
  .lbl.TEST_DRIFT { color: var(--info); border-color: var(--info-border); background: var(--info-bg); }
  .lbl.SPEC_CHANGE { color: var(--amber); border-color: var(--amber-border); background: var(--amber-bg); }
  .lbl.PRODUCT_BUG { color: var(--fail); border-color: var(--fail-border); background: var(--fail-bg); }
  .lbl.ENVIRONMENT { color: var(--violet); border-color: var(--violet-border); background: var(--violet-bg); }
  .lbl.UNKNOWN, .lbl.none { color: var(--muted); }
  .conf { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }

  /* spec cards — Tier1 header (scan) / Tier2 verdict+grading / Tier3 accordions */
  .spec-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; }
  /* verdict signal is a single left rail on the whole card — no all-sides tint */
  .spec-card.failed { border-left: 3px solid var(--fail); }
  /* A drift-kind card's "failed" rail is a diagnosis, not a broken test — same
     amber as the drift badges (dr-found), not fail-red. */
  .spec-card.drift-found { border-left: 3px solid var(--amber); }
  .spec-card.passed { border-left: 3px solid var(--pass); }
  .spec-card-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; }
  .spec-card-head .name { font-weight: 600; font-size: 15px; }
  .spec-card-head .slug { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 2px; }
  .spec-card-head .spacer { flex: 1; }
  .spec-card-body { padding: 0 20px 16px; }
  /* Tier2 verdict block */
  /* The diagnosis card: a bordered sub-surface so the model's verdict + the
     grading zone read as one unit, distinct from the execution details
     (steps/assertions) below it. */
  .analysis-box { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); padding: 14px 16px; }
  .analysis-box .acc > summary:hover { background: var(--surface-3); }
  .analysis-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .analysis-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13.5px; }
  .analysis-kv .k { font-size: 11px; font-weight: 600; color: var(--muted); padding-top: 3px; white-space: nowrap; }
  .analysis-kv .v { color: var(--fg-dim); line-height: 1.55; }
  .analysis-kv .v.headline { color: var(--fg); font-weight: 600; }
  /* Model-evidence rows reuse the drift-row list shape; only the file ref needs its own style. */
  .ev-file { font-size: 12px; color: var(--fg-dim); }
  .analysis-reasoning { font-size: 13px; color: var(--fg-dim); white-space: pre-wrap; line-height: 1.6; }
  .analysis-inline-reason { font-size: 13px; color: var(--fg-dim); line-height: 1.55; }
  /* Tier3 accordion (real header bar + rotating chevron, replaces the tiny ▸) */
  .acc { border-top: 1px solid var(--border); }
  .spec-card-body > .acc:first-of-type { margin-top: 8px; }
  .acc > summary { list-style: none; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 4px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--fg-dim); border-radius: var(--radius-sm); }
  .acc > summary::-webkit-details-marker { display: none; }
  .acc > summary:hover { background: var(--surface-2); color: var(--fg); }
  .acc > summary .chev { width: 16px; height: 16px; color: var(--muted); transition: transform 0.15s; flex: none; }
  .acc[open] > summary .chev { transform: rotate(90deg); }
  .acc > summary .count { color: var(--muted); font-weight: 400; }
  .acc-body { padding: 4px 4px 14px; }
  .evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 6px; }
  .evidence-item { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); }
  .evidence-item img { display: block; width: 100%; height: 120px; object-fit: cover; background: var(--surface-3); }
  .evidence-item .cap { padding: 6px 8px; font-size: 11px; color: var(--muted); }
  .evidence-item .cap .status { font-weight: 600; }
  .evidence-item .cap .status.failed { color: var(--fail); }
  /* run artifacts (external runCommand targets): image grid + file rows */
  .artifact-row { display: flex; align-items: center; gap: 10px; padding: 7px 4px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
  .artifact-row:last-child { border-bottom: none; }
  .artifact-kind { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1px 6px; }
  .artifact-name { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
  .artifact-size { color: var(--muted-2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .artifact-open { font-size: 12px; white-space: nowrap; color: var(--fg-dim); text-decoration: underline; }
  .artifact-open:hover { color: var(--fg); }
  .artifact-acc > summary { height: 34px; }
  .artifact-pre { margin: 2px 0 8px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); font-family: var(--mono); font-size: 11.5px; line-height: 1.5; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .section-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 4px; }
  /* live run steps: stacked cards with large before/after frames */
  .step-card { border: 1px solid var(--border); border-left: 3px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); padding: 12px 14px; margin-top: 10px; }
  .step-card.passed { border-left-color: var(--border-strong); }
  .step-card.failed { border-left-color: var(--fail); border-left-width: 4px; background: var(--fail-bg); }
  .step-card.skipped { border-left-color: var(--muted-2); }
  .step-head { display: flex; align-items: center; gap: 9px; }
  .step-head .idx { font-family: var(--mono); font-size: 11px; color: var(--muted-2); flex: none; }
  .step-head .instr { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; }
  .step-head .cost { color: var(--muted-2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .step-meta { font-size: 12px; margin-top: 6px; }
  .step-meta .expected { color: var(--fg-dim); }
  .step-meta .expected b { color: var(--muted-2); font-weight: 600; }
  .step-meta .reasoning { color: var(--muted); margin-top: 4px; line-height: 1.55; }
  .step-frames { display: flex; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
  .frame { display: flex; flex-direction: column; gap: 4px; }
  .frame .flabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted-2); font-weight: 600; }
  .frame img { width: 176px; height: 116px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-3); }
  .assertion-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 12.5px; }
  .assertion-row .name { flex: 1; }
  .assertion-row .dur { color: var(--muted-2); font-size: 11px; font-variant-numeric: tabular-nums; }
  .assertions-hint { font-size: 11.5px; padding: 2px 0 6px; }
  .drift-row { padding: 8px 0; font-size: 12.5px; color: var(--fg-dim); border-bottom: 1px solid var(--border); }
  .drift-row:last-child { border-bottom: none; }
  .drift-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .drift-msg { margin-top: 4px; color: var(--fg-dim); }
  .drift-clean { color: var(--pass); font-size: 13px; }

  /* triage grading — an explicit question + a segmented single-select, framed
     as an action ("tell us the real cause"), not a data readout. */
  /* Embedded at the bottom of the diagnosis card: a divider separates the
     human's grading zone from the model's output above it, without breaking
     the two out of the shared context. */
  .grade { margin-top: 2px; padding: 12px 0 0; border-top: 1px solid var(--border); }
  .grade-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .grade-q { font-size: 13px; font-weight: 600; color: var(--fg); }
  .grade-bottom { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .grade-seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-md); overflow: hidden; background: var(--surface); }
  .grade-seg .seg { height: 34px; padding: 0 14px; border: 0; background: transparent; color: var(--muted); font-size: 13px; font-weight: 500; border-right: 1px solid var(--border); display: inline-flex; align-items: center; gap: 5px; }
  .grade-seg .seg:last-child { border-right: 0; }
  .grade-seg .seg:hover { background: var(--surface-2); color: var(--fg); }
  .grade-seg .seg[aria-pressed="true"] { font-weight: 600; }
  .grade-seg .seg[aria-pressed="true"].TEST_DRIFT  { color: var(--info); background: var(--info-bg); }
  .grade-seg .seg[aria-pressed="true"].SPEC_CHANGE { color: var(--amber); background: var(--amber-bg); }
  .grade-seg .seg[aria-pressed="true"].PRODUCT_BUG { color: var(--fail); background: var(--fail-bg); }
  .grade-seg .seg[aria-pressed="true"].ENVIRONMENT { color: var(--violet); background: var(--violet-bg); }
  .grade-seg .seg[disabled] { opacity: 0.6; pointer-events: none; }
  .grade-status { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); border-style: dashed; }
  .grade-status.saved-match { color: var(--pass); background: var(--pass-bg); border-color: var(--pass-border); border-style: solid; }
  .grade-status.saved-corrected { color: var(--amber); background: var(--amber-bg); border-color: var(--amber-border); border-style: solid; }
  /* Dashed (not solid, unlike saved-corrected) — this isn't a settled answer,
     it's a grade whose cause this row's kind rejects, needing a regrade. */
  .grade-status.saved-invalid { color: var(--amber); background: var(--amber-bg); border-color: var(--amber-border); border-style: dashed; }
  .grade-status.saving { color: var(--muted); border-style: solid; }
  .grade-status.err { color: var(--fail); background: var(--fail-bg); border-color: var(--fail-border); border-style: solid; }

  .matrix-wrap { padding: 18px 20px; overflow-x: auto; }
  .matrix-target-filter { margin-bottom: 14px; }
  .matrix-table { border-collapse: collapse; font-size: 12.5px; }
  .matrix-table th, .matrix-table td { border: 1px solid var(--border); padding: 9px 16px; text-align: center; font-variant-numeric: tabular-nums; }
  .matrix-table thead th { background: var(--surface-2); color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  /* The two axis captions carry the meaning of the table, so they read as
     labels rather than as another column heading. */
  .matrix-table th.matrix-corner, .matrix-table th.matrix-axis { color: var(--fg-dim); font-size: 11px; letter-spacing: 0; text-transform: none; }
  .matrix-table th.matrix-corner { text-align: left; vertical-align: bottom; }
  .matrix-table tbody th { background: var(--surface-2); color: var(--fg-dim); font-weight: 600; font-size: 11px; text-align: left; white-space: nowrap; }
  /* The list tables let their card draw the bottom edge, so the shared rule
     strips the last row's border. This one draws a real grid and needs it. */
  .matrix-table tbody tr:last-child td { border-bottom: 1px solid var(--border); }
  .matrix-table td { color: var(--muted); }
  .matrix-table td.nz { color: var(--fg); font-weight: 600; }
  .matrix-table td.diag { background: var(--pass-bg); color: var(--pass); font-weight: 700; }
  .matrix-accuracy { margin-top: 14px; font-size: 13px; color: var(--fg-dim); }
  .matrix-accuracy b { color: var(--fg); font-size: 15px; }
  .triage-head { display: flex; align-items: baseline; gap: 10px; margin: 24px 0 10px; }
  .triage-summary { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .triage-summary b { color: var(--fg); font-weight: 600; }

  /* secrets */
  .scope-note { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; color: var(--muted); font-size: 12.5px; }
  .scope-note .lock { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
  .scope-note svg { width: 14px; height: 14px; }
  .scope-note b { color: var(--fg); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--border); }
  .panel-head h3 { font-size: 14px; display: flex; align-items: center; gap: 9px; }
  .panel-head h3 svg { color: var(--muted); }
  .panel-head .count { font-size: 11.5px; color: var(--muted); font-weight: 600; background: var(--surface-3); border-radius: 999px; padding: 1px 8px; }
  .keyname { font-family: var(--mono); font-size: 12.5px; font-weight: 600; }
  .val { font-family: var(--mono); font-size: 12.5px; color: var(--muted); }
  .lock-tag { display: inline-flex; align-items: center; gap: 5px; color: var(--muted-2); font-size: 11.5px; }
  .del:hover { color: var(--fail); }

  /* full-screen login gate */
  .login { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px; background: radial-gradient(1200px 600px at 50% -10%, var(--surface-2), var(--bg)); }
  .login-card { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 26px 24px; display: flex; flex-direction: column; }
  .login-brand { display: flex; align-items: center; gap: 10px; }
  .login-brand .glyph { width: 30px; height: 30px; border-radius: 8px; background: var(--accent); display: grid; place-items: center; color: var(--accent-fg); font-weight: 700; font-size: 16px; }
  .login-brand .wm { font-weight: 600; font-size: 16px; letter-spacing: -0.02em; }
  .login-title { font-size: 19px; margin: 18px 0 4px; }
  .login-sub { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
  .login-label { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
  .login-connect { justify-content: center; height: 38px; margin-top: 14px; }
  .login-error { color: var(--fail); font-size: 12.5px; margin: 12px 0 0; }
  .login-note { margin-top: 18px; }

  /* centered modal dialog (shares #scrim with the side sheet) */
  .dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 50; width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); display: flex; flex-direction: column; }
  .dialog-head { padding: 18px 20px 12px; border-bottom: 1px solid var(--border); }
  .dialog-head h2 { font-size: 16px; }
  .dialog-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
  .dialog-error { color: var(--fail); font-size: 12.5px; margin: 0; }
  .dialog-hint { color: var(--muted); font-size: 12px; margin: 0; }
  .dialog-foot { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }

  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 40; }
  /* click-to-zoom lightbox for evidence / before-after screenshots */
  .evidence-item img, .frame img { cursor: zoom-in; }
  .lightbox { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 32px; background: rgba(0,0,0,0.8); cursor: zoom-out; }
  .lightbox img { max-width: 96vw; max-height: 92vh; border-radius: var(--radius-sm); box-shadow: var(--shadow); background: var(--surface); }
  .sheet { position: fixed; top: 0; right: 0; height: 100vh; width: 424px; z-index: 50; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow); display: flex; flex-direction: column; }
  .sheet-head { padding: 20px 22px 16px; border-bottom: 1px solid var(--border); }
  .sheet-head h2 { font-size: 17px; }
  .sheet-head p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
  .sheet-head .scope { margin-top: 10px; }
  .sheet-body { padding: 20px 22px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .sheet-foot { margin-top: auto; padding: 16px 22px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }
  .form-row { display: flex; flex-direction: column; gap: 6px; }
  .form-row label { font-size: 12.5px; font-weight: 600; }
  .input, .textarea { border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 9px 11px; font: inherit; font-size: 13.5px; color: var(--fg); background: var(--surface-2); outline: none; width: 100%; }
  .input:focus, .textarea:focus { border-color: var(--border-strong); box-shadow: 0 0 0 3px var(--ring); }
  .textarea { font-family: var(--mono); font-size: 12px; resize: vertical; min-height: 120px; }
  .switch-row { display: flex; align-items: center; justify-content: space-between; padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
  .switch-row .t { font-size: 13px; font-weight: 500; }
  .switch-row .d { font-size: 12px; color: var(--muted); }
  .toggle { width: 38px; height: 22px; border-radius: 999px; background: var(--surface-3); position: relative; border: 1px solid var(--border-strong); flex: none; }
  .toggle i { position: absolute; top: 1px; left: 1px; width: 18px; height: 18px; border-radius: 50%; background: var(--muted); transition: left 0.12s, background 0.12s; }
  .toggle[aria-pressed="true"] { background: var(--accent); border-color: transparent; }
  .toggle[aria-pressed="true"] i { left: 18px; background: var(--accent-fg); }
  .note { display: flex; gap: 9px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: 12.5px; line-height: 1.5; }
  .note.warn { background: var(--amber-bg); border: 1px solid var(--amber-border); color: var(--amber); }
  .note.info { background: var(--surface-2); border: 1px solid var(--border); color: var(--fg); }
  .note svg { width: 15px; height: 15px; flex: none; margin-top: 1px; }

  /* session-create help: numbered steps + a copyable command line */
  .help-steps { margin: 3px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .help-steps > li { display: flex; gap: 8px; }
  .help-steps .step-n { flex: none; width: 17px; height: 17px; border-radius: 50%; background: var(--accent); color: var(--accent-fg); font-size: 10.5px; font-weight: 600; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
  .help-steps .step-b { min-width: 0; }
  .cmd { display: flex; align-items: center; gap: 6px; margin-top: 5px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 4px 4px 9px; }
  .cmd code { flex: 1; font-family: var(--mono); font-size: 12px; white-space: nowrap; overflow-x: auto; }
  .cmd .copy { flex: none; display: inline-flex; align-items: center; gap: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--muted); font-size: 11px; padding: 3px 7px; cursor: pointer; }
  .cmd .copy:hover { color: var(--fg); border-color: var(--muted); }
  .cmd .copy svg { width: 12px; height: 12px; }
  .path { font-family: var(--mono); font-size: 11.5px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }

  /* prompts */
  /* 3 stacked cards (record / live / triage). Cards with 2 slots lay them out
     side by side; a card with a single slot spans full width. */
  .prompt-card { margin-bottom: 14px; }
  .prompt-card .panel-head { padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .prompt-grid { display: grid; grid-template-columns: 1fr 1fr; }
  .prompt-grid:has(.prompt-cell:only-child) { grid-template-columns: 1fr; }
  .prompt-cell { background: var(--surface); padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
  .prompt-cell + .prompt-cell { border-left: 1px solid var(--border); }
  .prompt-cell .ph { display: flex; align-items: center; gap: 8px; }
  .prompt-cell .ph .nm { font-size: 13.5px; font-weight: 600; }
  .prompt-cell .ph .spacer { flex: 1; }
  .prompt-cell .hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
  /* info icon with a hover/focus tooltip explaining when to use a prompt */
  .info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: var(--muted); cursor: help; flex: none; }
  .info:hover, .info:focus-visible { color: var(--fg); }
  .info svg { width: 15px; height: 15px; }
  .info .tip { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; width: 240px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow); font-size: 12px; line-height: 1.5; color: var(--fg-dim); font-weight: 400; text-align: left; white-space: normal; opacity: 0; pointer-events: none; transition: opacity 0.12s; }
  .info:hover .tip, .info:focus-visible .tip { opacity: 1; }
  .prompt-ta { width: 100%; min-height: 150px; resize: vertical; font-family: var(--mono); font-size: 12px; line-height: 1.5;
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 9px 11px; color: var(--fg); background: var(--surface-2); outline: none; }
  .prompt-ta:focus { border-color: var(--border-strong); box-shadow: 0 0 0 3px var(--ring); }
  .prompt-ta[readonly] { background: var(--surface); color: var(--muted); cursor: default; }
  .prompt-actions { display: flex; gap: 8px; }
  .agent-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--amber); background: var(--amber-bg); border: 1px solid var(--amber-border); border-radius: 999px; padding: 1px 8px; }
  .ro-tag { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--muted-2); background: var(--surface-3); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; margin-left: 4px; }

  .learn-cta { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 var(--radius-md) var(--radius-md); }
  .learn-cta-text { flex: 1; min-width: 0; }
  .learn-cta-text .t { font-size: 13.5px; font-weight: 600; color: var(--fg); }
  .learn-cta-text .d { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .learn-cta-actions { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }

  .job-status { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; border: 1px solid transparent; text-transform: capitalize; }
  .job-status.queued, .job-status.running { background: var(--surface-3); color: var(--accent-2); border-color: var(--border-strong); }
  .job-status.succeeded { background: var(--pass-bg); color: var(--pass); border-color: var(--pass-border); }
  .job-status.failed { background: var(--fail-bg); color: var(--fail); border-color: var(--fail-border); }
  .job-detail-head { display: flex; align-items: baseline; gap: 12px; margin: 22px 0 12px; }
  .job-detail-head h3 { font-size: 14px; }
  .job-error { padding: 12px 14px; border: 1px solid var(--fail-border); border-radius: var(--radius-sm); background: var(--fail-bg); color: var(--fail); font-size: 13px; }
  .prompt-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .prompt-diff .col .h { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted-2); font-weight: 600; margin-bottom: 6px; }
  .prompt-diff pre { margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2);
    font-family: var(--mono); font-size: 11px; line-height: 1.5; color: var(--fg-dim); white-space: pre-wrap; word-break: break-word; max-height: 480px; overflow-y: auto; }

  /* perspectives — summary row, filter toolbar, and the one-table-per-project
     view (feature section rows + expandable case detail rows). Reuses the
     existing badge/chip primitives above, so no new tokens are needed.

     The summary row answers the question this tab exists for — which cases
     need attention — as one inventory line plus one bar per axis: verdict,
     execution, audit, the same three groupings the table's columns show. The
     mode and recorded-ness counts moved onto the filter chips, which is
     where a count says something actionable. */
  .ov { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 16px; }
  .ov-inv { font-size: 13px; color: var(--muted); }
  .ov-inv b { color: var(--fg); font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
  /* One row per overview axis (verdict, execution, audit): a short label —
     reusing that axis's own column header text — above its own bar+legend. */
  .ov-axis { display: flex; flex-direction: column; gap: 4px; }
  .ov-axis-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted-2); }
  .rrbar { height: 8px; border-radius: 999px; overflow: hidden; display: flex; background: var(--surface-3); }
  .rrleg { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; color: var(--muted); }
  .rrleg span { display: inline-flex; align-items: center; gap: 6px; }
  .rrleg i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .rrleg b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  /* One class per state, worn by both the bar segment and its legend dot.
     The execution and audit axes share these colours with the verdict axis
     rather than inventing two more palettes — same reasoning as the badge
     classes below. Careful writing in here: a star followed by a slash
     closes the comment early and silently eats the next rule, and a
     backtick ends the template literal this CSS lives in. */
  .sg-rerunneeded, .sg-exec-stale { background: var(--amber-fill); }
  .sg-needsrepair, .sg-audit-drifted, .sg-exec-failed { background: var(--fail); }
  .sg-audit-undecided { background: var(--info); }
  .sg-verified, .sg-audit-clean, .sg-exec-passed { background: var(--pass); }
  .sg-inprogress, .sg-audit-due, .sg-exec-never { background: var(--muted-2); }

  .search { flex: 1; min-width: 200px; max-width: 340px; display: flex; align-items: center; gap: 7px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 0 10px; height: 32px; background: var(--surface); }
  .search svg { width: 15px; height: 15px; flex: none; color: var(--muted-2); }
  .search input { border: none; outline: none; font: inherit; font-size: 13px; width: 100%; background: transparent; color: var(--fg); }
  /* A labelled cluster of chips (mode, verdict) rather than one flat row —
     the label says what question the chips beside it answer. */
  .fgroup { display: inline-flex; align-items: center; gap: 6px; }
  .fgroup-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted-2); margin-right: 2px; }
  .fchip { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; color: var(--muted); }
  .fchip[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .fchip .fcount { margin-left: 6px; font-variant-numeric: tabular-nums; color: var(--muted-2); }
  .fchip[aria-pressed="true"] .fcount { color: var(--accent-fg); opacity: 0.7; }
  /* A filter control that picks one value out of many (the runs bar's date box
     and selects), sized to itself — .input is the full-width form field the
     sheets use, which in a toolbar row swallows the whole line. */
  .fctl { height: 32px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; font-size: 13px; }
  /* Native chrome (the date picker's glyph, the select's arrow) takes its
     colours from the color-scheme property, not from any class of ours. */
  .dark .fctl { color-scheme: dark; }

  .chip.live { background: var(--info-bg); color: var(--info); border-color: var(--info-border); }
  .badge.ok { background: var(--pass-bg); color: var(--pass); border-color: var(--pass-border); }
  .badge.ok .d { background: var(--pass); }
  .badge.norec { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .badge.norec .d { background: var(--amber); }

  /* Shared by the verdict and audit columns (ADR-0010, ADR-0014): rr-unknown
     must never be mistaken for a clean rr-none, so it takes the info hue
     rather than a dimmed grey, and every badge is paired with a .cellsub
     saying what it rests on. */
  .badge.rr-needed { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .badge.rr-needed .d { background: var(--amber); }
  .badge.rr-repair { background: var(--fail-bg); color: var(--fail); border-color: var(--fail-border); }
  .badge.rr-repair .d { background: var(--fail); }
  .badge.rr-unknown { background: var(--info-bg); color: var(--info); border-color: var(--info-border); }
  .badge.rr-unknown .d { background: var(--info); }
  .badge.rr-none { background: var(--surface-3); color: var(--muted); border-color: var(--border); }
  .badge.rr-none .d { background: var(--muted); }
  .cellsub { display: block; margin-top: 3px; max-width: 260px; color: var(--muted); font-size: 11.5px; line-height: 1.45; }
  .graded-mark { color: var(--fg-dim); font-weight: 600; }
  .cellsub a { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--border-strong); }
  .cellsub a:hover { color: var(--fg); }
  .persp-note { margin-bottom: 12px; }
  .persp-head { font-size: 12px; white-space: nowrap; }
  /* The Perspectives toolbar carries search + two filter-chip groups + the
     profile selector, so it wraps instead of overflowing on a narrow window. */
  #view-perspectives .toolbar { flex-wrap: wrap; }
  .proj-menu.right { left: auto; right: 0; }
  .d-note { margin-top: 12px; max-width: 900px; }

  .tblcard { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  /* Badges across a case row must land on one line. Some of these cells carry
     only a badge, others a badge plus a sub-line (sha · when) or a two-line
     explanation, so middle-aligning the cells put each badge at a different
     height. Top-aligning them fixes where the first line starts; a 24px first
     line in the cell and a 24px badge box, both centred, fix where the text
     inside it sits — so a badge's Y offset no longer depends on what follows
     it. Sub-lines re-declare their own tighter leading. */
  #persp-tbody td { vertical-align: top; }
  #persp-tbody tr.row > td { line-height: 24px; }
  #persp-tbody tr.row > td .chip, #persp-tbody tr.row > td .badge { vertical-align: top; min-height: 24px; line-height: 18px; }
  /* Feature section rows must read as headings, not as just another data row —
     larger, darker, extra padding, and a strong top rule marking the break. */
  tr.grp td { background: var(--surface-2); border-top: 2px solid var(--border-strong); border-bottom: 1px solid var(--border); padding: 12px 12px 10px; font-family: var(--mono); font-size: 15px; font-weight: 700; color: var(--fg); }
  tr.grp td .gcount { color: var(--muted); font-weight: 500; font-size: 12px; font-family: var(--font); margin-left: 10px; }
  td.c-title { font-weight: 500; max-width: 460px; }
  td.c-title .csum { display: block; font-weight: 400; color: var(--muted); font-size: 12.5px; line-height: 1.45; margin-top: 1px; }
  td.c-chev { width: 28px; color: var(--muted-2); text-align: right; }
  .chev-i { display: inline-block; transition: transform 0.15s; font-size: 11px; }
  tr.row[aria-expanded="true"] .chev-i { transform: rotate(90deg); }
  tr.detail { display: none; }
  tr.detail.open { display: table-row; }
  /* The panel is the row continuing, not a card under it: same surface, and no
     rule between a case and its own panel. The rule below the panel stays —
     that one separates this case from the next. The hover tint is dropped
     while open for the same reason; tinting only the top half would split the
     two apart again. */
  tr.detail > td { background: var(--surface); padding: 2px 16px 18px; }
  #persp-tbody tr.row[aria-expanded="true"] > td { border-bottom: 0; }
  #persp-tbody tr.row[aria-expanded="true"]:hover { background: var(--surface); }

  .d-grid { display: grid; grid-template-columns: 156px 1fr; gap: 9px 14px; font-size: 13px; max-width: 900px; }
  .d-grid dt { color: var(--muted); font-size: 12px; padding-top: 1px; }
  .d-grid dd { color: var(--fg-dim); }
  .d-grid dd ul { list-style: none; display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; }
  .d-grid dd li::before { content: "\\2022 "; color: var(--muted-2); }
  .d-grid code { font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  /* Prose gets a measure so it stops wrapping mid-phrase in a narrow column;
     paths wrap as whole chips, never inside a path. */
  .d-prose { max-width: 62ch; line-height: 1.5; }
  .d-paths { display: flex; flex-wrap: wrap; gap: 6px; }
  .d-paths code { white-space: nowrap; }
  .d-prose + .d-paths { margin-top: 6px; }
  .notebox { margin-top: 14px; max-width: 900px; }
  .notebox .nlabel { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .notebox textarea { width: 100%; min-height: 54px; resize: vertical; font: inherit; font-size: 13px; color: var(--fg-dim); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 8px 10px; }
  .notebox .nact { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
  .notebox .nstatus { font-size: 12px; color: var(--muted); }
  .notebox .nstatus.ok { color: var(--pass); }
  .notebox .nstatus.err { color: var(--fail); }

  @media (max-width: 900px) { .app { grid-template-columns: 1fr; } .sidebar { display: none; } .logo .wm { display: none; } .split { grid-template-columns: 1fr; } .rd-head .meta { margin-left: 0; } }
  @media (max-width: 700px) { .prompt-grid { grid-template-columns: 1fr; } .prompt-diff { grid-template-columns: 1fr; } }
`;

// ─────────────────────────────────────────────────────────────────────────
// Vanilla JS, no build step: fetch()-only against /api/v1. Runs are immutable
// once pushed, so there is nothing to poll. The URL hash routes between views
// (#/runs/<id> deep-links a run — the URL `ccqa hub push` prints — and
// #/secrets opens the secrets manager). RUN_CAUSES / DRIFT_CAUSES / RUN_LABELS
// / DRIFT_LABELS come from report/schema.ts's causesForKind / predictedForKind
// (and PREDICTED_LABELS, the full wire union) and are injected below so the
// browser doesn't need to re-derive them from anywhere.
//
// Blocks, in order: token/auth gate, fetch/dom helpers, view routing,
// projects list, runs list, run detail (spec cards + evidence images),
// triage (grading + confusion matrix), secrets tab, add sheet
// (variable/session), project switching/menu, new-project dialog, wiring.
// ─────────────────────────────────────────────────────────────────────────
const CLIENT_JS = `
(function () {
  // The four per-kind sets a person is shown, sourced from report/schema.ts's
  // causesForKind / predictedForKind so a label can never be added there and
  // missed here. RUN_LABELS / DRIFT_LABELS are confusion-matrix ROWS (what
  // ccqa predicted — UNKNOWN included, since the model can say it); RUN_CAUSES
  // / DRIFT_CAUSES are its COLUMNS (what a human may record as the ground
  // truth — UNKNOWN is never offered as a grade).
  var RUN_CAUSES = ${JSON.stringify(causesForKind("run"))};
  var DRIFT_CAUSES = ${JSON.stringify(causesForKind("drift"))};
  var RUN_LABELS = ${JSON.stringify(predictedForKind("run"))};
  var DRIFT_LABELS = ${JSON.stringify(predictedForKind("drift"))};
  // The full wire union (every predicted label, either side, plus UNKNOWN) —
  // used only where a label must be recognised independent of which side
  // produced it (labelChip's "known" check). Never shown to a person as a
  // set; use the per-kind sets above for that.
  var PREDICTED_LABELS = ${JSON.stringify(PREDICTED_LABELS)};
  var AGENT_BROWSER_TARGET = ${JSON.stringify(AGENT_BROWSER_TARGET)};
  var GUIDANCE_KINDS = ${JSON.stringify(GUIDANCE_KINDS)};
  // Every status a run can be in, from the contract that defines them, so the
  // runs filter offers exactly what a row's badge can say.
  var RUN_STATUSES = ${JSON.stringify(RunStatusSchema.options)};
  var state = { token: "", project: "", profile: "default", detailRunId: "", jobPollToken: 0, runsLoadToken: 0, spendLoadToken: 0 };
  var knownProfiles = [];
  var TOKEN_KEY = "ccqa-hub-token";
  var LANG_KEY = "ccqa-hub-lang";
  var THEME_KEY = "ccqa-hub-theme";
  var PROJECT_KEY = "ccqa-hub-project";
  var PROFILES_KEY = "ccqa-hub-profiles";

  // ── i18n ──────────────────────────────────────────────────────────────
  // Chrome + labels only. Model output (headline/recommendation/reasoning) is
  // already localized server-side by the analysis prompt, so it is never
  // translated here. Internal label VALUES (TEST_DRIFT, ...) stay English;
  // only their display text is localized via FAILURE_LABEL_JA.
  var I18N = {
    en: {
      "nav.projects": "Projects", "nav.runs": "Runs", "nav.perspectives": "Perspectives", "nav.secrets": "Secrets",
      "nav.prompts": "Prompts", "nav.learning": "Learning",
      "app.project": "project", "app.profile": "profile", "app.disconnect": "Disconnect", "app.noProject": "no project",
      "app.newProfile": "New profile",
      "login.title": "Connect to your hub", "login.sub": "Enter your bearer token to continue.",
      "login.token": "Token", "login.connect": "Connect",
      "login.note": "The token is stored only in this browser; secret values never are. Use the hub only behind TLS on a trusted network.",
      "projects.title": "Projects", "projects.new": "New project",
      "runs.title": "Runs", "runs.empty": "Select a project to see its runs.",
      "runs.none": "No runs yet for this project.", "projects.none": "No projects yet. Create one to get started.", "projects.noneShort": "No projects yet",
      "runs.noMatch": "No runs match this filter.",
      "runs.col.run": "Run", "runs.col.status": "Status",
      "runs.col.cost": "Cost", "runs.col.created": "Created",
      "runs.totalCost": "Cost of these {n}:", "runs.capped": "showing the first {n}",
      "runs.spend24h": "All spend, last 24h:",
      "runs.filter.date": "Date", "runs.filter.kind": "Kind", "runs.filter.status": "Status",
      "runs.filter.all": "All",
      "detail.back": "Runs", "detail.specs": "Specs",
      "detail.download": "Download artifacts",
      "detail.triage": "Triage",
      "detail.notKept": "This run is no longer kept — the hub keeps only the most recent runs of each branch.",
      "meta.branch": "Branch", "meta.specs": "Specs", "meta.cost": "Cost",
      "meta.created": "Created", "meta.passed": "passed", "meta.profile": "Profile",
      "meta.drift": "Drift",
      "diag.cause": "Cause", "diag.fix": "Fix",
      "diag.surface": "Surface", "diag.surface.spec": "spec", "diag.surface.generated": "generated code",
      "diag.specChangeKind.FEATURE_REMOVED": "feature gone", "diag.specChangeKind.BEHAVIOUR_CHANGED": "behaviour changed",
      "acc.reasoning": "Reasoning", "acc.evidence": "Evidence", "acc.steps": "Live run steps",
      "acc.assertions": "Assertions",
      "acc.artifacts": "Artifacts",
      "art.open": "Open", "art.loadFailed": "could not load (it may have been omitted from the push)",
      "acc.assertions.hint": "Test cases from the recorded spec run",
      "spec.kind.live": "Live", "spec.kind.det": "Deterministic",
      "det.steps": "Steps",
      "det.noEvidence": "No step screenshots:",
      "kind.run": "Test run", "kind.drift": "Drift audit", "kind.record": "Recording",
      "drift.summary.ratio": "{found} of {total} specs",
      "drift.clean": "No drift issues",
      "status.passed": "passed", "status.failed": "failed", "status.skipped": "skipped", "status.running": "running",
      "drift.run.found": "drift found", "drift.run.clean": "no drift", "drift.run.unknown": "can't tell",
      "drift.spec.found": "drift", "drift.spec.clean": "no drift", "drift.spec.unknown": "can't tell",
      "grade.question.run": "What actually caused the failure?",
      "grade.question.drift": "Was the drift the audit reported real?",
      "grade.ungraded": "ungraded", "grade.matches": "saved · matches",
      "grade.corrected": "saved · corrected", "grade.saving": "saving…",
      "grade.error": "couldn't save — retry",
      "grade.invalidRegrade": "not a valid cause for this row — regrade",
      "matrix.empty": "No grades yet. Pick the real cause on a failed spec's diagnosis card below and it is tallied here.",
      "matrix.axis.predicted": "ccqa predicted", "matrix.axis.actual": "you graded it",
      "matrix.accuracy": "Accuracy",
      "matrix.accSuffix": "of graded cases match the prediction", "matrix.graded": "graded",
      "matrix.invalidExcluded": "{n} excluded, not a valid cause for their row",
      "matrix.target.all": "All targets",
      "learn.cta.title": "Learn from these grades",
      "learn.cta.desc": "Learn from what you graded so ccqa classifies failure causes the same way next time.",
      "learn.cta.run": "Learn",
      "secrets.title": "Secrets", "prompts.title": "Prompts", "learning.title": "Learning",
      "perspectives.title": "Perspectives",
      "perspectives.search": "Search cases…",
      "perspectives.filter.all": "All", "perspectives.filter.deterministic": "Deterministic",
      "perspectives.filter.live": "Live",
      "perspectives.filter.group.mode": "Mode",
      "perspectives.col.verdict": "Verdict", "perspectives.col.audit": "Audit",
      "perspectives.col.run": "Execution",
      "perspectives.audit.state.due": "Audit due",
      "perspectives.audit.state.clean": "Describes the code",
      "perspectives.audit.state.drifted": "Drifted",
      "perspectives.audit.state.undecided": "Couldn't tell",
      "perspectives.run.state.superseded": "pending",
      "perspectives.run.state.failed": "failed", "perspectives.run.state.passed": "passed",
      "perspectives.run.state.never": "never run",
      "perspectives.col.case": "Case", "perspectives.col.mode": "Mode",
      "perspectives.noHit": "No matching cases.",
      "perspectives.updated": "Last updated:",
      "perspectives.empty": "No perspectives yet. Run ccqa perspectives, or record a test — it's created automatically.",
      "perspectives.loadFailed": "Loading perspectives failed",
      "perspectives.mode.deterministic": "deterministic", "perspectives.mode.live": "live",
      "perspectives.ov.cases": "cases", "perspectives.ov.features": "features",
      "perspectives.d.preconditions": "Preconditions", "perspectives.d.startScreen": "Start screen",
      "perspectives.d.testCondition": "Condition", "perspectives.d.spec": "spec",
      "perspectives.note.label": "Note",
      "perspectives.note.placeholder": "Notes about this case…",
      "perspectives.note.saved": "Saved",
      "perspectives.note.error": "Could not save — retry",
      "perspectives.d.lastRed": "Most recent failure",
      "perspectives.d.changedSince": "Changes since the last run",
      "perspectives.d.whyVerdict": "Why this verdict",
      "perspectives.result.openRun": "Open this run in the hub",
      "perspectives.result.ci": "CI",
      "perspectives.rerun.state.needsRepair": "Needs repair",
      "perspectives.rerun.state.rerunNeeded": "Re-run needed",
      "perspectives.rerun.state.inProgress": "In progress",
      "perspectives.rerun.state.verified": "Verified",
      "perspectives.rerun.vsDeploy": "judged against deploy",
      "perspectives.rerun.noDeployHead": "no deploy recorded for this profile",
      "perspectives.rerun.changedByDeploy": "deploy {sha} changed files matched to this case",
      "perspectives.rerun.changesSome": "yes (as of deploy {sha})",
      "perspectives.rerun.changesNone": "none (as of deploy {sha})",
      "perspectives.rerun.touchedCount": "{n} deployed path(s) matched this case",
      "perspectives.rerun.touchedUnknown": "a deploy since the last run matched this case",
      "perspectives.rerun.inProgressHint": "an audit or a run is still going, or the audit has not caught up with the deploy",
      "perspectives.rerun.heldHint": "another job already holds this spec — acting on it now would race that job",
      "perspectives.rerun.repair.testDrift": "the generated test no longer matches the code — re-record it",
      "perspectives.rerun.repair.specChange": "the spec describes something the code no longer does — a human decides",
      "perspectives.rerun.repair.auditUndecided": "the audit read the code and could not decide — a human looks",
      "perspectives.rerun.repair.runFailed": "the last run failed — re-running it changes nothing until the cause is fixed",
      "perspectives.rerun.why.noSelectionInRange": "a deploy in range was recorded without a spec selection",
      "perspectives.rerun.why.selectionUnknown": "the selector could not tell whether this case was affected",
      "perspectives.rerun.why.noDeployLog": "no deploy log for this profile",
      "perspectives.rerun.why.unknownDeployedSha": "the last run's deployed commit is unknown",
      "perspectives.rerun.why.ambiguousDeployedSha": "a deploy landed while the last run was executing",
      "perspectives.rerun.why.deployedShaNotInLog": "the last run's commit predates the retained deploy log",
      "perspectives.rerun.why.gapInRange": "deploys are missing from the range",
      "perspectives.rerun.why.unrecognized": "this hub reported a reason this UI does not recognise",
      "perspectives.rerun.fix.noSelectionInRange": "A deploy in range was recorded without a spec selection, so nothing says whether it affected this case. Run ccqa select-specs in the deploy job and send its verdict with the deploy.",
      "perspectives.rerun.fix.selectionUnknown": "A deploy in range was judged, but the selector could not decide this case. Re-run it to get a clean baseline.",
      "perspectives.rerun.fix.noDeployLog": "Nothing has been recorded in this profile's deploy log. Wire ccqa hub deploy record into the deploy job for this environment so ccqa knows what shipped.",
      "perspectives.rerun.fix.unknownDeployedSha": "The last run did not record which commit the environment was running, so it cannot be positioned in the deploy log. Runs record it once this profile has a deploy log.",
      "perspectives.rerun.fix.ambiguousDeployedSha": "A deploy landed while the last run was executing, so which commit it exercised is not knowable. Re-run this case to get a clean baseline.",
      "perspectives.rerun.fix.deployedShaNotInLog": "The last run's deployed commit is older than the retained deploy log, so its position is lost. Re-run this case to re-anchor it.",
      "perspectives.rerun.fix.gapInRange": "A deploy in range did not chain onto its predecessor, so deploys are missing from the range. Have the deploy job report the commit it replaced.",
      "perspectives.rerun.fix.unrecognized": "This hub reported a reason this UI does not recognise. Upgrade the UI to see what it means.",
      "perspectives.rerun.unsupported": "This hub does not report which cases need a re-run. Upgrade the hub to enable it.",
      "perspectives.rerun.loadFailed": "Loading re-run data failed",
      "perspectives.rerun.noDeployLogBanner": "No deploy has been recorded for profile {profile}, so no case can be judged. Wire ccqa hub deploy record into the deploy job for this environment.",
      "perspectives.rerun.deployHead": "deploy head",
      "perspectives.drift.graded": "confirmed",
      "prompt.card.record": "Recording browser actions",
      "prompt.card.live": "Live run (AI-driven)",
      "prompt.card.playwright": "Playwright test generation",
      "prompt.card.runn": "runn runbook generation",
      "prompt.card.triage": "Why a test failed (ccqa run)",
      "prompt.card.audit": "Whether a spec still describes the code (ccqa audit)",
      "prompt.sub.user": "Your instructions", "prompt.sub.agent": "Learned by ccqa",
      "prompt.recordUser.hint": "Rules you write for how a test is recorded — what to click, what to ignore. Applied whenever you record a new test.",
      "prompt.recordAgent.hint": "Notes ccqa keeps for itself while recording, refined automatically as it runs. Read-only — ccqa regenerates it.",
      "prompt.liveUser.hint": "Rules you write for how the AI drives the browser to run a test on its own. Applied on every live run.",
      "prompt.liveAgent.hint": "Notes ccqa keeps for itself while running tests live, refined automatically as it runs. Read-only — ccqa regenerates it.",
      "prompt.playwrightUser.hint": "Rules you write for how a Playwright test is generated — which page objects/helpers to reuse, where tests live. Applied when a playwright-target spec is generated.",
      "prompt.playwrightAgent.hint": "Notes ccqa keeps for itself while generating Playwright tests, refined automatically. Read-only — ccqa regenerates it.",
      "prompt.runnUser.hint": "Rules you write for how a runn runbook is generated — endpoint conventions, shared runbooks to include. Applied when a runn-target spec is generated.",
      "prompt.runnAgent.hint": "Notes ccqa keeps for itself while generating runn runbooks, refined automatically. Read-only — ccqa regenerates it.",
      "prompt.triageUser.hint": "Rules you write for reading a run failure — e.g. which services count as an environment problem, or which errors are known product bugs, on this project. Applied on every failure analysis.",
      "prompt.triageAgent.hint": "Learned from your grades on run failures, so ccqa reads them the way you do. Read-only — a learning job creates it.",
      "prompt.auditUser.hint": "Rules you write for the audit — e.g. which parts of the source are the ones to check a spec against on this project. Applied on every audit.",
      "prompt.auditAgent.hint": "Reserved for calibration learned from your audit grades. No learning job writes this yet, so it stays empty — read-only either way.",
      "prompt.customPrompt.fallback": "Un-scoped (fallback)",
      "prompt.readonly": "read-only",
      "prompt.notSet": "Not set. Type guidance and Save to store it on the hub.",
      "prompt.notSetRo": "Not set yet — ccqa fills this in as it runs.",
      "common.refresh": "Refresh",
      "common.save": "Save", "common.cancel": "Cancel", "common.add": "Add", "common.create": "Create",
      "common.name": "Name", "common.value": "Value", "common.updated": "Updated", "common.delete": "delete",
      "common.copy": "Copy", "common.copied": "Copied",
      "session.help.title": "How to get this JSON",
      "session.help.step1": "Run this in your terminal and log in by hand when the browser opens:",
      "session.help.step2": "Open the saved file and paste its contents below:",
      "jobs.col.job": "Job", "jobs.col.status": "Status",
      "jobs.col.customPrompt": "Custom prompt", "jobs.col.created": "Created",
      "jobs.before": "Analysis prompt — before", "jobs.after": "Analysis prompt — after",
      "jobs.cases": "graded cases", "jobs.inProgress": "Learning in progress — this refreshes automatically.",
      "jobs.failed": "The learning job failed.", "jobs.newCustomPrompt": "New custom prompt:", "jobs.empty": "No learning jobs yet. Grade failing specs on a run, then Learn."
    },
    ja: {
      "nav.projects": "プロジェクト", "nav.runs": "実行", "nav.perspectives": "テスト観点", "nav.secrets": "シークレット",
      "nav.prompts": "プロンプト", "nav.learning": "学習",
      "app.project": "プロジェクト", "app.profile": "プロファイル", "app.disconnect": "切断", "app.noProject": "プロジェクト未選択",
      "app.newProfile": "新規プロファイル",
      "login.title": "ハブに接続", "login.sub": "続けるにはベアラートークンを入力してください。",
      "login.token": "トークン", "login.connect": "接続",
      "login.note": "トークンはこのブラウザにのみ保存され、シークレット値は保存されません。ハブは信頼できるネットワークのTLS配下でのみ利用してください。",
      "projects.title": "プロジェクト", "projects.new": "新規プロジェクト",
      "runs.title": "実行", "runs.empty": "プロジェクトを選択すると実行一覧が表示されます。",
      "runs.none": "このプロジェクトにはまだ実行がありません。", "projects.none": "まだプロジェクトがありません。作成して始めましょう。", "projects.noneShort": "プロジェクトなし",
      "runs.noMatch": "条件に一致する実行はありません。",
      "runs.col.run": "実行", "runs.col.status": "ステータス",
      "runs.col.cost": "コスト", "runs.col.created": "作成",
      "runs.totalCost": "この {n} 件のコスト:", "runs.capped": "先頭 {n} 件のみ表示",
      "runs.spend24h": "直近 24 時間の全支出:",
      "runs.filter.date": "日付", "runs.filter.kind": "種類", "runs.filter.status": "結果",
      "runs.filter.all": "すべて",
      "detail.back": "実行", "detail.specs": "スペック",
      "detail.download": "アーティファクトをダウンロード",
      "detail.triage": "トリアージ",
      "detail.notKept": "この実行はもう保持されていません — ハブは各ブランチの直近の実行だけを保持します。",
      "meta.branch": "ブランチ", "meta.specs": "スペック", "meta.cost": "コスト",
      "meta.created": "作成", "meta.passed": "合格", "meta.profile": "プロファイル",
      "meta.drift": "ドリフト",
      "diag.cause": "原因", "diag.fix": "対処",
      "diag.surface": "対象", "diag.surface.spec": "spec", "diag.surface.generated": "生成コード",
      "diag.specChangeKind.FEATURE_REMOVED": "機能が無い", "diag.specChangeKind.BEHAVIOUR_CHANGED": "振る舞いが変わった",
      "acc.reasoning": "推論", "acc.evidence": "根拠", "acc.steps": "実行ステップ",
      "acc.assertions": "アサーション",
      "acc.artifacts": "成果物",
      "art.open": "開く", "art.loadFailed": "読み込めませんでした（push時に省略された可能性があります）",
      "acc.assertions.hint": "記録したスペック実行のテストケース",
      "spec.kind.live": "ライブ", "spec.kind.det": "決定的",
      "det.steps": "ステップ",
      "det.noEvidence": "ステップのスクリーンショットなし:",
      "kind.run": "テスト実行", "kind.drift": "ドリフト監査", "kind.record": "収録",
      "drift.summary.ratio": "{found} / {total} スペック",
      "drift.clean": "ドリフトの問題なし",
      "status.passed": "合格", "status.failed": "失敗", "status.skipped": "スキップ", "status.running": "実行中",
      "drift.run.found": "ズレあり", "drift.run.clean": "ズレなし", "drift.run.unknown": "判定できない",
      "drift.spec.found": "ズレあり", "drift.spec.clean": "ズレなし", "drift.spec.unknown": "判定できない",
      "grade.question.run": "実際の原因は何でしたか？",
      "grade.question.drift": "監査が報告したズレは実在しましたか？",
      "grade.ungraded": "未評価", "grade.matches": "保存済み · 一致",
      "grade.corrected": "保存済み · 修正", "grade.saving": "保存中…",
      "grade.error": "保存に失敗 — 再試行",
      "grade.invalidRegrade": "この行の種別には無効な原因です — 再採点してください",
      "matrix.empty": "まだ採点がありません。下の失敗スペックの診断カードで実際の原因を選ぶと、ここに集計されます。",
      "matrix.axis.predicted": "ccqa の予測", "matrix.axis.actual": "人の採点",
      "matrix.accuracy": "正解率",
      "matrix.accSuffix": "件の採点が予測と一致", "matrix.graded": "採点済み",
      "matrix.invalidExcluded": "{n}件は行の種別に無効な原因のため除外",
      "matrix.target.all": "すべてのターゲット",
      "learn.cta.title": "この採点から学習",
      "learn.cta.desc": "採点した内容をもとに、ccqaが次回から同じように失敗の原因を分類できるよう学習します。",
      "learn.cta.run": "学習",
      "secrets.title": "シークレット", "prompts.title": "プロンプト", "learning.title": "学習",
      "perspectives.title": "テスト観点",
      "perspectives.search": "ケースを検索…",
      "perspectives.filter.all": "すべて", "perspectives.filter.deterministic": "決定的",
      "perspectives.filter.live": "ライブ",
      "perspectives.filter.group.mode": "モード",
      "perspectives.col.verdict": "判定", "perspectives.col.audit": "監査",
      "perspectives.col.run": "実行",
      "perspectives.audit.state.due": "監査待ち",
      "perspectives.audit.state.clean": "ズレなし",
      "perspectives.audit.state.drifted": "ズレあり",
      "perspectives.audit.state.undecided": "判定不能",
      "perspectives.run.state.superseded": "実行待ち",
      "perspectives.run.state.failed": "失敗", "perspectives.run.state.passed": "合格",
      "perspectives.run.state.never": "未実行",
      "perspectives.col.case": "ケース", "perspectives.col.mode": "モード",
      "perspectives.noHit": "該当するケースがありません。",
      "perspectives.updated": "最終更新:",
      "perspectives.empty": "まだテスト観点がありません。ccqa perspectives を実行するか、recordすると自動作成されます。",
      "perspectives.loadFailed": "テスト観点の読み込みに失敗しました",
      "perspectives.mode.deterministic": "決定的", "perspectives.mode.live": "ライブ",
      "perspectives.ov.cases": "ケース", "perspectives.ov.features": "機能",
      "perspectives.d.preconditions": "前提条件", "perspectives.d.startScreen": "開始画面",
      "perspectives.d.testCondition": "実行条件", "perspectives.d.spec": "spec",
      "perspectives.note.label": "note",
      "perspectives.note.placeholder": "このケースについてのメモ…",
      "perspectives.note.saved": "保存しました",
      "perspectives.note.error": "保存に失敗しました — 再試行してください",
      "perspectives.d.lastRed": "直近の失敗",
      "perspectives.d.changedSince": "前回実行以降の変更",
      "perspectives.d.whyVerdict": "この判定の理由",
      "perspectives.result.openRun": "ハブでこの実行を開く",
      "perspectives.result.ci": "CI",
      "perspectives.rerun.state.needsRepair": "修正待ち",
      "perspectives.rerun.state.rerunNeeded": "要再実行",
      "perspectives.rerun.state.inProgress": "進行中",
      "perspectives.rerun.state.verified": "検証済み",
      "perspectives.rerun.vsDeploy": "判定基準: デプロイ",
      "perspectives.rerun.noDeployHead": "このプロファイルにはデプロイの記録がありません",
      "perspectives.rerun.changedByDeploy": "デプロイ {sha} がこのケースに一致するファイルを変更",
      "perspectives.rerun.changesSome": "あり（デプロイ {sha} 時点）",
      "perspectives.rerun.changesNone": "なし（デプロイ {sha} 時点）",
      "perspectives.rerun.touchedCount": "このケースに一致したデプロイ差分 {n} 件",
      "perspectives.rerun.touchedUnknown": "前回実行以降のデプロイがこのケースに一致する変更を行っています",
      "perspectives.rerun.inProgressHint": "監査か実行がまだ走っているか、監査がデプロイに追いついていません",
      "perspectives.rerun.heldHint": "このスペックは既に別のジョブが保持しています。今操作するとそのジョブと競合します",
      "perspectives.rerun.repair.testDrift": "生成されたテストが古くなっています。録り直してください",
      "perspectives.rerun.repair.specChange": "spec がコードのやめた動作を書いています。人が判断します",
      "perspectives.rerun.repair.auditUndecided": "監査がコードを読んだうえで判定できませんでした。人が見ます",
      "perspectives.rerun.repair.runFailed": "最後の実行が落ちています。原因を直すまで再実行しても変わりません",
      "perspectives.rerun.why.noSelectionInRange": "対象範囲に判定を伴わないデプロイがあります",
      "perspectives.rerun.why.selectionUnknown": "影響の有無を判定できませんでした",
      "perspectives.rerun.why.noDeployLog": "このプロファイルのデプロイ記録がありません",
      "perspectives.rerun.why.unknownDeployedSha": "前回実行時にデプロイされていたcommitが不明です",
      "perspectives.rerun.why.ambiguousDeployedSha": "前回実行の途中でデプロイが発生しました",
      "perspectives.rerun.why.deployedShaNotInLog": "前回実行のcommitが保持中のデプロイログより古いです",
      "perspectives.rerun.why.gapInRange": "対象範囲のデプロイ記録が欠けています",
      "perspectives.rerun.why.unrecognized": "このUIが認識できない理由がハブから返されました",
      "perspectives.rerun.fix.noSelectionInRange": "対象範囲に判定を伴わないデプロイがあり、このケースに影響したかどうかを示すものがありません。デプロイジョブで ccqa select-specs を実行し、判定をデプロイと一緒に送ってください。",
      "perspectives.rerun.fix.selectionUnknown": "対象範囲のデプロイは判定されましたが、このケースについては判断がつきませんでした。再実行して基準を取り直してください。",
      "perspectives.rerun.fix.noDeployLog": "このプロファイルのデプロイログに記録がありません。何がデプロイされたかをccqaに伝えるため、この環境のデプロイジョブに ccqa hub deploy record を組み込んでください。",
      "perspectives.rerun.fix.unknownDeployedSha": "前回実行は環境で動いていたcommitを記録していないため、デプロイログ上の位置を決められません。このプロファイルにデプロイログができれば、以降の実行では記録されます。",
      "perspectives.rerun.fix.ambiguousDeployedSha": "前回実行の途中でデプロイが発生したため、どのcommitを検証したのか確定できません。基準を取り直すには再実行してください。",
      "perspectives.rerun.fix.deployedShaNotInLog": "前回実行のデプロイcommitが保持中のデプロイログより古く、位置を特定できません。再実行して基準を取り直してください。",
      "perspectives.rerun.fix.gapInRange": "対象範囲のデプロイが直前のデプロイと連結しておらず、記録が欠けています。デプロイジョブから置き換え前のcommitも送ってください。",
      "perspectives.rerun.fix.unrecognized": "このUIが認識できない理由がハブから返されました。内容を表示するにはUIを更新してください。",
      "perspectives.rerun.unsupported": "このハブは再実行の要否を返しません。利用するにはハブを更新してください。",
      "perspectives.rerun.loadFailed": "再実行の要否の読み込みに失敗しました",
      "perspectives.rerun.noDeployLogBanner": "プロファイル {profile} にデプロイの記録がないため、どのケースも判定できません。この環境のデプロイジョブに ccqa hub deploy record を組み込んでください。",
      "perspectives.rerun.deployHead": "最新デプロイ",
      "perspectives.drift.graded": "人が確認",
      "prompt.card.record": "ブラウザ操作の記録",
      "prompt.card.live": "ライブ実行（AI操作）",
      "prompt.card.playwright": "Playwrightテスト生成",
      "prompt.card.runn": "runnランブック生成",
      "prompt.card.triage": "テストが落ちた理由（ccqa run）",
      "prompt.card.audit": "spec がまだコードを説明できているか（ccqa audit）",
      "prompt.sub.user": "あなたの指示", "prompt.sub.agent": "ccqaの学習",
      "prompt.recordUser.hint": "テストを記録するときのルールを自分で書きます（何をクリックするか、何を無視するか）。新しいテストを記録するたびに適用されます。",
      "prompt.recordAgent.hint": "記録中にccqaが自分用に書き留め、実行のたびに自動で洗練していくメモです。読み取り専用 — ccqaが再生成します。",
      "prompt.liveUser.hint": "AIがその場でブラウザを操作してテストを実行するときのルールを自分で書きます。ライブ実行のたびに適用されます。",
      "prompt.liveAgent.hint": "ライブ実行中にccqaが自分用に書き留め、実行のたびに自動で洗練していくメモです。読み取り専用 — ccqaが再生成します。",
      "prompt.playwrightUser.hint": "Playwrightテストを生成するときのルールを自分で書きます（再利用するページオブジェクト/ヘルパー、テストの置き場所）。playwrightターゲットの生成時に適用されます。",
      "prompt.playwrightAgent.hint": "Playwrightテスト生成中にccqaが自分用に書き留め、自動で洗練していくメモです。読み取り専用 — ccqaが再生成します。",
      "prompt.runnUser.hint": "runnランブックを生成するときのルールを自分で書きます（エンドポイントの規約、includeする共有ランブック）。runnターゲットの生成時に適用されます。",
      "prompt.runnAgent.hint": "runnランブック生成中にccqaが自分用に書き留め、自動で洗練していくメモです。読み取り専用 — ccqaが再生成します。",
      "prompt.triageUser.hint": "実行の失敗をどう読むかのルールを自分で書きます（例: このプロジェクトでどのサービスを環境の問題として扱うか、どのエラーを既知のプロダクトバグとして扱うか）。失敗分析のたびに適用されます。",
      "prompt.triageAgent.hint": "実行の失敗に対するあなたの採点から学習し、ccqaが同じように読めるようにします。読み取り専用 — 学習ジョブが生成します。",
      "prompt.auditUser.hint": "監査のルールを自分で書きます（例: このプロジェクトで spec を突き合わせるべきソースの範囲）。監査のたびに適用されます。",
      "prompt.auditAgent.hint": "監査の採点から学習する校正用に予約されています。現時点ではこれを生成する学習ジョブが無いため常に空です — いずれにせよ読み取り専用です。",
      "prompt.customPrompt.fallback": "共通（フォールバック）",
      "prompt.readonly": "読み取り専用",
      "prompt.notSet": "未設定。指示を入力して保存するとハブに保存されます。",
      "prompt.notSetRo": "未設定 — ccqaが実行しながら自動で書き込みます。",
      "common.refresh": "更新",
      "common.save": "保存", "common.cancel": "キャンセル", "common.add": "追加", "common.create": "作成",
      "common.name": "名前", "common.value": "値", "common.updated": "更新", "common.delete": "削除",
      "common.copy": "コピー", "common.copied": "コピーしました",
      "session.help.title": "このJSONの入手方法",
      "session.help.step1": "ターミナルで次を実行し、ブラウザが開いたら手動でログインします:",
      "session.help.step2": "保存されたファイルを開き、その中身を下に貼り付けます:",
      "jobs.col.job": "ジョブ", "jobs.col.status": "ステータス",
      "jobs.col.customPrompt": "カスタムプロンプト", "jobs.col.created": "作成",
      "jobs.before": "分析プロンプト — 学習前", "jobs.after": "分析プロンプト — 学習後",
      "jobs.cases": "件の採点", "jobs.inProgress": "学習中 — 自動的に更新されます。",
      "jobs.failed": "学習ジョブが失敗しました。", "jobs.newCustomPrompt": "新しいカスタムプロンプト:", "jobs.empty": "まだ学習ジョブがありません。実行の失敗スペックを採点してから学習してください。"
    }
  };
  var FAILURE_LABEL_JA = { TEST_DRIFT: "テストずれ", SPEC_CHANGE: "仕様変更", PRODUCT_BUG: "プロダクト不具合", ENVIRONMENT: "環境の問題", UNKNOWN: "不明", NO_DRIFT: "ズレなし" };

  function loadLang() {
    try { return window.localStorage.getItem(LANG_KEY) || "en"; } catch (e) { return "en"; }
  }
  var lang = loadLang();
  function t(key) {
    var d = I18N[lang] || I18N.en;
    if (d[key] != null) return d[key];
    return I18N.en[key] != null ? I18N.en[key] : key;
  }
  function labelText(v) { return lang === "ja" ? (FAILURE_LABEL_JA[v] || v) : v; }

  // Overwrite static HTML_BODY text nodes marked with data-i18n / data-i18n-ph.
  // The English text in the markup is the no-JS fallback; this runs on boot and
  // on every language change.
  function applyStaticI18n() {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) { nodes[i].textContent = t(nodes[i].getAttribute("data-i18n")); }
    var phs = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phs.length; j++) { phs[j].placeholder = t(phs[j].getAttribute("data-i18n-ph")); }
    // The runs filters' options are built rather than marked up, so they are
    // not reached by the two loops above.
    syncRunsFilters();
    document.documentElement.lang = lang;
  }

  function setLang(next) {
    lang = next;
    try { window.localStorage.setItem(LANG_KEY, next); } catch (e) { /* non-fatal */ }
    applyStaticI18n();
    syncLangToggle();
    setProject(state.project); // refresh the "no project" label if shown
    route(); // re-render dynamic DOM in the new language
  }
  function syncLangToggle() {
    var en = document.getElementById("lang-en");
    var ja = document.getElementById("lang-ja");
    if (en) en.setAttribute("aria-pressed", String(lang === "en"));
    if (ja) ja.setAttribute("aria-pressed", String(lang === "ja"));
  }

  // ── theme (light default, .dark on <html>) ────────────────────────────
  function loadTheme() {
    try { return window.localStorage.getItem(THEME_KEY) || "light"; } catch (e) { return "light"; }
  }
  var theme = loadTheme();
  function applyTheme() {
    document.documentElement.classList.toggle("dark", theme === "dark");
    var btn = document.getElementById("theme-toggle");
    if (btn) btn.setAttribute("aria-pressed", String(theme === "dark"));
  }
  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    try { window.localStorage.setItem(THEME_KEY, theme); } catch (e) { /* non-fatal */ }
    applyTheme();
  }

  // localStorage can throw (private mode, disabled storage) — never let that
  // break boot. Only the bearer token is ever persisted; secret VALUES are not.
  function loadStoredToken() {
    try { return window.localStorage.getItem(TOKEN_KEY) || ""; }
    catch (e) { return ""; }
  }
  function storeToken(tok) {
    // A failure here isn't fatal (this session still works from memory), but
    // it means no auto-reconnect next load — leave a trace so that's debuggable
    // rather than a silent "why am I asked for the token every time?".
    try { window.localStorage.setItem(TOKEN_KEY, tok); }
    catch (e) { console.warn("ccqa hub: token not persisted (storage unavailable):", e); }
  }
  function clearStoredToken() {
    // If this throws, "Disconnect" cleared the in-memory token but left it in
    // storage — surface that, since the token unexpectedly surviving is a
    // security-relevant mismatch with what the user asked for.
    try { window.localStorage.removeItem(TOKEN_KEY); }
    catch (e) { console.warn("ccqa hub: could not clear stored token:", e); }
  }

  // Same non-fatal-storage discipline as the token helpers above, for the
  // last-used project and per-project profile so switching tabs/reloading
  // doesn't silently drop back to "default".
  function loadStoredProject() {
    try { return window.localStorage.getItem(PROJECT_KEY) || ""; }
    catch (e) { return ""; }
  }
  function storeProject(p) {
    try {
      if (p) window.localStorage.setItem(PROJECT_KEY, p);
      else window.localStorage.removeItem(PROJECT_KEY);
    } catch (e) { console.warn("ccqa hub: project not persisted (storage unavailable):", e); }
  }
  function clearStoredProject() {
    try { window.localStorage.removeItem(PROJECT_KEY); }
    catch (e) { console.warn("ccqa hub: could not clear stored project:", e); }
  }
  function loadProfileMap() {
    try {
      var raw = window.localStorage.getItem(PROFILES_KEY);
      var o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
    } catch (e) {
      return {};
    }
  }
  function storeProfileForProject(project, profile) {
    if (!project) return;
    try {
      var map = loadProfileMap();
      map[project] = profile || "default";
      window.localStorage.setItem(PROFILES_KEY, JSON.stringify(map));
    } catch (e) { console.warn("ccqa hub: profile not persisted (storage unavailable):", e); }
  }
  function storedProfileForProject(project) {
    return loadProfileMap()[project] || "";
  }
  function clearStoredProfiles() {
    try { window.localStorage.removeItem(PROFILES_KEY); }
    catch (e) { console.warn("ccqa hub: could not clear stored profiles:", e); }
  }

  // Toggle between the full-screen login gate (disconnected) and the app
  // (connected). Also shows the appbar "Disconnect" only while connected.
  function showAuthGate(connected) {
    document.getElementById("login").hidden = connected;
    document.getElementById("app").hidden = !connected;
    document.getElementById("disconnect").hidden = !connected;
    if (!connected) { closeProjectMenu(); closeProfileMenu(); }
  }

  // Show an error inside the login card (used by connect()'s failure path).
  function setLoginError(msg) {
    var e = document.getElementById("login-error");
    e.hidden = !msg;
    e.textContent = msg || "";
  }

  // ── fetch / dom helpers ───────────────────────────────────────────────

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + state.token }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (!res.ok) {
        // A reverse proxy can answer with non-JSON (an HTML 502 page) — fall
        // back to the status line instead of a JSON-parse error message.
        return res.json().catch(function () { return null; }).then(function (b) {
          var err = new Error((b && b.error && b.error.message) || (res.status + " " + res.statusText));
          err.status = res.status;
          throw err;
        });
      }
      return res.status === 204 ? null : res.json();
    }, function (err) {
      // fetch() itself rejected — the response never arrived (offline, DNS/TLS
      // failure, connection refused, CORS block). Browsers word this
      // differently ("Failed to fetch"/"Load failed"/…), so translate it to one
      // clear message instead of leaking a browser-specific string.
      throw new Error("Network unreachable — check the hub URL and your connection");
    });
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function relTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso).getTime();
    if (isNaN(d)) return iso;
    var diffSec = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (diffSec < 60) return diffSec + "s ago";
    var m = Math.round(diffSec / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    var days = Math.round(h / 24);
    return days + "d ago";
  }

  function shortSha(sha) {
    return sha ? String(sha).slice(0, 7) : "";
  }

  // The class stays the raw status (the CSS keys off it); only the text is
  // localized. An unrecognised status from a newer hub prints verbatim rather
  // than falling back to a wording that would claim something about it.
  function statusBadge(status) {
    var span = el("span", "badge " + status);
    span.appendChild(el("span", "d"));
    span.appendChild(document.createTextNode(" " + (I18N.en["status." + status] ? t("status." + status) : status)));
    return span;
  }

  function ciBadge(run) {
    if (!run.ciRunId) return el("span", "ci-badge local", "local run");
    var text = "Actions #" + run.ciRunId;
    // A link to the GitHub Actions run when the URL was recorded; same chip
    // style otherwise (plain text).
    if (run.runUrl) {
      var a = el("a", "ci-badge", text);
      a.href = run.runUrl;
      a.target = "_blank";
      a.rel = "noopener";
      // The runs-list row is itself clickable (opens the run); opening the CI
      // link must not also navigate the row.
      a.addEventListener("click", function (e) { e.stopPropagation(); });
      return a;
    }
    return el("span", "ci-badge", text);
  }

  function labelChip(label) {
    var known = PREDICTED_LABELS.indexOf(label) !== -1;
    // class carries the English value (for color); text shows the localized name.
    return el("span", "lbl " + (known ? label : "none"), labelText(label));
  }

  // A drift-kind run executes nothing, so its "failed"/"passed" status means
  // "an audit found the spec is stale" / "the spec still matches the code" —
  // not a test outcome. Same badge shape as statusBadge, drift's own words
  // and colour (amber, not fail-red: a diagnosis, not something broken),
  // reusing the dr-found/dr-clean classes the perspectives drift column
  // already defines. i18nPrefix picks the wording size: the run-level badge
  // names what drift found ("drift.run."); the per-spec badge is terser
  // ("drift.spec.") since the diagnosis card below it says the rest.
  // A row's status answers the threshold question — "would this fail a build" —
  // which UNKNOWN deliberately answers "no" to, since an audit that could not
  // tell must not break CI on its own. So status alone cannot label the badge:
  // it would print "no drift" over a diagnosis that says the opposite. The
  // state comes from the diagnosis where there is one, and status is only the
  // fallback for a row or a hub that carries none.
  var DRIFT_FOUND_CLASS = { found: "dr-found", unknown: "dr-unknown", clean: "dr-clean" };

  function driftFoundBadge(state, i18nPrefix) {
    var span = el("span", "badge " + (DRIFT_FOUND_CLASS[state] || "dr-clean"));
    span.appendChild(el("span", "d"));
    span.appendChild(document.createTextNode(" " + t(i18nPrefix + state)));
    return span;
  }


  // Shared by the runs-list row and the run-detail header — the one place
  // both decide whether a run's own status badge speaks drift's vocabulary.
  function runStatusBadge(run) {
    return answersDrift(run) ? driftFoundBadge(driftRunState(run), "drift.run.") : statusBadge(run.status);
  }

  // Which command left the run, and whether its spec counts are a tally of
  // what was verified. A recording's rows are the specs it wrote, not specs it
  // checked, so "1 / 1 passed" would claim a test result. A kind from a newer
  // hub keeps the generic label but is read the same cautious way, since
  // nothing here knows what its counts mean.
  var KINDS = {
    run: { label: "kind.run", verifies: true },
    drift: { label: "kind.drift", verifies: true },
    record: { label: "kind.record", verifies: false },
  };
  function kindOf(kind) { return KINDS[kind] || { label: "kind.run", verifies: false }; }
  function kindChip(kind) {
    return el("span", "chip kind-chip", t(kindOf(kind).label));
  }

  // A run's Claude spend, in the same $x.xxxx form as the per-step badge.
  // A run that billed nothing, and one stored before costs were recorded, both
  // arrive as a non-number — printing $0.0000 would claim a measured zero.
  function costText(usd) { return typeof usd === "number" ? "$" + usd.toFixed(4) : "—"; }

  // One chip per non-zero drift label, worded via labelText — the same
  // vocabulary the diagnosis card uses — so a run's summary never disagrees
  // with its own spec cards. A zero-count label is omitted, same reasoning as
  // rerunSegments below: a "0" chip next to a real count reads as a finding.
  // DRIFT_LABELS / DRIFT_CAUSES / RUN_CAUSES are declared above, sourced from
  // causesForKind / predictedForKind. The two sides overlap but are not equal:
  // an audit opens no browser (no PRODUCT_BUG/ENVIRONMENT) and NO_DRIFT is not
  // an answer about a run. Offering one side's label in the other's control
  // would let a grade land in a cell that does not exist.
  function causeLabels(isDrift) { return isDrift ? DRIFT_CAUSES : RUN_CAUSES; }
  var DRIFT_LABEL_COUNT_KEY = { TEST_DRIFT: "testDrift", SPEC_CHANGE: "specChange", UNKNOWN: "unknown" };
  // A run stored by an older hub carries the previous drift summary shape
  // (issue/severity counts). The read path returns runs as stored, so the
  // label counts this build wants are simply absent — render nothing rather
  // than "0 / undefined specs", which reads as a real audit that found none.
  // --- pure: drift row/run state -------------------------------------------
  // Self-contained (no DOM, no closures) so drift-overview.test.ts can lift it
  // out and run it. It decides what a drift badge says, and the one mistake
  // available here — reading a row's build-threshold status instead of its
  // diagnosis, which prints "no drift" over an UNKNOWN finding — is invisible
  // without either a browser or this test.
  // A grade is a human answering the same question the audit answered, later
  // and with more to go on, so wherever both exist the grade is what a reader
  // is shown. The audit's own answer is never overwritten — it stays on the
  // run and in the confusion matrix, which is the whole point of measuring.
  function driftSummary(run) {
    var d = (run && run.gradedDrift) || (run && run.drift);
    return d && typeof d.specs === "number" ? d : null;
  }

  /**
   * One spec row's drift state. The graded argument is the human's answer for
   * this row, if it has one; NO_DRIFT means the audit reported drift and there
   * was none.
   */
  function driftRowState(r, graded) {
    if (graded) return graded === "NO_DRIFT" ? "clean" : "found";
    if (r.analysis && r.analysis.label) return r.analysis.label === "UNKNOWN" ? "unknown" : "found";
    return r.status === "failed" ? "found" : "clean";
  }

  /**
   * Whether a run's badge should say what the audit found, rather than how the
   * run itself is going. Only once it is over: an audit still streaming its
   * rows has no summary yet, and reading that absence as "no drift" claims the
   * one answer nobody has earned.
   */
  function answersDrift(run) {
    return run.kind === "drift" && run.status !== "running";
  }

  /** A whole drift run's state. Label counts beat status for the same reason. */
  function driftRunState(run) {
    var d = driftSummary(run);
    if (!d) return run.status === "failed" ? "found" : "clean";
    if (d.testDrift + d.specChange > 0) return "found";
    return d.unknown > 0 ? "unknown" : "clean";
  }
  // --- end pure: drift row/run state ---------------------------------------

  function driftChips(drift) {
    var chips = [];
    DRIFT_LABELS.forEach(function (label) {
      var count = drift[DRIFT_LABEL_COUNT_KEY[label]];
      if (count > 0) chips.push(el("span", "chip drift-count-chip", labelText(label) + " " + count));
    });
    return chips;
  }

  // Inline icons can't go through el() (SVG needs its own namespace), so they're
  // built with createElementNS. svgIcon() returns a fresh <svg> carrying the
  // stroke defaults every icon here shares; each builder adds its own paths.
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    return svg;
  }
  function svgPath(d) {
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    return path;
  }

  // A "+" icon matching the inline SVGs in the static markup.
  function svgPlus() {
    var svg = svgIcon();
    svg.appendChild(svgPath("M12 5v14M5 12h14"));
    return svg;
  }

  function svgCircle(cx, cy, r) {
    var c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx);
    c.setAttribute("cy", cy);
    c.setAttribute("r", r);
    return c;
  }

  /** A fork in a line — the conventional git-branch glyph. */
  function svgBranch() {
    var svg = svgIcon();
    svg.appendChild(svgPath("M6 3v12"));
    svg.appendChild(svgCircle("18", "6", "3"));
    svg.appendChild(svgCircle("6", "18", "3"));
    svg.appendChild(svgPath("M18 9a9 9 0 0 1-9 9"));
    return svg;
  }

  /** Stacked racks — a profile names a deployed environment, not a code path. */
  function svgProfile() {
    var svg = svgIcon();
    svg.appendChild(svgPath("M4 4h16v6H4zM4 14h16v6H4z"));
    svg.appendChild(svgPath("M8 7h.01M8 17h.01"));
    return svg;
  }

  /**
   * A chip whose glyph says which field it is. Two of these sit side by side on
   * every run, so without one they read as two unlabelled words. The title is
   * the fallback for anyone the glyph does not reach.
   */
  function iconChip(icon, text, label) {
    var chip = el("span", "chip icon-chip");
    chip.title = label;
    chip.appendChild(icon);
    chip.appendChild(document.createTextNode(text));
    return chip;
  }

  // Round caps so the "i"/"!" dot (a zero-length segment) actually paints as a
  // filled dot instead of vanishing under a butt cap at small sizes.
  function svgRounded() {
    var svg = svgIcon();
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    return svg;
  }

  // The two note glyphs, matching the inline SVGs the static .note markup uses.
  function svgInfo() {
    var svg = svgRounded();
    var c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "10");
    svg.appendChild(c);
    svg.appendChild(svgPath("M12 16v-4M12 8h.01"));
    return svg;
  }
  function svgWarn() {
    var svg = svgRounded();
    svg.appendChild(svgPath("M12 9v4M12 17h.01"));
    svg.appendChild(svgPath("M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"));
    return svg;
  }

  // Fill an element as a .note box (the static ones live in HTML_BODY). kind is
  // "info" or "warn"; the text is always textContent, never innerHTML.
  function fillNote(box, kind, text, extraClass) {
    clear(box);
    box.className = "note " + kind + (extraClass ? " " + extraClass : "");
    box.appendChild(kind === "warn" ? svgWarn() : svgInfo());
    box.appendChild(el("span", null, text));
    return box;
  }

  // ── view routing ────────────────────────────────────────────────────

  var VIEWS = ["projects", "runs", "detail", "perspectives", "secrets", "prompts", "jobs"];
  var NAV_FOR_VIEW = { projects: ".nav-projects", secrets: ".nav-secrets", prompts: ".nav-prompts", runs: ".nav-runs", detail: ".nav-runs", jobs: ".nav-jobs", perspectives: ".nav-perspectives" };
  function showView(id) {
    // Any in-flight job poll belongs to the view we're leaving — bump the token
    // so its next tick is a no-op (see pollJob).
    state.jobPollToken++;
    VIEWS.forEach(function (v) {
      document.getElementById("view-" + v).hidden = v !== id;
    });
    document.querySelectorAll(".nav a").forEach(function (a) { a.classList.remove("active"); });
    var navEl = document.querySelector(NAV_FOR_VIEW[id] || ".nav-runs");
    if (navEl) navEl.classList.add("active");
    document.querySelector(".main").scrollTop = 0;
  }

  // Gray out Runs/Secrets/Prompts until a project is chosen; Projects is always live.
  function updateNavGate() {
    var gated = !state.project;
    document.querySelector(".nav-runs").classList.toggle("disabled", gated);
    document.querySelector(".nav-perspectives").classList.toggle("disabled", gated);
    document.querySelector(".nav-secrets").classList.toggle("disabled", gated);
    document.querySelector(".nav-prompts").classList.toggle("disabled", gated);
    document.querySelector(".nav-jobs").classList.toggle("disabled", gated);
  }

  function route() {
    // Disconnected: the full-screen login gate is the only thing to show.
    if (!state.token) { showAuthGate(false); return; }
    showAuthGate(true);
    // With no project chosen yet, the Projects picker is the only useful view —
    // land there (e.g. right after login) instead of an empty Runs list, and
    // gate any deep-linked #/runs or #/secrets to it too.
    if (location.hash === "#/projects" || !state.project) { openProjects(); return; }
    var m = location.hash.match(/^#\\/runs\\/(.+)$/);
    if (m) { openRunDetail(decodeURIComponent(m[1])); return; }
    if (location.hash === "#/perspectives") { openPerspectives(); return; }
    if (location.hash === "#/secrets") { openSecrets(); return; }
    if (location.hash === "#/prompts") { openPrompts(); return; }
    var j = location.hash.match(/^#\\/jobs\\/(.+)$/);
    if (j) { openJobDetail(decodeURIComponent(j[1])); return; }
    if (location.hash === "#/jobs") { openJobs(); return; }
    showView("runs");
    loadRuns();
  }

  // ── projects list ─────────────────────────────────────────────────────

  function projGlyph(name) {
    return (name && name[0]) ? name[0] : "?";
  }

  function renderProjectsList(projects) {
    var grid = document.getElementById("projects-grid");
    clear(grid);
    var status = document.getElementById("projects-status");
    status.hidden = true;

    projects.forEach(function (p) {
      var card = el("button", "proj-card" + (p === state.project ? " current" : ""));
      card.type = "button";
      card.appendChild(el("div", "pglyph", projGlyph(p)));
      card.appendChild(el("div", "pname", p));
      if (p === state.project) card.appendChild(el("span", "pcur", "current"));
      card.addEventListener("click", function () { chooseProject(p); });
      grid.appendChild(card);
    });

    // Always offer creation — even on an empty hub, so the first project/secret
    // can be scoped somewhere.
    var add = el("button", "proj-card new");
    add.type = "button";
    add.appendChild(svgPlus());
    add.appendChild(document.createTextNode(t("projects.new")));
    add.addEventListener("click", openProjectDialog);
    grid.appendChild(add);

    if (projects.length === 0) {
      status.hidden = false;
      status.textContent = t("projects.none");
    }
  }

  function openProjects() {
    showView("projects");
    var status = document.getElementById("projects-status");
    status.hidden = true;
    apiFetch("/api/v1/projects")
      .then(function (data) { knownProjects = projectsFrom(data); renderProjectsList(knownProjects); })
      .catch(function (err) {
        clear(document.getElementById("projects-grid"));
        status.hidden = false;
        status.textContent = "Error loading projects: " + err.message;
      });
  }

  // ── runs list ────────────────────────────────────────────────────────

  var RUNS_LIMIT = 50;
  // Outlives every render, so a refresh or a language switch comes back to the
  // list the operator was looking at.
  var runsFilter = { date: "", kind: "", status: "" };
  function runsFilterActive() { return !!(runsFilter.date || runsFilter.kind || runsFilter.status); }

  function runsQuery() {
    var q = "/api/v1/runs?project=" + encodeURIComponent(state.project) + "&limit=" + RUNS_LIMIT;
    if (runsFilter.kind) q += "&kind=" + encodeURIComponent(runsFilter.kind);
    if (runsFilter.status) q += "&status=" + encodeURIComponent(runsFilter.status);
    if (runsFilter.date) {
      // The picked day becomes [local midnight, next local midnight). The API
      // takes instants and carries no timezone, so the day has to be resolved
      // here — against the clock of whoever picked it.
      var p = runsFilter.date.split("-");
      var start = new Date(+p[0], +p[1] - 1, +p[2]);
      var next = new Date(+p[0], +p[1] - 1, +p[2] + 1);
      q += "&since=" + encodeURIComponent(start.toISOString()) + "&until=" + encodeURIComponent(next.toISOString());
    }
    return q;
  }

  // Both selects take their values from the tables that label the rows, so a
  // filter cannot name a kind or a status differently from the run it hides.
  // Called on boot and on a language switch — the only times the labels move.
  function syncRunsFilters() {
    document.getElementById("runs-f-date").value = runsFilter.date;
    fillRunsFilter("runs-f-kind", Object.keys(KINDS), function (k) { return t(kindOf(k).label); }, runsFilter.kind);
    fillRunsFilter("runs-f-status", RUN_STATUSES, function (s) { return t("status." + s); }, runsFilter.status);
  }

  function fillRunsFilter(id, values, labelOf, selected) {
    var sel = document.getElementById(id);
    clear(sel);
    var any = el("option", null, t("runs.filter.all"));
    any.value = "";   // the empty value is what the query omits
    sel.appendChild(any);
    values.forEach(function (v) {
      var opt = el("option", null, labelOf(v));
      opt.value = v;
      sel.appendChild(opt);
    });
    sel.value = selected;
  }

  // What the listed runs cost together — the accumulating number an operator
  // reads to decide how often CI should run, so it follows whatever filter
  // produced the list. Hidden when no listed run carries a cost at all, since
  // a "$0.0000" total would read as "CI is free" rather than "nothing measured".
  //
  // The label names the run count on purpose. The list is capped (RUNS_LIMIT),
  // so an unqualified "total" would quietly under-report a project's spend the
  // moment it has more runs than that — the one number this feature exists to
  // get right.
  function renderRunsTotalCost(runs) {
    var span = document.getElementById("runs-total-cost");
    // null until the first measured run, which is what distinguishes "nothing
    // was measured" from "the measured total happens to be zero".
    var total = null;
    // The runs that actually contributed, not the runs on screen. Runs stored
    // before costs were recorded carry nothing, so counting the list would
    // credit the sum to rows that gave it nothing — the exact misreading the
    // count is here to prevent.
    var measured = 0;
    runs.forEach(function (r) {
      if (typeof r.costUsd === "number") { total = (total || 0) + r.costUsd; measured++; }
    });
    span.hidden = total === null;
    if (total !== null) {
      span.textContent = t("runs.totalCost").replace("{n}", measured) + " " + costText(total);
    }
  }

  // The project's whole spend over the last 24 hours — deliberately not the
  // list's window or filter: the two numbers differ by everything that calls
  // Claude without leaving a run behind, which is why both are here. Hidden
  // when nothing was reported, since "$0.0000" would claim a free day.
  function loadRunsSpend() {
    var span = document.getElementById("runs-spend-24h");
    span.hidden = true;
    var token = ++state.spendLoadToken;
    var since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    apiFetch("/api/v1/projects/" + encodeURIComponent(state.project) + "/spend?since=" + encodeURIComponent(since))
      .then(function (data) {
        if (token !== state.spendLoadToken) return;
        if (!data.entries.length) return;
        span.hidden = false;
        span.textContent = t("runs.spend24h") + " " + costText(data.totalUsd);
      })
      .catch(function () { /* the runs list is the page; a missing total must not replace it with an error */ });
  }

  function renderRunsList(runs) {
    var tbody = document.getElementById("runs-tbody");
    clear(tbody);
    renderRunsTotalCost(runs);
    // A full page is almost certainly a truncated one, and under a date filter
    // that turns the total beside it into a day's spend that stops at the cap.
    var capped = document.getElementById("runs-capped");
    capped.hidden = runs.length < RUNS_LIMIT;
    capped.textContent = t("runs.capped").replace("{n}", RUNS_LIMIT);
    var empty = document.getElementById("runs-empty");
    if (runs.length === 0) {
      empty.hidden = false;
      empty.textContent = t(runsFilterActive() ? "runs.noMatch" : "runs.none");
      return;
    }
    empty.hidden = true;
    runs.forEach(function (r) {
      var tr = el("tr", "row");
      tr.addEventListener("click", function () { location.hash = "#/runs/" + encodeURIComponent(r.id); });

      // Four columns: which run, how it went, what it cost, when. Everything
      // else is one click away, and a column that has to mean something
      // different per kind (a spec tally that counts passes for a run and
      // findings for an audit) reads wrong before it reads useful.
      var runCell = document.createElement("td");
      runCell.appendChild(el("div", "runid", r.id.slice(0, 8)));
      var sub = el("div", "subline");
      sub.appendChild(ciBadge(r));
      sub.appendChild(kindChip(r.kind));
      sub.appendChild(iconChip(svgBranch(), r.branch || "—", t("meta.branch")));
      if (r.profile) sub.appendChild(iconChip(svgProfile(), r.profile, t("meta.profile")));
      if (r.kind === "drift") {
        var rowDrift = driftSummary(r);
        if (rowDrift) driftChips(rowDrift).forEach(function (chip) { sub.appendChild(chip); });
      }
      runCell.appendChild(sub);
      tr.appendChild(runCell);

      var statusCell = document.createElement("td");
      statusCell.appendChild(runStatusBadge(r));
      tr.appendChild(statusCell);

      tr.appendChild(el("td", "muted num", costText(r.costUsd)));
      tr.appendChild(el("td", "muted num", relTime(r.createdAt)));
      tbody.appendChild(tr);
    });
  }

  // Compared against the live token before painting, so a slower earlier
  // response cannot land last: holding an arrow key down in the date box fires
  // one request per day passed, and the table would end up on the wrong one.
  function loadRunsList() {
    var token = ++state.runsLoadToken;
    document.getElementById("runs-empty").hidden = true;
    apiFetch(runsQuery())
      .then(function (data) {
        if (token !== state.runsLoadToken) return;
        renderRunsList(data.runs);
      })
      .catch(function (err) {
        if (token !== state.runsLoadToken) return;
        renderRunsList([]);
        var empty = document.getElementById("runs-empty");
        empty.hidden = false;
        empty.textContent = "Error loading runs: " + err.message;
      });
  }

  // Entering the view or refreshing it. The spend readout is a fixed window,
  // so a filter change reloads the list alone.
  function loadRuns() {
    loadRunsSpend();
    loadRunsList();
  }

  // ── run detail: header ──────────────────────────────────────────────

  function renderRunHead(run) {
    var head = document.getElementById("rd-head");
    clear(head);

    var idblock = el("div", "idblock");
    // NB: not named "t" — that would shadow the global t() translator in this scope.
    var titleRow = el("div", "t");
    titleRow.appendChild(el("span", "runid", run.id.slice(0, 8)));
    titleRow.appendChild(runStatusBadge(run));
    idblock.appendChild(titleRow);
    var sub = el("div", "subline");
    sub.appendChild(ciBadge(run));
    // What kind of run this is, said once. The spec cards below used to repeat
    // it per row, which read as "this spec was drift-audited" — a property of
    // the run described as if it varied spec to spec. Same chip as the run list.
    sub.appendChild(kindChip(run.kind));
    idblock.appendChild(sub);
    head.appendChild(idblock);

    var meta = el("div", "meta");
    function metaItem(k, vNode) {
      var m = el("div", "m");
      m.appendChild(el("div", "k", k));
      var v = el("div", "v");
      if (typeof vNode === "string") v.textContent = vNode;
      else v.appendChild(vNode);
      m.appendChild(v);
      meta.appendChild(m);
    }
    var branchChip = el("span", "chip", run.branch || "—");
    metaItem(t("meta.branch"), branchChip);
    // Which environment the run executed against (recorded at push, display-only).
    if (run.profile) metaItem(t("meta.profile"), el("span", "chip", run.profile));
    var summary = driftSummary(run);
    if (run.kind === "drift" && summary) {
      // Drift runs have no live/deterministic spec pass count. One chip per
      // label found, plus how many of the audited specs that covers.
      var driftFound = summary.testDrift + summary.specChange + summary.unknown;
      if (driftFound === 0) {
        metaItem(t("meta.drift"), el("div", "drift-clean", t("drift.clean")));
      } else {
        var driftBox = el("div", "drift-meta-box");
        var chips = el("div", "drift-meta-chips");
        driftChips(summary).forEach(function (chip) { chips.appendChild(chip); });
        driftBox.appendChild(chips);
        var ratio = t("drift.summary.ratio").replace("{found}", String(driftFound)).replace("{total}", String(summary.specs));
        driftBox.appendChild(el("div", "muted", ratio));
        metaItem(t("meta.drift"), driftBox);
      }
    } else if (kindOf(run.kind).verifies) {
      metaItem(t("meta.specs"), run.specs.passed + " / " + run.specs.total + " " + t("meta.passed"));
    }
    // Everything this run spent on Claude — live browsing, triage, the audit a
    // failure triggers, spec selection — not the sum of the per-step badges.
    metaItem(t("meta.cost"), costText(run.costUsd));
    metaItem(t("meta.created"), relTime(run.createdAt));
    head.appendChild(meta);

    var actions = el("div", "rd-actions");
    // The artifacts tarball download puts the token in the URL, unlike evidence
    // images which fetch with an auth header. A full-page <a> can't send
    // headers, so the API deliberately accepts ?token= on GETs (see auth.ts /
    // docs/hub.md) — the tradeoff being the token can leak via history or proxy
    // logs. Accepted here because it's a user-initiated, top-level open.
    // (There is no standalone HTML report anymore — this UI IS the report.)
    var tok = encodeURIComponent(state.token);
    var artifactsLink = document.createElement("a");
    artifactsLink.className = "btn";
    artifactsLink.rel = "noopener";
    artifactsLink.href = "/api/v1/runs/" + encodeURIComponent(run.id) + "/artifacts?token=" + tok;
    artifactsLink.textContent = t("detail.download");
    actions.appendChild(artifactsLink);
    head.appendChild(actions);
  }

  // ── run detail: evidence images ──
  // Fetched with the auth header (never a ?token= in the src, which would put
  // the token in DOM/history/logs) and set as a data URI. A data URI avoids
  // the object-URL lifecycle entirely — nothing to revoke, and no blob-URL
  // decoding quirks. Evidence sets are small (a handful of PNGs per spec), so
  // loading them eagerly when the run detail opens is simpler and fine.

  function loadEvidenceImage(img) {
    var runId = img.getAttribute("data-run-id");
    var relPath = img.getAttribute("data-rel-path");
    if (!runId || !relPath) return;
    var segments = relPath.split("/").map(encodeURIComponent).join("/");
    fetch("/api/v1/runs/" + encodeURIComponent(runId) + "/artifacts/" + segments, {
      headers: { Authorization: "Bearer " + state.token },
    })
      .then(function (res) {
        if (!res.ok) {
          var e = new Error(res.status + " " + res.statusText);
          e.status = res.status;
          throw e;
        }
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { reject(new Error("read failed")); };
          reader.readAsDataURL(blob);
        });
      })
      .then(function (dataUri) { img.src = dataUri; })
      .catch(function (err) {
        // Don't let one image break the page, but leave a trace: an expired
        // token turns every image into a failure, so surface that distinctly
        // and log the rest instead of collapsing all causes into one string.
        console.warn("evidence image load failed", relPath, err);
        img.alt = err && (err.status === 401 || err.status === 403)
          ? "auth expired — reconnect"
          : "failed to load";
      });
  }

  function evidenceImg(runId, relPath, altText) {
    var img = document.createElement("img");
    img.alt = altText || "";
    img.setAttribute("data-run-id", runId);
    img.setAttribute("data-rel-path", relPath);
    loadEvidenceImage(img);
    // Click to zoom — only once the (data-URI) src has actually loaded.
    img.addEventListener("click", function () { if (img.src) openLightbox(img.src, img.alt); });
    return img;
  }

  // Full-screen zoom of an evidence / before-after screenshot. Dismissed by a
  // click anywhere or Escape.
  function openLightbox(src, altText) {
    var box = document.getElementById("lightbox");
    var big = document.getElementById("lightbox-img");
    big.src = src;
    big.alt = altText || "";
    box.hidden = false;
  }
  function closeLightbox() {
    var box = document.getElementById("lightbox");
    if (box.hidden) return;
    box.hidden = true;
    document.getElementById("lightbox-img").src = "";
  }

  // ── run detail: spec cards ──────────────────────────────────────────

  // The diagnosis card: one surface for everything about a failure's cause.
  // Verdict (label + confidence), then the cause→fix pair as labelled rows —
  // headline and recommendation are one causal unit, so they read as one.
  // subDiagnosis is deliberately NOT shown: it is a machine vocabulary for
  // accuracy stratification and learning, not for humans. The caller appends
  // the evidence/reasoning accordions and the grading zone into this box.
  function analysisSection(runId, r) {
    var wrap = el("div", "analysis-box");
    var a = r.analysis;
    var head = el("div", "analysis-head");
    head.appendChild(labelChip(a.label));
    // Which repair a SPEC_CHANGE needs — delete the spec, or rewrite it. The
    // label is re-checked rather than trusted: this chip means nothing beside
    // any other one, however the row reached the browser.
    if (a.label === "SPEC_CHANGE" && a.specChangeKind) {
      head.appendChild(el("span", "chip spec-change-chip", t("diag.specChangeKind." + a.specChangeKind)));
    }
    head.appendChild(el("span", "conf", Math.round(a.confidence * 100) + "%"));
    wrap.appendChild(head);
    var kv = el("div", "analysis-kv");
    // Set only when the verdict blames the test case (TEST_DRIFT/SPEC_CHANGE),
    // on both kinds of row — it names the half that has to be repaired.
    if (a.surface) {
      kv.appendChild(el("div", "k", t("diag.surface")));
      kv.appendChild(el("div", "v", t("diag.surface." + a.surface)));
    }
    if (a.headline) {
      kv.appendChild(el("div", "k", t("diag.cause")));
      kv.appendChild(el("div", "v headline", a.headline));
    }
    if (a.recommendation) {
      kv.appendChild(el("div", "k", t("diag.fix")));
      kv.appendChild(el("div", "v", a.recommendation));
    }
    if (kv.childNodes.length > 0) wrap.appendChild(kv);
    return wrap;
  }

  // 根拠: the model's own evidence items (file + what it proves).
  function analysisEvidenceSection(r) {
    var wrap = el("div");
    var count = 0;
    var items = r.analysis && r.analysis.evidence ? r.analysis.evidence : [];
    items.forEach(function (e) {
      var row = el("div", "drift-row");
      if (e.file) {
        var head = el("div", "drift-head");
        head.appendChild(el("code", "ev-file", e.file));
        row.appendChild(head);
      }
      row.appendChild(el("div", "drift-msg", e.detail));
      wrap.appendChild(row);
      count++;
    });
    return { node: wrap, count: count };
  }

  function evidenceSection(runId, evidence) {
    var grid = el("div", "evidence-grid");
    evidence.forEach(function (e) {
      var item = el("div", "evidence-item");
      item.appendChild(evidenceImg(runId, e.pngPath, e.title || e.stepId));
      var cap = el("div", "cap");
      var statusSpan = el("span", "status " + e.status, e.status);
      cap.appendChild(statusSpan);
      if (e.title) cap.appendChild(document.createTextNode(" · " + e.title));
      item.appendChild(cap);
      if (e.failureSummary) item.appendChild(el("div", "cap", e.failureSummary));
      grid.appendChild(item);
    });
    return grid;
  }

  // ── run detail: artifacts (external runCommand targets) ──
  // Images render inline through the same auth-header data-URI loader as
  // evidence; small text/json artifacts fold out to a preview fetched lazily
  // on first open; anything else is a link to the artifact-file API. The link
  // puts the token in the URL — same user-initiated, top-level-open tradeoff
  // as the tarball download above.

  var ARTIFACT_INLINE_MAX_BYTES = 64 * 1024;

  function formatBytes(n) {
    if (typeof n !== "number") return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function artifactOpenLink(runId, relPath) {
    var segments = relPath.split("/").map(encodeURIComponent).join("/");
    var a = document.createElement("a");
    a.className = "artifact-open";
    a.rel = "noopener";
    a.target = "_blank";
    a.href = "/api/v1/runs/" + encodeURIComponent(runId) + "/artifacts/" + segments +
      "?token=" + encodeURIComponent(state.token);
    a.textContent = t("art.open");
    // Inside a <summary>, a plain click would also toggle the accordion.
    a.addEventListener("click", function (ev) { ev.stopPropagation(); });
    return a;
  }

  function loadArtifactText(pre, runId, relPath) {
    var segments = relPath.split("/").map(encodeURIComponent).join("/");
    fetch("/api/v1/runs/" + encodeURIComponent(runId) + "/artifacts/" + segments, {
      headers: { Authorization: "Bearer " + state.token },
    })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status + " " + res.statusText);
        return res.text();
      })
      .then(function (text) { pre.textContent = text; })
      .catch(function (err) {
        console.warn("artifact load failed", relPath, err);
        pre.textContent = t("art.loadFailed");
      });
  }

  function artifactsSection(runId, artifacts) {
    var wrap = el("div");
    var images = artifacts.filter(function (a) { return a.kind === "image"; });
    if (images.length > 0) {
      var grid = el("div", "evidence-grid");
      images.forEach(function (a) {
        var item = el("div", "evidence-item");
        item.appendChild(evidenceImg(runId, a.path, a.name));
        item.appendChild(el("div", "cap", a.name + " · " + formatBytes(a.sizeBytes)));
        grid.appendChild(item);
      });
      wrap.appendChild(grid);
    }
    artifacts.forEach(function (a) {
      if (a.kind === "image") return;
      var textLike = a.kind === "text" || a.kind === "json";
      if (!textLike || a.sizeBytes > ARTIFACT_INLINE_MAX_BYTES) {
        var row = el("div", "artifact-row");
        row.appendChild(el("span", "artifact-kind", a.kind));
        row.appendChild(el("span", "artifact-name", a.name));
        row.appendChild(el("span", "artifact-size", formatBytes(a.sizeBytes)));
        row.appendChild(artifactOpenLink(runId, a.path));
        wrap.appendChild(row);
        return;
      }
      var det = el("details", "acc artifact-acc");
      var sum = document.createElement("summary");
      sum.appendChild(chevron());
      sum.appendChild(el("span", "artifact-kind", a.kind));
      sum.appendChild(el("span", "artifact-name", a.name));
      sum.appendChild(el("span", "artifact-size", formatBytes(a.sizeBytes)));
      sum.appendChild(artifactOpenLink(runId, a.path));
      det.appendChild(sum);
      var pre = el("pre", "artifact-pre", "…");
      var loaded = false;
      det.addEventListener("toggle", function () {
        if (!det.open || loaded) return;
        loaded = true;
        loadArtifactText(pre, runId, a.path);
      });
      det.appendChild(pre);
      wrap.appendChild(det);
    });
    return wrap;
  }

  // The parts a live step and a deterministic step render identically: the
  // status-railed card, a header (#index + instruction + a status badge unless
  // passed), and an optional "expects:"/reasoning meta block. Returns { card,
  // head } so each caller can append its own extras (live: cost badge + before/
  // after frames; det: failure summary + a single frame).
  function stepCard(status, idxLabel, instruction, expects, reasoning) {
    var card = el("div", "step-card " + status);
    var head = el("div", "step-head");
    head.appendChild(el("span", "idx", idxLabel));
    head.appendChild(el("span", "instr", instruction));
    if (status !== "passed") head.appendChild(statusBadge(status));
    card.appendChild(head);

    if (expects || reasoning) {
      var meta = el("div", "step-meta");
      if (expects) {
        var exp = el("div", "expected");
        exp.appendChild(el("b", null, "expects: "));
        exp.appendChild(document.createTextNode(expects));
        meta.appendChild(exp);
      }
      if (reasoning) meta.appendChild(el("div", "reasoning", reasoning));
      card.appendChild(meta);
    }
    return { card: card, head: head };
  }

  function liveStepsSection(runId, steps) {
    var wrap = el("div");
    steps.forEach(function (s, i) {
      var built = stepCard(s.status, "#" + (i + 1), s.instruction, s.expected, s.reasoning);
      if (s.cost && s.cost.totalCostUsd != null) {
        built.head.appendChild(el("span", "cost", costText(s.cost.totalCostUsd)));
      }
      if (s.beforePng || s.afterPng) {
        var frames = el("div", "step-frames");
        if (s.beforePng) frames.appendChild(frameEl(runId, s.beforePng, "before"));
        if (s.afterPng) frames.appendChild(frameEl(runId, s.afterPng, "after"));
        built.card.appendChild(frames);
      }
      wrap.appendChild(built.card);
    });
    return wrap;
  }

  // Script-driven step evidence (agent-browser replays and external targets
  // alike) rendered as the same step-card list as live runs — report.json
  // carries one evidence entry per step. A target that captures both boundaries
  // (Playwright) gets before/after frames like the live section; agent-browser
  // shoots one, so only the after frame renders.
  function detStepsSection(runId, evidence) {
    var wrap = el("div");
    evidence.forEach(function (e, i) {
      var built = stepCard(e.status, "#" + (i + 1), e.stepId, e.description, e.title);
      if (e.failureSummary) built.card.appendChild(el("div", "cap", e.failureSummary));
      if (e.beforePngPath || e.pngPath) {
        var frames = el("div", "step-frames");
        if (e.beforePngPath) frames.appendChild(frameEl(runId, e.beforePngPath, "before"));
        if (e.pngPath) frames.appendChild(frameEl(runId, e.pngPath, e.beforePngPath ? "after" : e.stepId));
        built.card.appendChild(frames);
      }
      wrap.appendChild(built.card);
    });
    return wrap;
  }

  // A labelled screenshot frame ("before"/"after") reusing evidenceImg's
  // auth-header → data-URI loader (never a ?token= in the src).
  function frameEl(runId, relPath, labelText) {
    var f = el("div", "frame");
    f.appendChild(el("span", "flabel", labelText));
    f.appendChild(evidenceImg(runId, relPath, labelText));
    return f;
  }

  function assertionsSection(assertions) {
    var wrap = el("div");
    wrap.appendChild(el("div", "assertions-hint muted", t("acc.assertions.hint")));
    assertions.forEach(function (a) {
      var row = el("div", "assertion-row");
      row.appendChild(statusBadge(a.status));
      row.appendChild(el("div", "name", a.name));
      if (a.durationMs != null) row.appendChild(el("div", "dur", a.durationMs + "ms"));
      wrap.appendChild(row);
    });
    return wrap;
  }

  // A rotating chevron; the CSS rotates it 0->90deg when the <details> is open.
  function chevron() {
    var svg = svgIcon();
    svg.setAttribute("class", "chev");
    svg.appendChild(svgPath("M9 6l6 6-6 6"));
    return svg;
  }

  // Tier3 accordion: a 40px header bar with a chevron + label (+ optional count),
  // replacing the old bare <summary> with its tiny ▸ marker.
  function detailsBlock(labelText, count, contentNode) {
    var det = el("details", "acc");
    var sum = document.createElement("summary");
    sum.appendChild(chevron());
    sum.appendChild(el("span", null, labelText));
    if (count != null) sum.appendChild(el("span", "count", "· " + count));
    det.appendChild(sum);
    var body = el("div", "acc-body");
    body.appendChild(contentNode);
    det.appendChild(body);
    return det;
  }

  // The grading action: an explicit question, a segmented single-select over
  // that side's causes, and a status chip (ungraded / saved·matches /
  // saved·corrected). One tap grades it. The question is side-aware: a run
  // row asks what actually caused the failure (grade.question.run); a drift
  // row asks whether the drift the audit reported was real
  // (grade.question.drift), since that side grades against NO_DRIFT rather
  // than a cause. Optimistic PUT with rollback; on success it refreshes the
  // confusion matrix. The English label value is what's sent and stored; the
  // segment just shows its localized name.
  // isDrift comes from the run, not from triageState: the first paint happens
  // before loadTriage resolves, and reading it off the empty state would offer
  // one side's causes on the other side's row for a frame.
  function triageGradeControl(runId, r, triageState, isDrift) {
    var key = r.feature + "/" + r.spec;
    var causes = causeLabels(isDrift);
    var predicted = r.analysis ? r.analysis.label : "UNKNOWN";

    var wrap = el("div", "grade");

    // No "predicted →" chip here: the control lives inside the diagnosis
    // card, directly under the prediction it grades — repeating it is noise.
    var top = el("div", "grade-top");
    top.appendChild(el("span", "grade-q", t(isDrift ? "grade.question.drift" : "grade.question.run")));
    wrap.appendChild(top);

    var bottom = el("div", "grade-bottom");
    var seg = el("div", "grade-seg");
    var status = el("span", "grade-status");
    var segByLabel = {};

    // Reflect the current selection (colour + check) and the status chip.
    // invalid marks a grade whose cause this row's kind cannot produce:
    // selected is then a value causes does not contain, so no segment lights
    // up, and it must never read as "matches" — that would assert an
    // agreement nobody measured.
    function paint(selected, invalid) {
      causes.forEach(function (lbl) {
        var b = segByLabel[lbl];
        b.setAttribute("aria-pressed", String(lbl === selected));
        b.firstChild.textContent = (lbl === selected ? "✓ " : "") + labelText(lbl);
      });
      status.className = "grade-status";
      if (invalid) {
        status.classList.add("saved-invalid");
        status.textContent = labelText(selected) + " — " + t("grade.invalidRegrade");
        return;
      }
      if (!selected) { status.textContent = t("grade.ungraded"); return; }
      if (selected === predicted) { status.classList.add("saved-match"); status.textContent = t("grade.matches"); }
      else { status.classList.add("saved-corrected"); status.textContent = t("grade.corrected"); }
    }

    var existing = triageState.byKey[key];
    var current = existing && existing.actual ? existing.actual.cause : "";
    var currentInvalid = !!(existing && existing.actual && existing.actual.invalidForKind);

    causes.forEach(function (lbl) {
      var b = el("button", "seg " + lbl);
      b.type = "button";
      b.appendChild(el("span", null, labelText(lbl))); // text node the paint() updates
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", function () {
        if (lbl === current) return; // no-op re-click; lbl only ranges over causes, so an invalid current never matches
        var prev = current;
        var prevInvalid = currentInvalid;
        causes.forEach(function (l) { segByLabel[l].disabled = true; });
        paint(lbl, false);
        status.className = "grade-status saving";
        status.textContent = t("grade.saving");
        putActualCause(runId, r.feature, r.spec, lbl)
          .then(function () {
            current = lbl;
            currentInvalid = false;
            if (!triageState.byKey[key]) {
              triageState.byKey[key] = { feature: r.feature, spec: r.spec, predicted: r.analysis, actual: null };
            }
            triageState.byKey[key].actual = { cause: lbl };
            paint(lbl, false); // clears .saving, sets final matches/corrected
            renderMatrix(triageState);
          })
          .catch(function (err) {
            paint(prev, prevInvalid); // roll back the optimistic selection
            status.className = "grade-status err";
            status.textContent = t("grade.error") + (err && err.message ? ": " + err.message : "");
          })
          .then(function () {
            causes.forEach(function (l) { segByLabel[l].disabled = false; });
          });
      });
      segByLabel[lbl] = b;
      seg.appendChild(b);
    });

    bottom.appendChild(seg);
    bottom.appendChild(status);
    wrap.appendChild(bottom);
    paint(current, currentInvalid); // restore saved state on (re)render
    return wrap;
  }

  function renderSpecCard(runId, r, triageState, isDrift) {
    // The human's answer for this row, if it has one. Everything the card says
    // about whether the spec drifted follows it rather than the audit.
    var gradedCase = triageState.byKey[r.feature + "/" + r.spec];
    var graded = isDrift && gradedCase && gradedCase.actual ? gradedCase.actual.cause : null;
    var rowState = isDrift ? driftRowState(r, graded) : null;
    // The rail follows the AUDIT, not the grade — deliberately the one place
    // that does. It is what a reader scans the page by ("which rows did this
    // audit flag"), and repainting a graded row would take it out of that
    // scan, hiding the very call they are here to check. The badge on the row
    // carries the graded answer.
    //
    // Green is reserved for "clean" — it is the one colour that tells a reader
    // to move on, and an audit that could not tell has not earned it. Unknown
    // shares the amber "look at this" rail rather than getting a third colour.
    var RAIL = { found: "drift-found", unknown: "drift-found", clean: "passed" };
    var card = el("div", "spec-card " + (isDrift ? RAIL[driftRowState(r, null)] : r.status));
    var head = el("div", "spec-card-head");
    var nameBlock = el("div");
    nameBlock.appendChild(el("div", "name", r.title || (r.feature + " / " + r.spec)));
    nameBlock.appendChild(el("div", "slug", r.feature + " / " + r.spec));
    head.appendChild(nameBlock);
    head.appendChild(el("div", "spacer"));
    // Target ids are technical identifiers (like the failure-label values):
    // shown verbatim, never localized.
    if (r.target) head.appendChild(el("span", "badge-target", r.target));
    // The live/det mode split only exists on the agent-browser target; an
    // external-target row is identified by its target chip alone.
    //
    // Whether this is a test run or a drift audit is a fact about the RUN, not
    // about each spec in it — it is stated once in the run header. What belongs
    // here is what this spec is, which for a drift audit also says how much of
    // the test case was examined (two surfaces or one). The liveRun field cannot
    // answer that on a drift row, since nothing ran; mode is carried for it.
    var external = r.target && r.target !== AGENT_BROWSER_TARGET;
    var live = r.mode ? r.mode === "live" : !!r.liveRun;
    var modeKnown = r.mode !== undefined || !isDrift;
    if (modeKnown && live) head.appendChild(el("span", "badge-live", t("spec.kind.live")));
    else if (modeKnown && !external) head.appendChild(el("span", "badge-det", t("spec.kind.det")));
    head.appendChild(isDrift ? driftFoundBadge(rowState, "drift.spec.") : statusBadge(r.status));
    card.appendChild(head);

    var body = el("div", "spec-card-body");
    var any = false;

    if (isDrift && !r.analysis) {
      body.appendChild(el("div", "drift-clean", t("drift.clean")));
      any = true;
    }

    // A drift-kind row's diagnosis lives in analysis regardless of status
    // (an UNKNOWN-labelled finding below the --exit-on threshold still
    // "passes" but has something to show); a normal run only ever classifies
    // a failed spec.
    var hasAnalysis = isDrift ? !!r.analysis : r.status === "failed" && r.analysis;
    if (hasAnalysis) {
      // The diagnosis card: verdict + cause/fix, then evidence and reasoning
      // as accordions, then the grading zone — one surface for the whole
      // "why did this fail and was the call right" story.
      var box = analysisSection(runId, r);
      var ev = analysisEvidenceSection(r);
      if (ev.count > 0) box.appendChild(detailsBlock(t("acc.evidence"), ev.count, ev.node));
      // Reasoning: fold it as an accordion, but only when it carries real
      // content. A one-char/empty reasoning behind a disclosure reads as broken
      // (the old "▸ r"), so drop it entirely below the threshold.
      var reasoning = r.analysis.reasoning ? String(r.analysis.reasoning).trim() : "";
      if (reasoning.length > 2) {
        box.appendChild(detailsBlock(t("acc.reasoning"), null, el("div", "analysis-reasoning", reasoning)));
      }
      // Drift rows are graded too. Nothing ran, so what is being graded is the
      // classification itself — "it called this TEST_DRIFT; it was really a
      // SPEC_CHANGE" — which is exactly the measurement that has to exist
      // before a wrong label is allowed to drive an automatic fix.
      box.appendChild(triageGradeControl(runId, r, triageState, isDrift));
      body.appendChild(box);
      any = true;
    } else if (r.status === "failed" && r.analysisSkipped) {
      body.appendChild(el("div", "muted", "Analysis skipped: " + r.analysisSkipped));
      any = true;
    }

    if (!r.liveRun && r.evidence && r.evidence.length > 0) {
      var stepsLabel = el("div", "section-label", t("det.steps"));
      body.appendChild(stepsLabel);
      body.appendChild(detStepsSection(runId, r.evidence));
      any = true;
    } else if (r.evidence && r.evidence.length > 0) {
      body.appendChild(detailsBlock(t("acc.evidence"), r.evidence.length, evidenceSection(runId, r.evidence)));
      any = true;
    } else if (!r.liveRun && r.evidenceUnavailable) {
      // No step screenshots, but say why rather than showing nothing (a target
      // that can't capture them, or a generated test that lost its calls).
      body.appendChild(el("div", "section-label", t("det.steps")));
      body.appendChild(el("div", "muted", t("det.noEvidence") + " " + r.evidenceUnavailable));
      any = true;
    }

    if (r.liveRun && r.liveRun.steps && r.liveRun.steps.length > 0) {
      body.appendChild(detailsBlock(t("acc.steps"), r.liveRun.steps.length, liveStepsSection(runId, r.liveRun.steps)));
      any = true;
    }

    if (r.artifacts && r.artifacts.length > 0) {
      body.appendChild(detailsBlock(t("acc.artifacts"), r.artifacts.length, artifactsSection(runId, r.artifacts)));
      any = true;
    }

    if (r.assertions && r.assertions.length > 0) {
      body.appendChild(detailsBlock(t("acc.assertions"), r.assertions.length, assertionsSection(r.assertions)));
      any = true;
    }

    if (any) card.appendChild(body);
    return card;
  }

  function renderSpecCards(runId, results, triageState, isDrift) {
    var container = document.getElementById("spec-cards");
    clear(container);
    results.forEach(function (r) { container.appendChild(renderSpecCard(runId, r, triageState, isDrift)); });
    document.getElementById("detail-spec-count").textContent = "· " + results.length;
  }

  // ── run detail: triage (confusion matrix) ───────────────────────────

  function putActualCause(runId, feature, spec, cause) {
    var path = "/api/v1/runs/" + encodeURIComponent(runId) + "/triage/" +
      encodeURIComponent(feature) + "/" + encodeURIComponent(spec) + "/actual-cause";
    return apiFetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cause: cause }),
    });
  }

  // Bucket a case's target, defaulting an unset one to the built-in target so
  // pre-target grades still land under a real segment.
  function caseTarget(c) { return c.target || AGENT_BROWSER_TARGET; }

  // " (N excluded, not a valid cause for their row)", or "" when nothing is excluded.
  function invalidSuffix(n) {
    return n > 0 ? " (" + t("matrix.invalidExcluded").replace("{n}", String(n)) + ")" : "";
  }

  function renderMatrix(triageState) {
    var card = document.getElementById("matrix-card");
    clear(card);
    var wrap = el("div", "matrix-wrap");
    var all = Object.keys(triageState.byKey).map(function (k) { return triageState.byKey[k]; });
    // A row can carry a grade under a cause its kind does not offer (the
    // other kind's, most commonly). Excluded from the matrix and the
    // "graded" denominator — never silently; the header shows the count.
    var graded = all.filter(function (c) { return c.predicted && c.actual && !c.actual.invalidForKind; });
    var invalidForKind = all.filter(function (c) { return c.predicted && c.actual && c.actual.invalidForKind; });

    // The "graded m / n" counter in the header is the single progress
    // readout — recomputed here so it stays in sync after each grade.
    var total = typeof triageState.total === "number" ? triageState.total : all.length;
    var summary = document.getElementById("triage-summary");

    if (graded.length === 0) {
      if (summary) summary.textContent = t("matrix.graded") + " 0 / " + total + invalidSuffix(invalidForKind.length);
      wrap.appendChild(el("div", "muted", t("matrix.empty")));
      card.appendChild(wrap);
      return;
    }

    // Per-target filter: only surfaced when more than one target has grades, so
    // single-target projects see no extra control. "All" is the default.
    var targets = [];
    graded.forEach(function (c) {
      var tg = caseTarget(c);
      if (targets.indexOf(tg) === -1) targets.push(tg);
    });
    targets.sort();
    var filter = triageState.targetFilter || "all";
    if (targets.indexOf(filter) === -1) filter = "all";
    if (targets.length > 1) {
      wrap.appendChild(targetFilterControl(triageState, targets, filter));
    }
    var cases = filter === "all"
      ? graded
      : graded.filter(function (c) { return caseTarget(c) === filter; });

    // A drift audit opens no browser, so it never answers PRODUCT_BUG or
    // ENVIRONMENT, and NO_DRIFT is not an answer about a run. A row or column
    // for a label this kind cannot produce would sit at zero forever and read
    // as "it never predicted this" — an accuracy claim, when it is only a
    // definition.
    var predictedRows = triageState.isDrift ? DRIFT_LABELS : RUN_LABELS;
    var actualCols = causeLabels(triageState.isDrift);
    var matrix = {};
    predictedRows.forEach(function (p) {
      matrix[p] = {};
      actualCols.forEach(function (a) { matrix[p][a] = 0; });
    });
    var correct = 0;
    cases.forEach(function (c) {
      var predicted = c.predicted.label;
      var actual = c.actual.cause;
      if (matrix[predicted] && actual in matrix[predicted]) {
        matrix[predicted][actual]++;
        if (predicted === actual) correct++;
      }
    });

    var table = document.createElement("table");
    table.className = "matrix-table";
    // Two header rows so each axis is named where it lives: "actual" spans the
    // columns, "predicted" sits over the row labels. A single "predicted \\
    // actual" corner cell leaves the reader to work out which is which.
    var thead = document.createElement("thead");
    var axisRow = document.createElement("tr");
    var corner = el("th", "matrix-corner", t("matrix.axis.predicted"));
    corner.rowSpan = 2;
    axisRow.appendChild(corner);
    var actualHead = el("th", "matrix-axis", t("matrix.axis.actual"));
    actualHead.colSpan = actualCols.length;
    axisRow.appendChild(actualHead);
    thead.appendChild(axisRow);
    var headRow = document.createElement("tr");
    actualCols.forEach(function (a) { headRow.appendChild(el("th", null, labelText(a))); });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    predictedRows.forEach(function (p) {
      var row = document.createElement("tr");
      row.appendChild(el("th", null, labelText(p)));
      actualCols.forEach(function (a) {
        var n = matrix[p][a];
        var cls = (p === a ? "diag" : "") + (n > 0 ? " nz" : "");
        row.appendChild(el("td", cls.trim() || null, String(n)));
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    var accuracy = Math.round((correct / cases.length) * 100);
    var accEl = el("div", "matrix-accuracy");
    accEl.appendChild(document.createTextNode(t("matrix.accuracy") + " "));
    accEl.appendChild(el("b", null, accuracy + "%"));
    accEl.appendChild(document.createTextNode(" — " + correct + " / " + cases.length + " " + t("matrix.accSuffix")));
    wrap.appendChild(accEl);

    // Header must not mix populations: when a target filter is active, the
    // count, denominator, accuracy, and excluded count all describe that
    // target only.
    var headerGraded = graded.length;
    var headerTotal = total;
    var headerInvalid = invalidForKind.length;
    if (filter !== "all") {
      headerGraded = cases.length;
      headerInvalid = invalidForKind.filter(function (c) { return caseTarget(c) === filter; }).length;
      headerTotal = Object.keys(triageState.byKey).reduce(function (n, k) {
        return caseTarget(triageState.byKey[k]) === filter ? n + 1 : n;
      }, 0);
    }
    if (summary) {
      summary.textContent = t("matrix.graded") + " " + headerGraded + " / " + headerTotal + " · " + accuracy + "%" + invalidSuffix(headerInvalid);
    }

    card.appendChild(wrap);

    // The learn CTA only makes sense once there's at least one graded case.
    var cta = document.getElementById("learn-cta");
    if (cta) cta.hidden = graded.length === 0;
  }

  // Segmented "All targets / <target> …" control above the matrix. Selecting a
  // segment re-renders the matrix for that target only. Reuses the shared
  // seg-toggle look (aria-pressed marks the active segment).
  function targetFilterControl(triageState, targets, active) {
    var seg = el("div", "seg-toggle matrix-target-filter");
    var opts = [{ id: "all", label: t("matrix.target.all") }].concat(
      targets.map(function (tg) { return { id: tg, label: tg }; }),
    );
    opts.forEach(function (opt) {
      var b = el("button", "seg", opt.label);
      b.type = "button";
      b.setAttribute("aria-pressed", opt.id === active ? "true" : "false");
      b.onclick = function () {
        triageState.targetFilter = opt.id;
        renderMatrix(triageState);
      };
      seg.appendChild(b);
    });
    return seg;
  }

  // isDrift is an argument, not something the caller patches on afterwards: the
  // matrix is drawn here, before onLoaded runs, and it decides which rows exist.
  function loadTriage(runId, isDrift, onLoaded) {
    apiFetch("/api/v1/runs/" + encodeURIComponent(runId) + "/triage").then(function (res) {
      var byKey = {};
      res.cases.forEach(function (c) { byKey[c.feature + "/" + c.spec] = c; });
      var triageState = { byKey: byKey, total: res.total, isDrift: isDrift };
      renderMatrix(triageState);
      onLoaded(triageState);
    }).catch(function (err) {
      // Surface the load failure inside the triage card so it isn't silent.
      var card = document.getElementById("matrix-card");
      clear(card);
      var wrap = el("div", "matrix-wrap");
      wrap.appendChild(el("div", "muted", "Error loading triage: " + err.message));
      card.appendChild(wrap);
      onLoaded({ byKey: {}, isDrift: isDrift });
    });
  }

  // ── run detail: orchestration ───────────────────────────────────────

  function detailError(msg) {
    var e = document.getElementById("detail-error");
    e.hidden = false;
    e.textContent = msg;
  }

  function openRunDetail(runId) {
    showView("detail");
    state.detailRunId = runId;
    document.getElementById("detail-title").textContent = runId.slice(0, 8);
    document.getElementById("detail-error").hidden = true;
    document.getElementById("learn-cta").hidden = true;
    document.getElementById("learn-run").disabled = false; // reset from a prior learn
    clear(document.getElementById("spec-cards"));
    clear(document.getElementById("rd-head"));
    clear(document.getElementById("matrix-card"));
    document.getElementById("detail-spec-count").textContent = "";
    document.getElementById("triage-summary").textContent = "";

    // Retention drops a run but never the ledger entries pointing at it, so a
    // Perspectives link can outlive its target. That 404 is the whole story of
    // the page, so it speaks for the report's failure too.
    var runGone = false;

    apiFetch("/api/v1/runs/" + encodeURIComponent(runId)).then(function (run) {
      renderRunHead(run);
    }).catch(function (err) {
      runGone = err.status === 404;
      detailError(runGone ? t("detail.notKept") : "Error loading run: " + err.message);
    });

    apiFetch("/api/v1/runs/" + encodeURIComponent(runId) + "/report").then(function (report) {
      // Draw the spec cards first from the report alone, then re-draw once
      // triage loads so the saved grades restore. Keeping these separate means
      // a triage failure (or a throw while rendering cards) can't be mislabelled
      // as the other, and neither escapes its own catch.
      // A drift row is graded too — what is being graded is the classification,
      // not an outcome — so the tally belongs here for the same reason it does
      // on a run. The triage API keys off the row's analysis, which drift rows
      // now carry, so nothing about the run's kind gates it.
      var isDrift = report.kind === "drift";
      renderSpecCards(runId, report.results, { byKey: {} }, isDrift);
      loadTriage(runId, isDrift, function (loaded) {
        renderSpecCards(runId, report.results, loaded, isDrift);
      });
    }).catch(function (err) {
      if (!runGone) detailError("Error loading report: " + err.message);
    });
  }

  // ── learning jobs ────────────────────────────────────────────────────

  function jobsProfile() {
    return state.profile || "default";
  }

  function setJobsStatus(msg) {
    var s = document.getElementById("jobs-status");
    s.hidden = !msg;
    s.textContent = msg || "";
  }

  // Kick off a learn from the run-detail CTA, then jump to the job's detail.
  function startLearn() {
    if (!state.detailRunId) return;
    var btn = document.getElementById("learn-run");
    btn.disabled = true;
    apiFetch("/api/v1/projects/" + encodeURIComponent(state.project) + "/learning-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: jobsProfile() }),
    }).then(function (job) {
      location.hash = "#/jobs/" + encodeURIComponent(job.id);
    }).catch(function (err) {
      btn.disabled = false;
      var e = document.getElementById("detail-error");
      e.hidden = false;
      e.textContent = "Could not start learning: " + err.message;
    });
  }

  function jobStatusChip(status) {
    return el("span", "job-status " + status, status);
  }

  function renderJobsList(jobs) {
    var tbody = document.getElementById("jobs-tbody");
    clear(tbody);
    if (jobs.length === 0) {
      var tr = el("tr");
      var td = el("td", "muted", t("jobs.empty"));
      td.colSpan = 4;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    jobs.forEach(function (j) {
      var tr = el("tr");
      tr.appendChild(el("td", "mono", j.id.slice(0, 8)));
      var st = el("td"); st.appendChild(jobStatusChip(j.status)); tr.appendChild(st);
      tr.appendChild(el("td", "mono", j.customPromptVersion ? j.customPromptVersion.slice(0, 24) : "—"));
      tr.appendChild(el("td", "muted", relTime(j.createdAt)));
      tr.addEventListener("click", function () { location.hash = "#/jobs/" + encodeURIComponent(j.id); });
      tr.style.cursor = "pointer";
      tbody.appendChild(tr);
    });
  }

  function openJobs() {
    if (!state.project) { location.hash = "#/projects"; route(); return; }
    showView("jobs");
    document.getElementById("job-detail").hidden = true;
    document.getElementById("jobs-list-card").hidden = false;
    loadJobs();
  }

  function loadJobs() {
    setJobsStatus("");
    apiFetch("/api/v1/projects/" + encodeURIComponent(state.project) + "/learning-jobs?profile=" + encodeURIComponent(jobsProfile()))
      .then(function (data) { renderJobsList(data.jobs); })
      .catch(function (err) { setJobsStatus("Error loading jobs: " + err.message); });
  }

  // Render one before/after prompt column.
  function promptColumn(heading, text) {
    var col = el("div", "col");
    col.appendChild(el("div", "h", heading));
    var pre = el("pre");
    pre.textContent = text || "(empty)";
    col.appendChild(pre);
    return col;
  }

  function renderJobDetail(job) {
    var host = document.getElementById("job-detail");
    clear(host);

    var head = el("div", "job-detail-head");
    head.appendChild(el("h3", null, "Job " + job.id.slice(0, 8)));
    head.appendChild(jobStatusChip(job.status));
    if (job.input) {
      head.appendChild(el("span", "muted", job.input.casesConsidered + " " + t("jobs.cases")));
    }
    host.appendChild(head);

    if (job.status === "queued" || job.status === "running") {
      host.appendChild(el("p", "muted", t("jobs.inProgress")));
    } else if (job.status === "failed") {
      host.appendChild(el("div", "job-error", job.error || t("jobs.failed")));
    } else if (job.status === "succeeded" && job.result) {
      host.appendChild(el("p", "muted", t("jobs.newCustomPrompt") + " " + job.result.customPromptVersion));
      var diff = el("div", "prompt-diff");
      diff.appendChild(promptColumn(t("jobs.before"), job.result.beforePrompt));
      diff.appendChild(promptColumn(t("jobs.after"), job.result.afterPrompt));
      host.appendChild(diff);
    }
  }

  function openJobDetail(jobId) {
    showView("jobs");
    document.getElementById("jobs-list-card").hidden = true;
    document.getElementById("job-detail").hidden = false;
    pollJob(jobId, ++state.jobPollToken);
  }

  // Poll a job until it reaches a terminal status, then stop. The captured
  // token is compared against the live one so navigating away (which bumps the
  // token via showView) silently ends the loop.
  function pollJob(jobId, token) {
    if (token !== state.jobPollToken) return;
    apiFetch("/api/v1/projects/" + encodeURIComponent(state.project) + "/learning-jobs/" + encodeURIComponent(jobId))
      .then(function (job) {
        if (token !== state.jobPollToken) return;
        renderJobDetail(job);
        if (job.status === "queued" || job.status === "running") {
          setTimeout(function () { pollJob(jobId, token); }, 2000);
        }
      })
      .catch(function (err) {
        if (token !== state.jobPollToken) return;
        var host = document.getElementById("job-detail");
        clear(host);
        host.appendChild(el("div", "job-error", "Error loading job: " + err.message));
      });
  }

  // ── secrets ──────────────────────────────────────────────────────────

  function secProfile() {
    return state.profile || "default";
  }

  function scopeBase(kind) {
    return "/api/v1/projects/" + encodeURIComponent(state.project) + "/" + kind + "/" + encodeURIComponent(secProfile());
  }

  function setSecretsStatus(message) {
    var box = document.getElementById("secrets-status");
    box.hidden = !message;
    box.textContent = message || "";
  }

  function secretsError(what) {
    return function (err) { setSecretsStatus(what + " failed: " + err.message); };
  }

  function openSecrets() {
    showView("secrets");
    document.getElementById("sheet-scope-project").textContent = state.project;
    document.getElementById("sheet-scope-profile").textContent = secProfile();
    // Populate the profile selector for this project, then load the secrets.
    loadProfiles().then(function () { loadSecrets(); });
  }

  function loadSecrets(statusAfter) {
    // Show any success note from the action that triggered this reload; a
    // subsequent load error will overwrite it (surfacing the error is right).
    setSecretsStatus(statusAfter || "");
    var varsTbody = document.getElementById("vars-tbody");
    var sessionsTbody = document.getElementById("sessions-tbody");
    clear(varsTbody);
    clear(sessionsTbody);
    apiFetch(scopeBase("variables")).then(function (data) {
      renderVariables(data.variables);
    }).catch(secretsError("Loading variables"));
    apiFetch(scopeBase("sessions")).then(function (data) {
      renderSessions(data.sessions);
    }).catch(secretsError("Loading sessions"));
  }

  function deleteCell(onClick) {
    var td = document.createElement("td");
    td.style.textAlign = "right";
    var btn = el("button", "btn ghost sm del", "delete");
    btn.addEventListener("click", onClick);
    td.appendChild(btn);
    return td;
  }

  function renderVariables(variables) {
    var tbody = document.getElementById("vars-tbody");
    clear(tbody);
    document.getElementById("vars-count").textContent = String(variables.length);
    variables.forEach(function (v) {
      var tr = document.createElement("tr");
      var nameTd = document.createElement("td");
      nameTd.appendChild(el("span", "keyname", v.name));
      tr.appendChild(nameTd);
      var valTd = document.createElement("td");
      if (v.sensitive) {
        var tag = el("span", "lock-tag", "sensitive");
        valTd.appendChild(tag);
      } else if ("value" in v) {
        valTd.appendChild(el("span", "val", v.value));
      } else {
        // A non-sensitive value should always come back; a missing one means the
        // hub has no encryption key or this blob failed to decrypt. Both look the
        // same over the wire, so at least leave a console trace rather than a
        // silent "(unavailable)".
        console.warn("variable value unavailable (no encryption key or decrypt failed):", v.name);
        valTd.appendChild(el("span", "val", "(unavailable)"));
      }
      tr.appendChild(valTd);
      tr.appendChild(deleteCell(function () {
        apiFetch(scopeBase("variables") + "/" + encodeURIComponent(v.name), { method: "DELETE" })
          .then(function () { loadSecrets('Deleted variable "' + v.name + '"'); })
          .catch(secretsError("Deleting variable"));
      }));
      tbody.appendChild(tr);
    });
  }

  function renderSessions(sessions) {
    var tbody = document.getElementById("sessions-tbody");
    clear(tbody);
    document.getElementById("sessions-count").textContent = String(sessions.length);
    sessions.forEach(function (s) {
      var tr = document.createElement("tr");
      var nameTd = document.createElement("td");
      nameTd.appendChild(el("span", "keyname", s.name));
      tr.appendChild(nameTd);
      tr.appendChild(el("td", "muted num", relTime(s.updatedAt)));
      tr.appendChild(deleteCell(function () {
        apiFetch(scopeBase("sessions") + "/" + encodeURIComponent(s.name), { method: "DELETE" })
          .then(function () { loadSecrets('Deleted session "' + s.name + '"'); })
          .catch(secretsError("Deleting session"));
      }));
      tbody.appendChild(tr);
    });
  }

  // ── prompts ────────────────────────────────────────────────────────────
  // Prompt cards (names mirror src/prompts/prompt-names.ts). Each ".user" slot
  // is editable; every ".agent" slot is ccqa-generated and read-only. Each slot
  // names its sub-label (Your instructions / Learned by ccqa) and a "when to
  // use" hint. Of the ".agent" slots, only these two are stored as JSON rather
  // than prose, so they alone need customPromptDisplayText below.
  var LEARNED_PROMPT_NAMES = ["triage.agent", "audit.agent"];
  // The guidance cards are uniform — an editable <kind>.user slot plus a
  // read-only <kind>.agent slot — so derive them from GUIDANCE_KINDS rather
  // than hand-listing each; a new target's card then follows from adding its
  // i18n prose keys (prompt.card.<kind>, prompt.<kind>User/Agent.hint). The
  // triage and audit cards are shaped differently and stay explicit.
  var PROMPT_CARDS = GUIDANCE_KINDS.map(function (kind) {
    return { titleKey: "prompt.card." + kind, slots: [
      { name: kind + ".user", subKey: "prompt.sub.user", hintKey: "prompt." + kind + "User.hint", agent: false },
      { name: kind + ".agent", subKey: "prompt.sub.agent", hintKey: "prompt." + kind + "Agent.hint", agent: true },
    ] };
  }).concat([
    { titleKey: "prompt.card.triage", slots: [
      { name: "triage.user", subKey: "prompt.sub.user", hintKey: "prompt.triageUser.hint", agent: false },
      { name: "triage.agent", subKey: "prompt.sub.agent", hintKey: "prompt.triageAgent.hint", agent: true },
    ] },
    { titleKey: "prompt.card.audit", slots: [
      { name: "audit.user", subKey: "prompt.sub.user", hintKey: "prompt.auditUser.hint", agent: false },
      { name: "audit.agent", subKey: "prompt.sub.agent", hintKey: "prompt.auditAgent.hint", agent: true },
    ] },
  ]);
  // Flat list of every slot, for loadPrompts to fill via its _ta handle.
  var GUIDANCE_SLOTS = PROMPT_CARDS.reduce(function (acc, card) { return acc.concat(card.slots); }, []);

  // Prompts are project-scoped (not per-profile).
  function promptPath(name) {
    return "/api/v1/projects/" + encodeURIComponent(state.project) +
      "/prompts/" + encodeURIComponent(name);
  }

  // Prompt bodies aren't JSON-uniform (guidance = text/markdown, custom prompt =
  // application/json), so apiFetch()'s res.json() assumption doesn't fit — fetch
  // the raw text directly. Returns null on 404 (prompt not set yet).
  function fetchPromptText(name) {
    return fetch(promptPath(name), { headers: { Authorization: "Bearer " + state.token } }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      return res.text();
    }, function () { throw new Error("Network unreachable — check the hub URL and your connection"); });
  }

  // PUT a guidance body as raw markdown (custom prompt is never written from the UI).
  function putPromptText(name, text) {
    return apiFetch(promptPath(name), {
      method: "PUT",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      body: text,
    });
  }

  function deletePromptEntry(name) {
    return apiFetch(promptPath(name), { method: "DELETE" });
  }

  function setPromptsStatus(message) {
    var box = document.getElementById("prompts-status");
    box.hidden = !message;
    box.textContent = message || "";
  }

  function promptsError(what) {
    return function (err) { setPromptsStatus(what + " failed: " + err.message); };
  }

  // Run a prompt mutation while its buttons are locked: disable them, do the
  // PUT/DELETE, set the status via onOk/promptsError(what), then re-enable.
  function runPromptAction(buttons, work, what, onOk) {
    buttons.forEach(function (b) { b.disabled = true; });
    return work()
      .then(onOk)
      .catch(promptsError(what))
      .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  }

  // An info icon that reveals its hint text on hover/focus — the "when to use
  // this" help. Built with createElementNS (el() can't set the SVG namespace);
  // the tip text goes in via textContent (never innerHTML).
  function infoIcon(hintText) {
    var span = el("span", "info");
    span.tabIndex = 0;
    span.setAttribute("role", "note");
    span.appendChild(svgInfo());
    span.appendChild(el("span", "tip", hintText));
    return span;
  }

  // One prompt cell: a sub-label (+ hint icon, + read-only tag), a textarea, and
  // Save/Delete for editable slots. Records slot._ta for loadPrompts to fill.
  function promptCell(slot) {
    var cell = el("div", "prompt-cell");
    var ph = el("div", "ph");
    if (slot.subKey) ph.appendChild(el("span", "nm", t(slot.subKey)));
    ph.appendChild(infoIcon(t(slot.hintKey)));
    if (slot.agent) ph.appendChild(el("span", "ro-tag", t("prompt.readonly")));
    ph.appendChild(el("div", "spacer"));
    cell.appendChild(ph);

    var ta = el("textarea", "prompt-ta");
    ta.spellcheck = false;
    cell.appendChild(ta);

    if (slot.agent) {
      ta.readOnly = true;
      ta.placeholder = t("prompt.notSetRo");
    } else {
      ta.placeholder = t("prompt.notSet");
      var actions = el("div", "prompt-actions");
      var save = el("button", "btn sm primary", t("common.save"));
      var del = el("button", "btn ghost sm del", t("common.delete"));
      save.addEventListener("click", function () {
        runPromptAction([save, del], function () { return putPromptText(slot.name, ta.value); },
          "Save", function () { setPromptsStatus(""); });
      });
      del.addEventListener("click", function () {
        runPromptAction([save, del], function () { return deletePromptEntry(slot.name); },
          "Delete", function () { ta.value = ""; setPromptsStatus(""); });
      });
      actions.appendChild(save);
      actions.appendChild(del);
      cell.appendChild(actions);
    }

    slot._ta = ta;
    return cell;
  }

  // Build the 3 prompt cards (record / live / custom prompt), each with a title bar
  // and a grid of its slots. loadPrompts fills the textareas.
  function renderGuidance() {
    var host = document.getElementById("prompt-cards");
    clear(host);
    PROMPT_CARDS.forEach(function (card) {
      var el0 = el("div", "card prompt-card");
      var head = el("div", "panel-head");
      head.appendChild(el("h3", null, t(card.titleKey)));
      el0.appendChild(head);
      var grid = el("div", "prompt-grid");
      card.slots.forEach(function (slot) { grid.appendChild(promptCell(slot)); });
      el0.appendChild(grid);
      host.appendChild(el0);
    });
  }

  function openPrompts() {
    showView("prompts");
    renderGuidance();
    loadPrompts();
  }

  // ── perspectives ──────────────────────────────────────────────────────
  // A read-mostly coverage inventory the CLI generates ("ccqa perspectives" /
  // record); the hub UI's only write path is the per-case note (PATCH). The
  // whole document is fetched once per view-open and filtered/rendered
  // client-side — small enough that there is no pagination.

  // "rerun" is the RerunReport for the currently selected profile, or null when
  // this hub can't answer (older hub, or the fetch failed) — in which case the
  // three re-run columns are dropped rather than filled with blanks.
  // "rerunSupported" is tri-state: null until the first answer, then whether
  // this hub answers at all. Chip visibility follows it rather than the report,
  // so switching profile doesn't drop the filter while the next one loads.
  // "drift" is the DriftLedgerResponse, or null when unanswered (older hub, or
  // a failed fetch) — not profile-scoped, so it does not reset when the
  // profile switcher changes (unlike "rerun" above). Only feeds the audit
  // column's "audited at" line now; its own finding is superseded by rr.audit.
  var perspState = {
    doc: null, q: "", f: "all",
    rerun: null, rerunSupported: null, runUrls: {}, rerunProfiles: [],
    drift: null
  };

  function perspectivesPath() {
    return "/api/v1/projects/" + encodeURIComponent(state.project) + "/perspectives";
  }

  // GET the perspectives document. Resolves null on 404 (no document stored
  // yet — the normal "nothing recorded" state) instead of throwing, so
  // loadPerspectives can tell that apart from a real fetch/parse failure.
  function fetchPerspectives() {
    return fetch(perspectivesPath(), { headers: { Authorization: "Bearer " + state.token } }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      return res.json();
    }, function () { throw new Error("Network unreachable — check the hub URL and your connection"); });
  }

  // ── perspectives: needs re-run (ADR-0010) ─────────────────────────────
  // "Is this case's last result still trustworthy?" — mechanical, no model
  // call, and a different question from drift ("does the case still describe
  // the product"). The two vocabularies stay apart on purpose: this column
  // never says stale or fresh, and never borrows drift's wording.
  //
  // The verdict is per (project, profile): two environments sit at different
  // commits, so it has no profile-free answer — hence the profile selector in
  // this tab's toolbar.

  function rerunPath() {
    return "/api/v1/projects/" + encodeURIComponent(state.project) +
      "/rerun?profile=" + encodeURIComponent(state.profile);
  }

  // Resolves { report } or { note } and never rejects: a hub that predates
  // the endpoint costs only the columns it feeds, not the whole tab. A 404
  // here can only mean "no such route" — the endpoint's own 404 is "the
  // project has no perspectives document", and this runs only after that
  // document loaded.
  function fetchLedgerColumn(path, i18nPrefix) {
    return fetch(path, { headers: { Authorization: "Bearer " + state.token } }).then(function (res) {
      if (res.status === 404) return { note: t(i18nPrefix + "unsupported"), kind: "info" };
      if (!res.ok) return { note: t(i18nPrefix + "loadFailed") + ": " + res.status + " " + res.statusText, kind: "warn" };
      return res.json().then(function (report) { return { report: report }; }, function () {
        return { note: t(i18nPrefix + "loadFailed"), kind: "warn" };
      });
    }, function () {
      return { note: t(i18nPrefix + "loadFailed"), kind: "warn" };
    });
  }

  // ── perspectives: drift ledger ────────────────────────────────────────
  // Not profile-scoped (see perspState.drift above), so unlike rerunPath this
  // takes no ?profile=. Its own finding is superseded by the audit axis in
  // the /rerun report (ADR-0014); what survives into the view is only its
  // coordinate — when a spec was last audited — folded into the audit
  // column's evidence line (perspAuditCell).

  function driftPath() {
    return "/api/v1/projects/" + encodeURIComponent(state.project) + "/drift";
  }

  // The ledger records a runId but no link, and the profile list the Secrets
  // tab keeps is the wrong set here (a profile that only has variables has no
  // runs and no deploys to judge). One runs page answers both: runId -> CI URL,
  // and the profiles a run was actually recorded under. A run pushed without a
  // profile lands in "default", exactly as the ledger stores it.
  //
  // Only the two kinds a ledger entry can point at, so recordings — which
  // advance no ledger and are never looked up here — cannot crowd them out of
  // the window.
  function fetchRunIndex() {
    return apiFetch("/api/v1/runs?project=" + encodeURIComponent(state.project) + "&kind=run,drift&limit=200")
      .then(function (data) {
        var urls = {};
        var profiles = [];
        ((data && data.runs) || []).forEach(function (r) {
          if (r.runUrl) urls[r.id] = r.runUrl;
          var p = r.profile || "default";
          if (profiles.indexOf(p) === -1) profiles.push(p);
        });
        return { urls: urls, profiles: profiles.sort() };
      })
      .catch(function () { return { urls: {}, profiles: [] }; });
  }

  // Profiles worth offering in this tab's selector: only those a run has been
  // recorded under. The current one is always included so the menu can show
  // what is selected even before any run exists.
  function perspProfileNames() {
    var names = perspState.rerunProfiles.slice();
    if (names.indexOf(state.profile) === -1) names.push(state.profile);
    return names.sort();
  }

  function perspSpecKey(feature, spec) {
    return feature.featureName + "/" + spec.specName;
  }

  // Shared by rerun and drift, which differ only in which report they read.
  function ledgerEntryFor(report, feature, spec) {
    return report && report.specs ? (report.specs[perspSpecKey(feature, spec)] || null) : null;
  }

  // A reason a newer hub added but this UI has no wording for must still say
  // something honest instead of printing a raw i18n key (t() returns the key
  // when it has no entry).
  function rerunReasonText(prefix, reason) {
    var text = t(prefix + reason);
    return text === prefix + reason ? t(prefix + "unrecognized") : text;
  }

  // Every verdict that carries no evidence row explains itself here, in the
  // actionable phrasing the detail panel wants. decide() checks heldBy before
  // the audit axis, so a spec another job already holds must be explained by
  // that hold, not by the audit-hole annotation below — which only applies to
  // an "inProgress" verdict that decide() reached by falling through to a due
  // audit (ADR-0014). A verdict a newer hub invented falls through to the fix
  // lookup, so the row says the UI cannot read it rather than going blank —
  // which looks like missing data.
  function rerunWhyVerdict(rr) {
    if (rr.verdict === "needsRepair") return rerunReasonText("perspectives.rerun.repair.", rerunRepairCause(rr));
    if (rr.verdict === "rerunNeeded" && rr.executionAssumedReached) {
      return rerunReasonText("perspectives.rerun.fix.", rr.executionAssumedReached);
    }
    if (rr.verdict === "inProgress") {
      if (rr.heldBy) return t("perspectives.rerun.heldHint");
      return rr.auditAssumedReached
        ? rerunReasonText("perspectives.rerun.fix.", rr.auditAssumedReached)
        : t("perspectives.rerun.inProgressHint");
    }
    return rerunReasonText("perspectives.rerun.fix.", rr.verdict);
  }

  // Which axis put this case in "needs repair". The three go to different
  // people — a re-record, a spec rewrite, a look at the failure — so the badge
  // must not stop at "needs repair".
  function rerunRepairCause(rr) {
    if (rr.audit === "drifted") return rr.driftLabel === "SPEC_CHANGE" ? "specChange" : "testDrift";
    if (rr.audit === "undecided") return "auditUndecided";
    return "runFailed";
  }

  // The short justification a table cell carries under its badge. Nothing here
  // may collapse to a bare "up to date" — verified names the deploy it was
  // judged against, and a spec assumed reached names the hole that made it so
  // rather than claiming a deploy matched it.
  function rerunCellWhy(rr) {
    var head = perspState.rerun && perspState.rerun.deployHead;
    if (rr.verdict === "rerunNeeded") {
      if (rr.executionAssumedReached) return rerunReasonText("perspectives.rerun.why.", rr.executionAssumedReached);
      if (!rr.touchedBy || !rr.touchedBy.length) return t("perspectives.rerun.touchedUnknown");
      return t("perspectives.rerun.touchedCount").replace("{n}", String(rr.touchedBy.length));
    }
    if (rr.verdict === "verified") {
      if (!head) return t("perspectives.rerun.noDeployHead");
      return t("perspectives.rerun.vsDeploy") + " " + shortSha(head.sha) + " · " + relTime(head.at);
    }
    return rerunWhyVerdict(rr);
  }


  // --- pure: rerun composition ---------------------------------------------
  // Self-contained on purpose: no DOM, no closures. rerun-view.test.ts lifts
  // this region out of the rendered page and runs it, because the summary bar
  // is where an overstatement would do the most damage and the suite has no
  // browser to click through.

  // Bar segments in drawing order: what a person must act on first, then what
  // the pipeline still owes, then what needs nothing. "needsRepair" leads
  // because it is the only verdict a run cannot clear — someone has to repair
  // the spec or the product.
  var RERUN_ORDER = ["needsRepair", "rerunNeeded", "inProgress", "verified"];
  var RERUN_SEG_CLASS = {
    needsRepair: "sg-needsrepair", rerunNeeded: "sg-rerunneeded",
    inProgress: "sg-inprogress", verified: "sg-verified"
  };

  // The one rule the summary bar and the verdict filter chips both answer
  // to: a case with no verdict, or a verdict a newer hub invented, counts as
  // needing a run — unanswered means unverified (ADR-0014). Both call this
  // rather than each keeping its own copy of the fallback.
  function rerunVerdictOf(rr) {
    var v = rr && rr.verdict;
    return v && RERUN_ORDER.indexOf(v) !== -1 ? v : "rerunNeeded";
  }

  // One verdict per case, bucketed, via rerunVerdictOf above.
  function rerunComposition(verdicts) {
    var counts = { needsRepair: 0, rerunNeeded: 0, inProgress: 0, verified: 0 };
    verdicts.forEach(function (rr) { counts[rerunVerdictOf(rr)] += 1; });
    return counts;
  }

  // Only verdicts with cases in them get drawn, which keeps the legend short
  // and stops an empty one from reading as a verdict: a "needs re-run 0"
  // printed for a profile nothing has been evaluated on is that misreading.
  function rerunSegments(counts) {
    var out = [];
    RERUN_ORDER.forEach(function (key) {
      if (counts[key] > 0) out.push({ state: key, count: counts[key], cls: RERUN_SEG_CLASS[key] });
    });
    return out;
  }
  // --- end pure: rerun composition -----------------------------------------

  // --- pure: execution composition ------------------------------------------
  // Same shape as rerun composition above, self-contained for the same
  // reason, and read from the same rr records: bucketed by the execution
  // axis rather than the derived verdict. The mapping duplicates
  // perspRunState's two renames (neverRun -> never, stale -> superseded)
  // rather than calling it, so this region stays independently liftable.
  var EXEC_ORDER = ["failed", "superseded", "never", "passed"];
  var EXEC_SEG_CLASS = {
    failed: "sg-exec-failed", superseded: "sg-exec-stale",
    never: "sg-exec-never", passed: "sg-exec-passed"
  };

  // A case with no verdict at all reads as never run — same "unanswered
  // means unverified" rule rerunComposition applies, and the safe direction:
  // it never inflates "passed".
  function executionComposition(records) {
    var counts = { failed: 0, superseded: 0, never: 0, passed: 0 };
    records.forEach(function (rr) {
      var exec = rr && rr.execution;
      var key = !exec || exec === "neverRun" ? "never" : exec === "stale" ? "superseded" : exec;
      counts[Object.prototype.hasOwnProperty.call(counts, key) ? key : "never"] += 1;
    });
    return counts;
  }

  // Only states with cases in them get drawn — see rerunSegments' comment above.
  function executionSegments(counts) {
    var out = [];
    EXEC_ORDER.forEach(function (key) {
      if (counts[key] > 0) out.push({ state: key, count: counts[key], cls: EXEC_SEG_CLASS[key] });
    });
    return out;
  }
  // --- end pure: execution composition --------------------------------------

  // --- pure: audit composition -----------------------------------------------
  // Same shape again, bucketed by the audit axis (ADR-0014).
  var AUDIT_ORDER = ["drifted", "undecided", "due", "clean"];
  var AUDIT_SEG_CLASS = {
    drifted: "sg-audit-drifted", undecided: "sg-audit-undecided",
    due: "sg-audit-due", clean: "sg-audit-clean"
  };

  // A case with no audit axis at all reads as due — the same "unanswered
  // means not yet cleared" rule as the other two axes.
  function auditComposition(records) {
    var counts = { drifted: 0, undecided: 0, due: 0, clean: 0 };
    records.forEach(function (rr) {
      var key = (rr && rr.audit) || "due";
      counts[Object.prototype.hasOwnProperty.call(counts, key) ? key : "due"] += 1;
    });
    return counts;
  }

  // Only states with cases in them get drawn — see rerunSegments' comment above.
  function auditSegments(counts) {
    var out = [];
    AUDIT_ORDER.forEach(function (key) {
      if (counts[key] > 0) out.push({ state: key, count: counts[key], cls: AUDIT_SEG_CLASS[key] });
    });
    return out;
  }
  // --- end pure: audit composition --------------------------------------------

  // One ledger entry as "<short sha> · <when>", linking to the hub's run detail
  // and, when that run recorded one, to the CI run. Clicks must not bubble: the
  // table row itself toggles the detail panel.
  function ledgerLine(entry) {
    var wrap = el("span");
    var link = el("a", null, shortSha(entry.gitHead) || String(entry.runId).slice(0, 8));
    link.href = "#/runs/" + encodeURIComponent(entry.runId);
    link.title = t("perspectives.result.openRun");
    link.addEventListener("click", function (e) { e.stopPropagation(); });
    wrap.appendChild(link);
    wrap.appendChild(document.createTextNode(" · " + relTime(entry.at)));
    var ciUrl = perspState.runUrls[entry.runId];
    if (ciUrl) {
      wrap.appendChild(document.createTextNode(" · "));
      var ci = el("a", null, t("perspectives.result.ci"));
      ci.href = ciUrl;
      ci.target = "_blank";
      ci.rel = "noopener";
      ci.addEventListener("click", function (e) { e.stopPropagation(); });
      wrap.appendChild(ci);
    }
    return wrap;
  }

  // The last recorded outcome, as { status, entry }. The ledger advances "run"
  // on every non-skipped result and "green"/"red" on the matching one, so the
  // last run is whichever of those two carries the same runId.
  //
  // A ledger written before the "run" bucket existed carries greens only, and
  // migrates that way — so with no "run" entry, fall back to the newer of
  // green/red. Both are real results; ignoring them would print "never run"
  // for a case whose last-passed coordinate is right there in the detail row.
  function lastResult(rr) {
    if (!rr) return null;
    if (rr.lastRun) {
      // "" when neither bucket carries this runId: the run is recorded but its
      // outcome is not, so the cell shows the coordinate without a verdict.
      var status = "";
      if (rr.lastGreen && rr.lastGreen.runId === rr.lastRun.runId) status = "passed";
      else if (rr.lastRed && rr.lastRed.runId === rr.lastRun.runId) status = "failed";
      return { status: status, entry: rr.lastRun };
    }
    if (rr.lastGreen && rr.lastRed) {
      return rr.lastGreen.at >= rr.lastRed.at
        ? { status: "passed", entry: rr.lastGreen }
        : { status: "failed", entry: rr.lastRed };
    }
    if (rr.lastGreen) return { status: "passed", entry: rr.lastGreen };
    if (rr.lastRed) return { status: "failed", entry: rr.lastRed };
    return null;
  }

  // The execution axis as one state. "What did it say last time" and "is that
  // still true" are two faces of one question, so the row answers it once and
  // the detail panel keeps the coordinates.
  //
  // --- pure: run-state labels ----------------------------------------------
  // Self-contained (no DOM, no closures) so rerun-view.test.ts can lift it and
  // check that every execution value the hub can send has a badge and wording.

  // A recorded failure outranks the deploy that landed after it: a red result
  // is current information, and repeating it teaches nothing until someone
  // repairs it.
  //
  // The wording keys are not the axis values: ADR-0010 reserves the freshness
  // adjectives for drift, so what the schema calls "stale" is shown as what it
  // means for this case — it has not run since the deploy.
  function perspRunState(rr) {
    if (!rr || !rr.execution) return null;
    if (rr.execution === "neverRun") return "never";
    return rr.execution === "stale" ? "superseded" : rr.execution;
  }

  // Reuses the badge classes that already mean these things elsewhere rather
  // than minting a parallel palette: amber for "act on this", and the run
  // status colours for a result that still stands.
  var RUN_STATE_BADGE = { failed: "failed", passed: "passed", superseded: "rr-needed", never: "rr-none" };
  // --- end pure: run-state labels -------------------------------------------

  // The primary column. The two axes beside it answer "why"; this one answers
  // "who acts next", which is the only question a reader scanning a list of
  // specs has. Exactly one value, needsRepair, asks for a person.
  // Same colours the summary bar uses, so a row and the bar above it cannot
  // disagree. needsRepair is the only verdict that asks for a person, so it
  // takes the attention colour and re-running — machine work — does not.
  var VERDICT_BADGE = {
    needsRepair: "rr-repair", rerunNeeded: "rr-needed",
    inProgress: "rr-none", verified: "passed"
  };

  function perspVerdictCell(rr) {
    var td = el("td");
    if (!rr || !rr.verdict) {
      // In the document but not in the report — added since it was computed.
      td.appendChild(el("span", "muted", "\u2014"));
      return td;
    }
    var badge = el("span", "badge " + (VERDICT_BADGE[rr.verdict] || "rr-unknown"));
    badge.appendChild(el("span", "d"));
    badge.appendChild(document.createTextNode(" " + t("perspectives.rerun.state." + rr.verdict)));
    td.appendChild(badge);
    var why = rerunCellWhy(rr);
    if (why) td.appendChild(el("span", "cellsub", why));
    return td;
  }

  // A reason that pinned a spec to a pending state without a demonstrable
  // deploy touch (ADR-0014, auditAssumedReached / executionAssumedReached).
  // The short form is always visible as a .cellsub; the title attribute
  // carries the longer, actionable form for hover, so what closes the hole
  // is available without depending on a pointer to find it.
  function assumedReachedSub(reason) {
    var sub = el("span", "cellsub", rerunReasonText("perspectives.rerun.why.", reason));
    sub.title = rerunReasonText("perspectives.rerun.fix.", reason);
    return sub;
  }

  // Axis 1, as the hub derived it against the deployed commit — fresher than
  // the raw drift ledger, whose entry may predate the deploy. The ledger
  // survives here only as the "audited at" coordinate (ledgerLine below):
  // its own finding is superseded by rr.audit/rr.driftLabel above, so
  // showing both would repeat one answer in two vocabularies — the bug this
  // column used to have paired with a since-removed fourth column.
  var AUDIT_BADGE = {
    due: "rr-none", clean: "passed", drifted: "failed", undecided: "rr-unknown"
  };

  function perspAuditCell(rr, driftEntry) {
    var td = el("td");
    if (!rr || !rr.audit) {
      td.appendChild(el("span", "muted", "\u2014"));
      return td;
    }
    var badge = el("span", "badge " + (AUDIT_BADGE[rr.audit] || "rr-unknown"));
    badge.appendChild(el("span", "d"));
    badge.appendChild(document.createTextNode(" " + t("perspectives.audit.state." + rr.audit)));
    td.appendChild(badge);
    if (rr.audit === "drifted" && rr.driftLabel) {
      td.appendChild(el("span", "cellsub", labelText(rr.driftLabel)));
    } else if (rr.auditAssumedReached) {
      // Due because the log could not place the audit, not because a deploy
      // demonstrably reached it. Say which, or the whole column reads "due"
      // with no cause anywhere on the page.
      td.appendChild(assumedReachedSub(rr.auditAssumedReached));
    }
    // "audited at sha · when" — the same freshness evidence the execution
    // column gives its own last result, below. SpecRerun does not carry the
    // audit's own coordinate, so it comes from the drift ledger.
    if (driftEntry) {
      var sub = el("span", "cellsub");
      sub.appendChild(ledgerLine(driftEntry));
      if (driftEntry.graded) {
        sub.appendChild(document.createTextNode(" · "));
        sub.appendChild(el("span", "graded-mark", t("perspectives.drift.graded")));
      }
      td.appendChild(sub);
    }
    return td;
  }

  function perspRunCell(rr) {
    var td = el("td");
    var runState = perspRunState(rr);
    // No verdict at all: this case is in the document but not in the report
    // (added since it was computed). Not the same statement as "never run".
    if (!runState) {
      td.appendChild(el("span", "muted", "\u2014"));
      return td;
    }
    var badge = el("span", "badge " + RUN_STATE_BADGE[runState]);
    badge.appendChild(el("span", "d"));
    badge.appendChild(document.createTextNode(" " + t("perspectives.run.state." + runState)));
    td.appendChild(badge);

    // What the failure was, as the run's analysis called it — the same place
    // the audit column names its drift label. Absent on a red entry the run
    // never analyzed, and on entries written before the ledger carried it.
    if (runState === "failed" && rr.lastRed && rr.lastRed.label) {
      var cause = el("span", "cellsub", labelText(rr.lastRed.label));
      // The one-line conclusion, for a pointer. The detail panel shows it in
      // full, so nothing here depends on finding it.
      if (rr.lastRed.headline) cause.title = rr.lastRed.headline;
      td.appendChild(cause);
    }

    // The sub-line is the coordinate of the result being reported — the same
    // "when is this from" evidence the audit column carries above, so the two
    // axes read as siblings. Why the currency matters belongs to the verdict
    // column, except for the hole that pinned this to "pending" with no
    // deploy to point at.
    if (runState !== "never") {
      var last = lastResult(rr);
      if (last) {
        var sub = el("span", "cellsub");
        sub.appendChild(ledgerLine(last.entry));
        td.appendChild(sub);
      }
    }
    if (rr.executionAssumedReached) td.appendChild(assumedReachedSub(rr.executionAssumedReached));
    return td;
  }

  // A list of paths/globs as <code> chips. A flex row, so a list that does not
  // fit wraps between chips instead of breaking inside a path.
  function pathCodes(paths) {
    var wrap = el("span", "d-paths");
    paths.forEach(function (p) { wrap.appendChild(el("code", null, p)); });
    return wrap;
  }

  // The execution mode lives inside the mechanically-derived status object
  // (spec.status.mode), not at the top level of a spec entry.
  function perspMode(spec) {
    return spec.status && spec.status.mode === "live" ? "live" : "deterministic";
  }

  function setPerspStatus(message) {
    var box = document.getElementById("persp-status");
    box.hidden = !message;
    box.textContent = message || "";
  }

  function perspModeChip(mode) {
    var span = el("span", "chip" + (mode === "live" ? " live" : ""));
    span.textContent = t(mode === "live" ? "perspectives.mode.live" : "perspectives.mode.deterministic");
    return span;
  }

  // One axis of the overview: a label, then the bar+legend shape the summary
  // used to render just once (see .rrbar/.rrleg in the stylesheet) — re-run
  // and drift each get their own row rather than sharing one bar, since they
  // answer different questions and a single composite would blur both.
  function ovAxisRow(label, segments, statePrefix, total) {
    var row = el("div", "ov-axis");
    row.appendChild(el("div", "ov-axis-label", label));
    var bar = el("div", "rrbar");
    var leg = el("div", "rrleg");
    segments.forEach(function (seg) {
      var fill = el("div", seg.cls);
      fill.style.width = (seg.count / total) * 100 + "%";
      bar.appendChild(fill);
      var item = el("span");
      item.appendChild(el("i", seg.cls));
      item.appendChild(document.createTextNode(t(statePrefix + seg.state)));
      item.appendChild(el("b", null, String(seg.count)));
      leg.appendChild(item);
    });
    row.appendChild(bar);
    row.appendChild(leg);
    return row;
  }

  // Summary: the inventory as one line, then one row per axis — verdict,
  // execution, audit, the same three groupings the table's columns show, so
  // the bars and the table never disagree about what a word means. The mode
  // and recorded-ness counts are not lost; they moved onto the filter chips,
  // where a count states what that filter would leave behind.
  //
  // With no re-run data (an older hub, a failed fetch, or a profile nothing
  // has been recorded on) every case is "not evaluated" and all three bars
  // are omitted together, rather than showing a composition that reads as
  // "nothing to do".
  function renderPerspOverview(doc) {
    var host = document.getElementById("persp-ov");
    clear(host);
    var records = [];
    doc.features.forEach(function (feature) {
      feature.specs.forEach(function (spec) {
        records.push(ledgerEntryFor(perspState.rerun, feature, spec));
      });
    });

    var inv = el("div", "ov-inv");
    inv.appendChild(el("b", null, String(records.length)));
    inv.appendChild(document.createTextNode(" " + t("perspectives.ov.cases") + " / "));
    inv.appendChild(el("b", null, String(doc.features.length)));
    inv.appendChild(document.createTextNode(" " + t("perspectives.ov.features")));
    host.appendChild(inv);
    if (!records.length) return;

    // Gated on the report as a whole: with none, none of the three axes has
    // anything to compose, and an un-composed bar would paint every case as
    // needing work — an overstatement about the hub rather than about the
    // specs.
    if (perspState.rerun) {
      host.appendChild(ovAxisRow(
        t("perspectives.col.verdict"), rerunSegments(rerunComposition(records)), "perspectives.rerun.state.", records.length,
      ));
      host.appendChild(ovAxisRow(
        t("perspectives.col.run"), executionSegments(executionComposition(records)), "perspectives.run.state.", records.length,
      ));
      host.appendChild(ovAxisRow(
        t("perspectives.col.audit"), auditSegments(auditComposition(records)), "perspectives.audit.state.", records.length,
      ));
    }
  }

  // The filter is passed in rather than read from perspState so the same
  // predicate can answer "what would this chip yield?" for every chip. The
  // search text always applies: a chip's count has to be the number of rows
  // clicking it actually leaves.
  function perspMatches(feature, spec, f) {
    if (f === "deterministic" && perspMode(spec) !== "deterministic") return false;
    if (f === "live" && perspMode(spec) !== "live") return false;
    // The verdict chips (same words as RERUN_ORDER/the 判定 column) share
    // rerunVerdictOf with the summary bar, so an unrecognised verdict is
    // "rerunNeeded" in both places rather than matching no chip. With no
    // report at all there is nothing to filter on, so every chip yields
    // nothing.
    if (RERUN_ORDER.indexOf(f) !== -1) {
      if (!perspState.rerun) return false;
      var rr = ledgerEntryFor(perspState.rerun, feature, spec);
      if (rerunVerdictOf(rr) !== f) return false;
    }
    if (perspState.q) {
      var hay = (spec.title + " " + (spec.summary || "") + " " + spec.specName).toLowerCase();
      if (hay.indexOf(perspState.q) === -1) return false;
    }
    return true;
  }

  function perspFilterCount(f) {
    var doc = perspState.doc;
    if (!doc) return 0;
    var n = 0;
    doc.features.forEach(function (feature) {
      feature.specs.forEach(function (spec) { if (perspMatches(feature, spec, f)) n += 1; });
    });
    return n;
  }

  // --- pure: rerun detail labels -------------------------------------------
  // Self-contained on purpose (no DOM, no closures) so rerun-view.test.ts can
  // lift this region out of the rendered page and run it: which label the
  // panel's evidence row wears, and whether it has a failure row at all.

  // The deploy log answered for this case: the row can show what it holds.
  // A case the log could not place has no evidence to show even though its
  // verdict is the same — the assumption is the answer, not a finding.
  function rerunHasEvidence(rr) {
    if (rr.verdict === "verified") return true;
    return rr.verdict === "rerunNeeded" && !rr.executionAssumedReached;
  }

  // Evidence is labelled by the timeframe it covers; everything else names why
  // the verdict landed — a different kind of content, and forcing one label
  // over both would make one of the two read as a lie.
  function rerunEvidenceLabelKey(rr) {
    return rerunHasEvidence(rr) ? "perspectives.d.changedSince" : "perspectives.d.whyVerdict";
  }

  // The failure row points at a run. With no failure there is nothing to point
  // at, so the row is omitted rather than filled with "never failed" — the row
  // above already carries the last result.
  function rerunHasFailure(rr) {
    return !!(rr && rr.lastRed);
  }

  // Which deploy the evidence line names, and how. A "needed" verdict carries
  // the deploy that caused it (touchedByDeploy) when the hub could confirm one,
  // and that is the deploy a reader wants — so it is named, with when it
  // landed. Without it (an older hub, or an entry the log no longer retains)
  // the only deploy coordinate on hand is the report's head, which is the point
  // the judgement was made at and not a cause: it keeps the weaker wording.
  // "at" is set only when the line names a cause, so the caller knows whether a
  // timestamp belongs on it.
  function rerunChangeLine(rr, deployHead) {
    var cause = rr.verdict === "rerunNeeded" && rr.touchedByDeploy ? rr.touchedByDeploy : null;
    if (cause && cause.sha) return { key: "perspectives.rerun.changedByDeploy", sha: cause.sha, at: cause.at };
    if (!deployHead) return { key: "perspectives.rerun.noDeployHead", sha: null, at: null };
    return {
      key: rr.verdict === "rerunNeeded" ? "perspectives.rerun.changesSome" : "perspectives.rerun.changesNone",
      sha: deployHead.sha,
      at: null,
    };
  }
  // --- end pure: rerun detail labels ----------------------------------------

  // The evidence behind the verdict, as the value of whichever row
  // rerunEvidenceLabelKey chose. For needed/notNeeded that is what the deploy
  // log holds since this case last ran, named by rerunChangeLine.
  // The label already states the timeframe, so the value never repeats it.
  function rerunEvidenceValue(rr) {
    var wrap = el("div");
    if (!rerunHasEvidence(rr)) {
      wrap.appendChild(el("div", "d-prose", rerunWhyVerdict(rr)));
      return wrap;
    }
    // Both states require a non-empty deploy log, so a head-less report
    // contradicts itself; rerunChangeLine then names what is missing rather
    // than inventing a baseline.
    var line = rerunChangeLine(rr, perspState.rerun && perspState.rerun.deployHead);
    var text = t(line.key).replace("{sha}", shortSha(line.sha));
    if (line.at) text += " · " + relTime(line.at);
    wrap.appendChild(el("div", "d-prose", text));
    // A touch the index proved but cannot enumerate leaves no paths to list;
    // the line above still says a change landed, which is all that is known.
    if (rr.verdict === "rerunNeeded" && rr.touchedBy && rr.touchedBy.length) {
      wrap.appendChild(pathCodes(rr.touchedBy));
    }
    return wrap;
  }

  // The failure: which run it was, then what the analysis concluded. The
  // headline is model output, already localized server-side, so it is shown as
  // written. A run made without failure analysis carries neither field, and the
  // row is then the coordinate alone — what it has always been.
  function rerunFailureValue(entry) {
    var wrap = el("div");
    wrap.appendChild(ledgerLine(entry));
    if (entry.label) {
      var line = el("div", "d-prose", labelText(entry.label));
      if (entry.headline) line.appendChild(document.createTextNode(" · " + entry.headline));
      wrap.appendChild(line);
    }
    return wrap;
  }

  // Detail row: a definition list of the case's fields plus the note editor.
  // Built with createElement/textContent throughout — every field here is
  // API-derived, so none of it may go through innerHTML.
  //
  // The panel shows only what the table row cannot. The row already carries the
  // title, mode, recorded state, last result and the re-run verdict, so none of
  // those is repeated: what is left is the case's definition, the evidence the
  // verdict rests on, and the note.
  function perspDetailContent(feature, spec) {
    var frag = document.createDocumentFragment();
    var dl = el("dl", "d-grid");
    function row(labelKey, valueNode) {
      dl.appendChild(el("dt", null, t(labelKey)));
      var dd = el("dd");
      // Prose gets a measure; a node brings its own layout.
      if (typeof valueNode === "string") dd.appendChild(el("div", "d-prose", valueNode));
      else dd.appendChild(valueNode);
      dl.appendChild(dd);
    }
    if (spec.preconditions && spec.preconditions.length) {
      var ul = el("ul");
      spec.preconditions.forEach(function (p) { ul.appendChild(el("li", null, p)); });
      row("perspectives.d.preconditions", ul);
    }
    if (spec.startScreen) row("perspectives.d.startScreen", spec.startScreen);
    if (spec.testCondition) row("perspectives.d.testCondition", spec.testCondition);
    // The spec id stays: it is what a user types to re-run this case, and the
    // table shows the title, never the id.
    row("perspectives.d.spec", el("code", null, spec.specName));

    var rr = ledgerEntryFor(perspState.rerun, feature, spec);
    if (rr) {
      row(rerunEvidenceLabelKey(rr), rerunEvidenceValue(rr));
      if (rerunHasFailure(rr)) row("perspectives.d.lastRed", rerunFailureValue(rr.lastRed));
    }
    frag.appendChild(dl);

    var notebox = el("div", "notebox");
    notebox.appendChild(el("div", "nlabel", t("perspectives.note.label")));
    var ta = el("textarea");
    ta.placeholder = t("perspectives.note.placeholder");
    ta.value = spec.note || "";
    notebox.appendChild(ta);
    var nact = el("div", "nact");
    var saveBtn = el("button", "btn primary", t("common.save"));
    saveBtn.type = "button";
    var statusEl = el("span", "nstatus");
    nact.appendChild(saveBtn);
    nact.appendChild(statusEl);
    notebox.appendChild(nact);
    frag.appendChild(notebox);

    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      statusEl.className = "nstatus";
      statusEl.textContent = "";
      apiFetch(perspectivesPath(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feature: feature.featureName, spec: spec.specName, note: ta.value }),
      }).then(function () {
        spec.note = ta.value || undefined;
        statusEl.className = "nstatus ok";
        statusEl.textContent = t("perspectives.note.saved");
      }).catch(function (err) {
        statusEl.className = "nstatus err";
        statusEl.textContent = t("perspectives.note.error") + ": " + err.message;
      }).then(function () { saveBtn.disabled = false; });
    });

    return frag;
  }

  function renderPerspTable(doc) {
    var tbody = document.getElementById("persp-tbody");
    clear(tbody);
    // Hiding the <th>s (rather than emitting empty cells) leaves the table
    // exactly as it was on a hub that cannot answer the re-run question.
    var showRerun = perspState.rerun != null;
    document.getElementById("persp-th-verdict").hidden = !showRerun;
    document.getElementById("persp-th-audit").hidden = !showRerun;
    document.getElementById("persp-th-run").hidden = !showRerun;
    var cols = 3 + (showRerun ? 3 : 0);
    var hits = 0;
    doc.features.forEach(function (feature) {
      var specs = feature.specs.filter(function (s) { return perspMatches(feature, s, perspState.f); });
      if (!specs.length) return;
      hits += specs.length;

      var grpRow = el("tr", "grp");
      var grpTd = el("td");
      grpTd.colSpan = cols;
      grpTd.appendChild(document.createTextNode(feature.featureName));
      grpTd.appendChild(el("span", "gcount", specs.length + " " + t("perspectives.ov.cases")));
      grpRow.appendChild(grpTd);
      tbody.appendChild(grpRow);

      specs.forEach(function (spec) {
        var row = el("tr", "row");
        row.tabIndex = 0;
        row.setAttribute("aria-expanded", "false");

        var titleTd = el("td", "c-title");
        titleTd.appendChild(document.createTextNode(spec.title));
        if (spec.summary) titleTd.appendChild(el("span", "csum", spec.summary));
        row.appendChild(titleTd);

        var modeTd = el("td");
        modeTd.appendChild(perspModeChip(perspMode(spec)));
        row.appendChild(modeTd);

        if (showRerun) {
          var rr = ledgerEntryFor(perspState.rerun, feature, spec);
          row.appendChild(perspVerdictCell(rr));
          row.appendChild(perspRunCell(rr));
          row.appendChild(perspAuditCell(rr, ledgerEntryFor(perspState.drift, feature, spec)));
        }

        var chevTd = el("td", "c-chev");
        chevTd.appendChild(el("span", "chev-i", "\\u25b6"));
        row.appendChild(chevTd);

        var detailRow = el("tr", "detail");
        var detailTd = el("td");
        detailTd.colSpan = cols;
        detailRow.appendChild(detailTd);
        var built = false;

        function toggle() {
          var open = detailRow.classList.toggle("open");
          row.setAttribute("aria-expanded", open ? "true" : "false");
          if (open && !built) {
            detailTd.appendChild(perspDetailContent(feature, spec));
            built = true;
          }
        }
        row.addEventListener("click", function (e) {
          if (e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
          toggle();
        });
        row.addEventListener("keydown", function (e) {
          if ((e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); toggle(); }
        });

        tbody.appendChild(row);
        tbody.appendChild(detailRow);
      });
    });
    document.getElementById("persp-no-hit").hidden = hits > 0;
  }

  function renderPerspectives() {
    var doc = perspState.doc;
    if (!doc) return;
    syncPerspChips();
    renderPerspOverview(doc);
    renderPerspTable(doc);
  }

  // The verdict chip group only exists while the hub answers the re-run
  // question; otherwise every one of them would filter everything away. Drop
  // back to "all" if one was the active filter when the answer came back
  // "not supported".
  //
  // Each chip also carries what it would yield — the mode breakdown the
  // summary row used to spend four tiles on.
  function syncPerspChips() {
    var group = document.getElementById("persp-verdict-chips");
    group.hidden = perspState.rerunSupported !== true;
    if (perspState.rerunSupported !== true && RERUN_ORDER.indexOf(perspState.f) !== -1) perspState.f = "all";
    document.querySelectorAll("#view-perspectives .fchip").forEach(function (b) {
      var f = b.getAttribute("data-f");
      b.setAttribute("aria-pressed", String(f === perspState.f));
      b.querySelector(".fcount").textContent = perspState.doc ? String(perspFilterCount(f)) : "";
    });
  }

  // boxId is a parameter rather than hardcoded so a future note box can reuse
  // this without copying it — today only "persp-rerun-note" calls it.
  function setPerspNote(boxId, text, kind) {
    var box = document.getElementById(boxId);
    box.hidden = !text;
    if (!text) { clear(box); return; }
    fillNote(box, kind || "info", text, "persp-note");
  }

  function setPerspDeployHead(report) {
    var span = document.getElementById("persp-deploy-head");
    var head = report && report.deployHead;
    span.hidden = !head;
    span.textContent = head
      ? t("perspectives.rerun.deployHead") + " " + shortSha(head.sha) + " · " + relTime(head.at)
      : "";
  }

  function setPerspUpdated(doc) {
    var span = document.getElementById("persp-updated");
    if (doc && doc.generatedAt) {
      span.hidden = false;
      span.textContent = t("perspectives.updated") + " " + relTime(doc.generatedAt);
    } else {
      span.hidden = true;
      span.textContent = "";
    }
  }

  function loadPerspectives() {
    setPerspStatus("");
    document.getElementById("persp-body").hidden = true;
    setPerspUpdated(null);
    setPerspNote("persp-rerun-note", "");
    setPerspDeployHead(null);
    perspState.rerun = null;
    perspState.rerunSupported = null;
    perspState.drift = null;
    syncPerspChips();
    fetchPerspectives()
      .then(function (doc) {
        perspState.doc = doc;
        if (!doc) { setPerspStatus(t("perspectives.empty")); return; }
        setPerspUpdated(doc);
        document.getElementById("persp-body").hidden = false;
        // The inventory renders first: re-run/drift data is additive to it,
        // and a slow or absent fetch must never hold up the table.
        renderPerspectives();
        // Each scoped to its own failure message: a fault in one costs only
        // its own column(s), and reporting it as "loading perspectives
        // failed" would point at the inventory that in fact loaded fine.
        // loadRunIndex runs alongside rather than inside loadRerun: it is
        // project-scoped (see fetchRunIndex), so a profile switch must not
        // re-fetch it, and its result must not wait on the rerun report.
        return Promise.all([
          loadRunIndex(),
          loadRerun().catch(function (err) {
            setPerspNote("persp-rerun-note", t("perspectives.rerun.loadFailed") + ": " + err.message, "warn");
          }),
          // Evidence-only (the "audited at" line in the audit column) — a
          // failed or unsupported fetch just omits that line, no banner.
          loadDrift().catch(function () {}),
        ]);
      })
      .catch(function (err) {
        perspState.doc = null;
        setPerspStatus(t("perspectives.loadFailed") + ": " + err.message);
      });
  }

  function rerunScope() {
    return state.project + "/" + state.profile;
  }

  // --- pure: data-profile pick ---------------------------------------------
  // Self-contained on purpose (no DOM, no closures): the network probing this
  // feeds is what makes "has deploy data" answerable at all, but which
  // candidate wins from the results is a plain function worth pinning without
  // mocking a fetch.

  // "default" is always offered (the API guarantees it) but usually holds no
  // deploys, so opening straight into it reads as broken: every row pending,
  // a "no deploy log" banner. Fallback for when no candidate's deploy log can
  // be confirmed (a fresh project): prefer a profile the run index shows has
  // runs, with exactly one such profile the only reasonable pick.
  function pickDataProfile(current, dataProfiles) {
    if (!dataProfiles.length || dataProfiles.indexOf(current) !== -1) return current;
    return dataProfiles.length === 1 ? dataProfiles[0] : dataProfiles.slice().sort()[0];
  }

  // Every profile worth checking for deploy data, in preference order: the
  // current profile first (so an already-fine pick is left alone), then
  // run-index profiles (a profile with runs is a maintained environment),
  // then the project's full profile set. That last tier is what makes a
  // profile deploys are recorded under but nothing has ever run against
  // reachable at all — the run index alone has no way to see it.
  function dataProfileCandidates(current, dataProfiles, projectProfiles) {
    var seen = {};
    var out = [];
    [current].concat(dataProfiles, projectProfiles).forEach(function (p) {
      if (p && !seen[p]) { seen[p] = true; out.push(p); }
    });
    return out;
  }

  // The deterministic half of resolveDataProfile below: given which
  // candidates actually have a deploy log (probed in parallel, so answers can
  // arrive in any order), pick the first by candidate order, not by response
  // order — the result must not depend on network timing. Falls back to
  // pickDataProfile's answer when nothing confirms (no project has deploy
  // data yet), leaving that case's behaviour unchanged.
  function pickFirstWithDeployLog(candidates, hasLog, current, dataProfiles) {
    for (var i = 0; i < candidates.length; i++) {
      if (hasLog[i]) return candidates[i];
    }
    return pickDataProfile(current, dataProfiles);
  }
  // --- end pure: data-profile pick ------------------------------------------

  // Confirms a candidate actually has a deploy log, rather than merely being
  // known to the run index or the secrets tab — the two facts pickDataProfile
  // used to conflate (a profile can hold runs, or secrets, with no deploy log
  // at all). limit=1 makes this a cheap existence check.
  function hasDeployLog(profile) {
    return apiFetch(
      "/api/v1/projects/" + encodeURIComponent(state.project) + "/deploys?profile=" + encodeURIComponent(profile) + "&limit=1",
    ).then(function (data) { return !!(data && data.entries && data.entries.length); })
      .catch(function () { return false; });
  }

  // The candidate set from /profiles is broader than the run index (see
  // dataProfileCandidates), so probe every candidate's deploy log in
  // parallel before letting pickFirstWithDeployLog decide.
  function resolveDataProfile(current, dataProfiles, projectProfiles) {
    var candidates = dataProfileCandidates(current, dataProfiles, projectProfiles);
    return Promise.all(candidates.map(hasDeployLog))
      .then(function (hasLog) { return pickFirstWithDeployLog(candidates, hasLog, current, dataProfiles); });
  }

  // The full profile set (secrets tab's universe) is broader than the run
  // index: a profile deploys are recorded under but nothing has ever run
  // against is invisible to fetchRunIndex. Fetched independently from
  // loadProfiles, which mutates knownProfiles/state.profile as a side effect
  // the Secrets tab depends on and this must not trigger.
  function fetchProjectProfiles() {
    return apiFetch("/api/v1/projects/" + encodeURIComponent(state.project) + "/profiles")
      .then(function (data) { return (data && data.profiles) || []; })
      .catch(function () { return []; });
  }

  // Project-scoped (see fetchRunIndex) — never rejects, so this always
  // re-renders once the run index settles, whichever of the three loads in
  // loadPerspectives is slowest.
  function loadRunIndex() {
    return fetchRunIndex().then(function (result) {
      perspState.runUrls = result.urls;
      perspState.rerunProfiles = result.profiles;
      if (storedProfileForProject(state.project)) {
        renderPerspectives();
        return;
      }
      // Never overrides a choice the user made explicitly (the check above)
      // — this only fills in the very first, unopinionated default.
      return fetchProjectProfiles()
        .then(function (projectProfiles) { return resolveDataProfile(state.profile, result.profiles, projectProfiles); })
        .then(function (pick) {
          if (pick !== state.profile) {
            setProfile(pick);
            renderPerspectives();
            return reloadRerun();
          }
          renderPerspectives();
        });
    });
  }

  function loadRerun() {
    var scope = rerunScope();
    return fetchLedgerColumn(rerunPath(), "perspectives.rerun.").then(function (rerun) {
      // A second profile pick can land while this one is still in flight; the
      // older response must not overwrite the newer scope's verdicts.
      if (scope !== rerunScope()) return;
      perspState.rerun = rerun.report || null;
      perspState.rerunSupported = perspState.rerun != null;
      setPerspDeployHead(perspState.rerun);
      if (rerun.note) {
        setPerspNote("persp-rerun-note", rerun.note, rerun.kind);
      } else if (perspState.rerun && !perspState.rerun.deployHead) {
        // With no deploy log nothing can be placed, so every case is assumed
        // reached. Say once, at the top, what is missing and how to supply it,
        // rather than repeating it on every row.
        setPerspNote("persp-rerun-note", t("perspectives.rerun.noDeployLogBanner").replace("{profile}", state.profile), "warn");
      } else {
        setPerspNote("persp-rerun-note", "");
      }
      renderPerspectives();
    });
  }

  // Loaded once per project open — never re-run on a profile switch, since
  // drift carries no profile (unlike loadRerun/reloadRerun below). Only the
  // ledger's own coordinate (when a spec was last audited) survives into the
  // view now — its finding is superseded by the fresher, deploy-aware audit
  // axis in the /rerun report — so there is nothing here worth a banner on
  // an older or unreachable hub.
  function loadDrift() {
    return fetch(driftPath(), { headers: { Authorization: "Bearer " + state.token } })
      .then(function (res) { return res.ok ? res.json() : null; }, function () { return null; })
      .then(function (report) {
        perspState.drift = report || null;
        renderPerspectives();
      });
  }

  // Switching profile re-asks only the profile-scoped question: the
  // perspectives document itself is project-scoped and does not change, and
  // neither does the run index loadRerun used to (wastefully) re-fetch.
  function reloadRerun() {
    perspState.rerun = null;
    setPerspNote("persp-rerun-note", "");
    setPerspDeployHead(null);
    renderPerspectives();
    return loadRerun();
  }

  function openPerspectives() {
    showView("perspectives");
    document.getElementById("persp-q").value = perspState.q;
    loadPerspectives();
  }

  // The custom prompt body is JSON (schemaVersion/basePromptVersion/customPromptVersion/
  // generatedAt/guidance, plus an optional per-target byTarget map); the textarea
  // only ever shows the learned guidance text, never the raw JSON. When byTarget
  // is present, the slot shows the un-scoped fallback (when it has guidance) plus
  // each per-target overlay under a short header, so it reflects the whole learned
  // set. A parse failure falls back to the raw text so a malformed custom prompt
  // still shows something instead of leaving the UI stuck.
  function customPromptDisplayText(text) {
    if (text == null) return "";
    var NL = "\\n";
    try {
      var parsed = JSON.parse(text);
      var byTarget = parsed && parsed.byTarget;
      if (byTarget && typeof byTarget === "object") {
        var parts = [];
        var top = typeof parsed.guidance === "string" ? parsed.guidance.trim() : "";
        if (top) parts.push("[" + t("prompt.customPrompt.fallback") + "]" + NL + top);
        Object.keys(byTarget).sort().forEach(function (tg) {
          var entry = byTarget[tg];
          var g = entry && typeof entry.guidance === "string" ? entry.guidance.trim() : "";
          if (g) parts.push("[" + tg + "]" + NL + g);
        });
        if (parts.length) return parts.join(NL + NL);
      }
      return typeof parsed.guidance === "string" ? parsed.guidance : text;
    } catch (e) {
      // A malformed custom prompt shouldn't blank the panel; show the raw body but
      // leave a trace so "why is JSON showing here" is debuggable.
      console.warn("ccqa hub: custom prompt body is not valid JSON, showing raw text:", e);
      return text;
    }
  }

  function loadPrompts(statusAfter) {
    setPromptsStatus(statusAfter || "");
    GUIDANCE_SLOTS.forEach(function (slot) {
      if (!slot._ta) return;
      fetchPromptText(slot.name)
        .then(function (text) {
          slot._ta.value =
            LEARNED_PROMPT_NAMES.indexOf(slot.name) !== -1
              ? customPromptDisplayText(text)
              : text == null
                ? ""
                : text;
        })
        .catch(function (err) { setPromptsStatus('Loading "' + slot.name + '" failed: ' + err.message); });
    });
  }

  // ── add sheet (variable / session) ──────────────────────────────────

  var sheetKind = "variable";

  function openSheet(kind) {
    closeProjectDialog();   // never show dialog + sheet together
    sheetKind = kind;
    var isVar = kind === "variable";
    document.getElementById("sheet-title").textContent = isVar ? "Add variable" : "Add session";
    document.getElementById("sheet-save").textContent = isVar ? "Save variable" : "Save session";
    document.getElementById("sheet-body-var").hidden = !isVar;
    document.getElementById("sheet-body-session").hidden = isVar;
    document.getElementById("sheet-scope-project").textContent = state.project;
    document.getElementById("sheet-scope-profile").textContent = secProfile();
    document.getElementById("var-name").value = "";
    document.getElementById("var-value").value = "";
    document.getElementById("var-sensitive").setAttribute("aria-pressed", "false");
    document.getElementById("session-name").value = "";
    document.getElementById("session-state").value = "";
    document.getElementById("scrim").hidden = false;
    document.getElementById("sheet").hidden = false;
  }

  function closeSheet() {
    document.getElementById("scrim").hidden = true;
    document.getElementById("sheet").hidden = true;
  }

  function saveSheet() {
    if (!state.project) { setSecretsStatus("Pick a project first."); closeSheet(); return; }
    if (sheetKind === "variable") {
      var name = document.getElementById("var-name").value.trim();
      var value = document.getElementById("var-value").value;
      var sensitive = document.getElementById("var-sensitive").getAttribute("aria-pressed") === "true";
      if (!name || !value) { setSecretsStatus("Variable name and value are required."); return; }
      apiFetch(scopeBase("variables") + "/" + encodeURIComponent(name), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: value, sensitive: sensitive }),
      }).then(function () { closeSheet(); loadSecrets('Saved variable "' + name + '"'); }).catch(secretsError("Adding variable"));
    } else {
      var sname = document.getElementById("session-name").value.trim();
      var raw = document.getElementById("session-state").value;
      if (!sname || !raw.trim()) { setSecretsStatus("Session name and storage-state JSON are required."); return; }
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        setSecretsStatus("Session is not valid JSON: " + e.message);
        return;
      }
      if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        setSecretsStatus('Session JSON must have "cookies" and "origins" arrays.');
        return;
      }
      apiFetch(scopeBase("sessions") + "/" + encodeURIComponent(sname), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      }).then(function () { closeSheet(); loadSecrets('Saved session "' + sname + '"'); }).catch(secretsError("Adding session"));
    }
  }

  // ── project switching ───────────────────────────────────────────────

  function setProject(p) {
    state.project = p;
    document.getElementById("project-current").textContent = p || "none";
    document.getElementById("sidebar-project").textContent = p || t("app.noProject");
    updateNavGate();
  }

  // Scope to a project and land on its Runs view. Shared by the top menu, the
  // Projects grid, and the "new project" flow. Switching project restores the
  // profile last chosen for that project (or "default" if none was saved);
  // the Secrets tab reloads the profile list when opened.
  function chooseProject(p) {
    setProject(p);
    storeProject(p);
    setProfile(storedProfileForProject(p) || "default");
    location.hash = "#/runs";
    route();
  }

  // Cached list of known project names (from GET /projects, plus any created
  // in-session). A name "exists" for real only once a run/secret is stored
  // under it; this list just scopes the UI.
  var knownProjects = [];

  // ── project menu (top-bar dropdown) ─────────────────────────────────────

  function buildProjectMenu() {
    var menu = document.getElementById("project-menu");
    clear(menu);

    if (knownProjects.length === 0) {
      menu.appendChild(el("div", "mi-empty", t("projects.noneShort")));
    } else {
      knownProjects.forEach(function (p) {
        var mi = el("button", "mi" + (p === state.project ? " current" : ""));
        mi.type = "button";
        mi.setAttribute("role", "menuitem");
        mi.appendChild(el("span", "name", p));
        mi.addEventListener("click", function () { closeProjectMenu(); chooseProject(p); });
        menu.appendChild(mi);
      });
    }

    menu.appendChild(el("div", "sep"));

    var newItem = el("button", "mi action");
    newItem.type = "button";
    newItem.setAttribute("role", "menuitem");
    newItem.appendChild(svgPlus());
    newItem.appendChild(document.createTextNode(t("projects.new")));
    newItem.addEventListener("click", function () { closeProjectMenu(); openProjectDialog(); });
    menu.appendChild(newItem);

    var allItem = el("button", "mi action", "View all projects…");
    allItem.type = "button";
    allItem.setAttribute("role", "menuitem");
    allItem.addEventListener("click", function () { closeProjectMenu(); location.hash = "#/projects"; route(); });
    menu.appendChild(allItem);
  }

  function openProjectMenu() {
    if (!state.token) return;           // nothing to pick until connected
    buildProjectMenu();
    document.getElementById("project-menu").hidden = false;
    document.getElementById("project-switch").setAttribute("aria-expanded", "true");
  }
  function closeProjectMenu() {
    document.getElementById("project-menu").hidden = true;
    document.getElementById("project-switch").setAttribute("aria-expanded", "false");
  }
  function toggleProjectMenu() {
    document.getElementById("project-menu").hidden ? openProjectMenu() : closeProjectMenu();
  }

  // ── profile switching (per-tab dropdowns) ──────────────────────────────
  // Profiles scope variables + sessions (a profile is a set of env vars) and,
  // since ADR-0010, the needs-re-run verdict:
  // two environments sit at different commits, so that question has no
  // profile-free answer. Prompts are project-wide and runs are cross-profile,
  // so there is still no header-level selector — Secrets and Perspectives each
  // carry their own, sharing state.profile and differing only in which names
  // they offer and what a pick reloads.

  var PROFILE_MENUS = {
    secrets: {
      switchId: "sec-profile-switch", menuId: "sec-profile-menu", withNew: true,
      names: function () { return knownProfiles; },
      pick: function (p) { chooseProfile(p, loadSecrets); }
    },
    perspectives: {
      switchId: "persp-profile-switch", menuId: "persp-profile-menu", withNew: false,
      names: perspProfileNames,
      pick: function (p) { chooseProfile(p, reloadRerun); }
    }
  };

  function setProfile(p) {
    state.profile = p || "default";
    ["sec-profile-current", "persp-profile-current"].forEach(function (id) {
      var cur = document.getElementById(id);
      if (cur) cur.textContent = state.profile;
    });
  }

  // Switch profile and reload the tab that asked, under the new scope.
  function chooseProfile(p, reload) {
    setProfile(p);
    storeProfileForProject(state.project, state.profile);
    reload();
  }

  // Fetch the profiles for the current project. "default" is always available
  // (the API guarantees it), so a project with no stored profiles still selects.
  function loadProfiles() {
    if (!state.project) { knownProfiles = ["default"]; setProfile(state.profile); return Promise.resolve(); }
    return apiFetch("/api/v1/projects/" + encodeURIComponent(state.project) + "/profiles").then(function (data) {
      knownProfiles = (data && Array.isArray(data.profiles) && data.profiles.length) ? data.profiles : ["default"];
      if (knownProfiles.indexOf(state.profile) === -1) setProfile(knownProfiles[0]);
      else setProfile(state.profile);
    }).catch(function () { knownProfiles = ["default"]; setProfile("default"); });
  }

  function buildProfileMenu(menuSpec) {
    var menu = document.getElementById(menuSpec.menuId);
    clear(menu);
    menuSpec.names().forEach(function (p) {
      var mi = el("button", "mi" + (p === state.profile ? " current" : ""));
      mi.type = "button";
      mi.setAttribute("role", "menuitem");
      mi.appendChild(el("span", "name", p));
      mi.addEventListener("click", function () { closeProfileMenu(); menuSpec.pick(p); });
      menu.appendChild(mi);
    });
    // Only the Secrets menu can create: a profile with no secrets is a usable
    // secrets scope, but a profile with no runs has nothing to judge.
    if (!menuSpec.withNew) return;
    menu.appendChild(el("div", "sep"));
    var newItem = el("button", "mi action");
    newItem.type = "button";
    newItem.setAttribute("role", "menuitem");
    newItem.appendChild(svgPlus());
    newItem.appendChild(document.createTextNode(t("app.newProfile")));
    newItem.addEventListener("click", function () { closeProfileMenu(); openProfileDialog(); });
    menu.appendChild(newItem);
  }

  function openProfileMenu(which) {
    if (!state.token || !state.project) return;
    var menuSpec = PROFILE_MENUS[which];
    buildProfileMenu(menuSpec);
    document.getElementById(menuSpec.menuId).hidden = false;
    document.getElementById(menuSpec.switchId).setAttribute("aria-expanded", "true");
  }
  // Closes both, so an outside click or Escape needs no idea which is open.
  function closeProfileMenu() {
    Object.keys(PROFILE_MENUS).forEach(function (which) {
      var menuSpec = PROFILE_MENUS[which];
      var menu = document.getElementById(menuSpec.menuId);
      if (!menu) return;
      menu.hidden = true;
      document.getElementById(menuSpec.switchId).setAttribute("aria-expanded", "false");
    });
  }
  function toggleProfileMenu(which) {
    var menu = document.getElementById(PROFILE_MENUS[which].menuId);
    if (menu.hidden) openProfileMenu(which); else closeProfileMenu();
  }

  // ── new-project dialog (centered modal; shares #scrim with the sheet) ──
  // Same charset the CLI's --project enforces, so a name made here stays
  // pushable/pullable from a matching .ccqa tree.
  var PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  // The centered name dialog is shared by "new project" and "new profile";
  // dialogMode decides which the current Create submits.
  var dialogMode = "project";

  function openNameDialog(mode) {
    dialogMode = mode;
    closeSheet();            // never show sheet + dialog together
    document.getElementById("pd-title").textContent = mode === "profile" ? t("app.newProfile") : t("projects.new");
    var input = document.getElementById("pd-name");
    input.value = "";
    document.getElementById("pd-error").hidden = true;
    document.getElementById("scrim").hidden = false;
    document.getElementById("project-dialog").hidden = false;
    input.focus();
  }
  function openProjectDialog() { openNameDialog("project"); }
  function openProfileDialog() { openNameDialog("profile"); }

  function closeProjectDialog() {
    document.getElementById("project-dialog").hidden = true;
    document.getElementById("scrim").hidden = true;
  }

  function submitProjectDialog() {
    var name = document.getElementById("pd-name").value.trim();
    var err = document.getElementById("pd-error");
    if (!name) { err.hidden = false; err.textContent = "Enter a name."; return; }
    if (!PROJECT_NAME_RE.test(name)) {
      err.hidden = false;
      err.textContent = "Invalid name. Use letters, digits, . _ - (must start alphanumeric).";
      return;
    }
    closeProjectDialog();
    if (dialogMode === "profile") {
      // Profiles are implicit like projects — created for real on the first
      // secret/prompt stored under them. Just add to the list and select it.
      if (knownProfiles.indexOf(name) === -1) { knownProfiles.push(name); knownProfiles.sort(); }
      // The "new profile" item only exists in the Secrets menu, so that is the
      // tab to reload.
      chooseProfile(name, loadSecrets);
    } else {
      if (knownProjects.indexOf(name) === -1) { knownProjects.push(name); knownProjects.sort(); }
      chooseProject(name);
    }
  }

  // Pull the project-name array out of GET /api/v1/projects, sorted. Throws on
  // a well-formed-but-wrong-shape 200 (schema/version mismatch, a proxy serving
  // someone else's JSON) so callers report that distinctly instead of letting a
  // raw "undefined.slice" surface as a misleading "could not connect".
  function projectsFrom(data) {
    if (!data || !Array.isArray(data.projects)) throw new Error("Unexpected response from hub");
    return data.projects.slice().sort();
  }

  // Fetch the project list and remember the chosen current project.
  function loadProjects(preferred) {
    return apiFetch("/api/v1/projects").then(function (data) {
      knownProjects = projectsFrom(data);
      var chosen = preferred && knownProjects.indexOf(preferred) !== -1
        ? preferred
        : (knownProjects[0] || "");
      setProject(chosen);
      // Boot auto-select path also needs profile restoration (not just the
      // explicit chooseProject click path); storing happens only in chooseProfile.
      setProfile(storedProfileForProject(chosen) || "default");
      return knownProjects;
    });
  }

  // ── wiring ───────────────────────────────────────────────────────────

  function connect(tok) {
    state.token = tok;
    setLoginError("");
    return loadProjects(state.project || loadStoredProject()).then(function () {
      // route() reveals #app itself (state.token is set), so no showAuthGate here.
      route();
    }).catch(function (err) {
      // Stale/invalid token (or a boot-time auto-connect against a dead hub):
      // keep the stored token (Disconnect clears it explicitly), fall back to
      // the login gate, and surface the error there.
      state.token = "";
      showAuthGate(false);
      document.getElementById("login-token").value = tok;
      setLoginError("Could not connect: " + err.message);
    });
  }

  document.getElementById("login-connect").addEventListener("click", function () {
    var tok = document.getElementById("login-token").value;
    if (!tok) return;
    storeToken(tok);
    connect(tok);
  });
  // Enter in the token field submits, matching a normal login form.
  document.getElementById("login-token").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("login-connect").click(); }
  });

  document.getElementById("disconnect").addEventListener("click", function () {
    clearStoredToken();
    clearStoredProject();
    clearStoredProfiles();
    state.token = "";
    knownProjects = [];
    knownProfiles = [];
    setProject("");
    setProfile("default");
    closeProjectMenu();
    closeProfileMenu();
    setLoginError("");
    document.getElementById("login-token").value = "";
    showAuthGate(false);
    location.hash = "";
    // Disconnected: route() would just re-show the gate, so no route() needed.
  });

  // top-bar project dropdown
  document.getElementById("project-switch").addEventListener("click", function (e) {
    e.stopPropagation();
    closeProfileMenu();
    toggleProjectMenu();
  });
  // Keep clicks inside the menu from bubbling to the document close-handler.
  document.getElementById("project-menu").addEventListener("click", function (e) { e.stopPropagation(); });
  // Per-tab profile dropdowns (Secrets, Perspectives)
  Object.keys(PROFILE_MENUS).forEach(function (which) {
    var menuSpec = PROFILE_MENUS[which];
    document.getElementById(menuSpec.switchId).addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectMenu();
      toggleProfileMenu(which);
    });
    document.getElementById(menuSpec.menuId).addEventListener("click", function (e) { e.stopPropagation(); });
  });
  // Outside click closes both menus.
  document.addEventListener("click", function () { closeProjectMenu(); closeProfileMenu(); });

  // projects view
  document.getElementById("projects-refresh").addEventListener("click", openProjects);
  document.getElementById("projects-new").addEventListener("click", openProjectDialog);

  // new-project dialog
  document.getElementById("pd-cancel").addEventListener("click", closeProjectDialog);
  document.getElementById("pd-create").addEventListener("click", submitProjectDialog);
  document.getElementById("pd-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitProjectDialog(); }
  });

  document.getElementById("detail-back").addEventListener("click", function () { location.hash = "#/runs"; });
  document.getElementById("runs-refresh").addEventListener("click", loadRuns);
  // Every control refetches: the window and the kinds are the server's to
  // apply, so filtering client-side would only narrow the same capped page.
  [["runs-f-date", "date"], ["runs-f-kind", "kind"], ["runs-f-status", "status"]].forEach(function (pair) {
    document.getElementById(pair[0]).addEventListener("change", function (e) {
      runsFilter[pair[1]] = e.target.value;
      loadRunsList();
    });
  });
  document.getElementById("learn-run").addEventListener("click", startLearn);
  document.getElementById("jobs-refresh").addEventListener("click", loadJobs);
  // Wrap so the click PointerEvent isn't passed as loadSecrets' statusAfter
  // argument (which would render "[object PointerEvent]" in the status box).
  document.getElementById("sec-load").addEventListener("click", function () { loadSecrets(); });

  // perspectives view
  document.getElementById("persp-refresh").addEventListener("click", function () { loadPerspectives(); });
  document.getElementById("persp-q").addEventListener("input", function (e) {
    perspState.q = e.target.value.trim().toLowerCase();
    renderPerspectives();
  });
  document.querySelectorAll("#view-perspectives .fchip").forEach(function (b) {
    b.addEventListener("click", function () {
      // renderPerspectives -> syncPerspChips repaints aria-pressed from
      // perspState.f, so the handler only has to record the choice.
      perspState.f = b.getAttribute("data-f");
      renderPerspectives();
    });
  });

  // prompts view
  document.getElementById("pr-load").addEventListener("click", function () { loadPrompts(); });

  document.getElementById("var-open-sheet").addEventListener("click", function () { openSheet("variable"); });
  document.getElementById("session-open-sheet").addEventListener("click", function () { openSheet("session"); });
  document.getElementById("session-help-copy").addEventListener("click", function () {
    var btn = this;
    var label = btn.querySelector("span");
    var cmd = document.getElementById("session-help-cmd").textContent;
    var done = function () {
      if (!label) return;
      label.textContent = t("common.copied");
      setTimeout(function () { label.textContent = t("common.copy"); }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(done).catch(function () {});
    }
  });
  document.getElementById("var-sensitive").addEventListener("click", function () {
    var pressed = this.getAttribute("aria-pressed") === "true";
    this.setAttribute("aria-pressed", pressed ? "false" : "true");
  });
  document.getElementById("sheet-cancel").addEventListener("click", closeSheet);
  document.getElementById("sheet-save").addEventListener("click", saveSheet);
  // #scrim backs both the side sheet and the project dialog; a click on it
  // dismisses whichever is open.
  document.getElementById("scrim").addEventListener("click", function () { closeSheet(); closeProjectDialog(); });
  // Escape closes whichever transient surface is open (menu / sheet / dialog).
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeLightbox(); closeProjectMenu(); closeProfileMenu(); closeSheet(); closeProjectDialog(); } });
  document.getElementById("lightbox").addEventListener("click", closeLightbox);
  window.addEventListener("hashchange", route);

  // language + theme toggles (appbar)
  document.getElementById("lang-en").addEventListener("click", function () { if (lang !== "en") setLang("en"); });
  document.getElementById("lang-ja").addEventListener("click", function () { if (lang !== "ja") setLang("ja"); });
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

  // ── boot: auto-connect from a stored token, else show the gate ─────────
  (function boot() {
    applyTheme();          // light default, or the stored .dark preference
    applyStaticI18n();     // localize static chrome (English is the fallback)
    syncLangToggle();
    updateNavGate();   // gate Runs/Secrets until a project is chosen
    var stored = loadStoredToken();
    if (stored) {
      // Optimistically try the stored token. #login and #app both start hidden
      // in markup, so there's no flash of the login card while the request is
      // in flight; connect() reveals #app on success, or the login gate (with
      // an error) on failure.
      document.getElementById("login-token").value = stored;   // visible if it turns out invalid
      connect(stored);
    } else {
      showAuthGate(false);   // no token → straight to the login gate
    }
  })();
})();
`;
