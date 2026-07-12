import { FAILURE_LABELS, PREDICTED_LABELS } from "../../report/schema.ts";
import { AGENT_BROWSER_TARGET } from "../../spec/yaml-schema.ts";

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
        <button class="btn ghost sm" id="projects-refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> Refresh
        </button>
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
        <div class="spacer"></div>
        <button class="btn ghost sm" id="runs-refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> Refresh
        </button>
      </div>
      <div class="content">
        <div class="card" id="runs-card">
          <div class="table-wrap">
            <table>
              <thead><tr><th data-i18n="runs.col.run">Run</th><th data-i18n="runs.col.branch">Branch</th><th data-i18n="meta.profile">Profile</th><th data-i18n="runs.col.status">Status</th><th data-i18n="runs.col.specs">Specs</th><th data-i18n="runs.col.created">Created</th></tr></thead>
              <tbody id="runs-tbody"></tbody>
            </table>
          </div>
        </div>
        <p class="empty-note" id="runs-empty" hidden data-i18n="runs.empty">Select a project to see its runs.</p>
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
             sits above the spec list rather than being buried below it. -->
        <div class="triage-head" id="triage-head">
          <h3 style="font-size:14px" data-i18n="detail.triage">Triage</h3>
          <span class="triage-summary" id="triage-summary"></span>
        </div>
        <div class="card" id="matrix-card"></div>
        <p class="muted" id="triage-progress" style="font-size:12.5px;margin-top:8px"></p>

        <div class="learn-cta" id="learn-cta" hidden>
          <div class="learn-cta-text">
            <div class="t" data-i18n="learn.cta.title">Learn from these grades</div>
            <div class="d" data-i18n="learn.cta.desc">Turn the graded cases into a custom prompt that calibrates future failure classification.</div>
          </div>
          <div class="learn-cta-actions">
            <button class="btn primary sm" id="learn-run" data-i18n="learn.cta.run">Learn</button>
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
        <button class="btn ghost sm" id="jobs-refresh" data-i18n="common.refresh">Refresh</button>
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
        <button class="btn ghost sm" id="sec-load" data-i18n="common.refresh">Refresh</button>
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
        <button class="btn ghost sm" id="pr-load" data-i18n="common.refresh">Refresh</button>
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
              <div class="cmd"><code id="session-help-cmd">ccqa session bootstrap &lt;name&gt;</code><button type="button" class="copy" id="session-help-copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span data-i18n="common.copy">Copy</span></button></div>
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
  .subline { margin-top: 3px; }
  .ci-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-family: var(--mono); color: var(--muted); background: var(--surface-3); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
  .ci-badge.local { color: var(--muted-2); }

  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 7px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; border: 1px solid transparent; }
  .badge .d { width: 6px; height: 6px; border-radius: 50%; }
  .badge.pass, .badge.passed { background: var(--pass-bg); color: var(--pass); border-color: var(--pass-border); }
  .badge.pass .d, .badge.passed .d { background: var(--pass); }
  .badge.fail, .badge.failed { background: var(--fail-bg); color: var(--fail); border-color: var(--fail-border); }
  .badge.fail .d, .badge.failed .d { background: var(--fail); }
  .badge.skipped { background: var(--surface-3); color: var(--muted); border-color: var(--border); }
  .badge.skipped .d { background: var(--muted); }
  .badge.running { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .badge.running .d { background: var(--amber); }
  .badge-live, .badge-det { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; border: 1px solid transparent; }
  .badge-live { background: var(--violet-bg); color: var(--violet); border-color: var(--violet-border); }
  .badge-det { background: var(--surface-3); color: var(--muted); border-color: var(--border); }
  /* which generation target ran the spec (agent-browser / playwright / runn) */
  .badge-target { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; font-family: var(--mono); background: var(--surface-3); color: var(--muted); border: 1px solid var(--border); }
  .badge.drift-warn { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .badge.drift-warn .d { background: var(--amber); }
  .badge-drift { background: var(--violet-bg); color: var(--violet); border-color: var(--violet-border); }
  .chip { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 6px; background: var(--surface-3); border: 1px solid var(--border); color: var(--fg-dim); font-size: 12px; font-family: var(--mono); }
  /* Below .chip in source order so these override its background/border/color
     when combined as class="chip drift-*-chip" (same specificity — source
     order decides). */
  .chip.kind-chip { color: var(--violet); background: var(--violet-bg); border-color: var(--violet-border); font-family: var(--font); margin-left: 6px; }
  .chip.drift-count-chip { color: var(--amber); background: var(--amber-bg); border-color: var(--amber-border); margin-left: 6px; }
  .chip.drift-errors-chip { color: var(--fail); background: var(--fail-bg); border-color: var(--fail-border); margin-left: 6px; }
  .drift-meta-box { display: flex; flex-direction: column; gap: 4px; }
  .drift-meta-chips { display: flex; gap: 6px; }
  .specs { display: inline-flex; align-items: center; gap: 9px; }
  .meter { width: 54px; height: 6px; border-radius: 3px; background: var(--fail-bg); overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--pass); }

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
  .lbl.UNKNOWN, .lbl.none { color: var(--muted); }
  .conf { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }

  /* spec cards — Tier1 header (scan) / Tier2 verdict+grading / Tier3 accordions */
  .spec-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; }
  /* verdict signal is a single left rail on the whole card — no all-sides tint */
  .spec-card.failed { border-left: 3px solid var(--fail); }
  .spec-card.passed { border-left: 3px solid var(--pass); }
  .spec-card-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; }
  .spec-card-head .name { font-weight: 600; font-size: 15px; }
  .spec-card-head .slug { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 2px; }
  .spec-card-head .spacer { flex: 1; }
  .spec-card-body { padding: 0 20px 16px; }
  /* Tier2 verdict block */
  .analysis-box { display: flex; flex-direction: column; gap: 12px; padding-bottom: 4px; }
  .analysis-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .analysis-headline { font-size: 14px; font-weight: 600; color: var(--fg); line-height: 1.5; }
  .analysis-rec { font-size: 13px; color: var(--fg-dim); background: var(--surface-2); border: 1px solid var(--border); border-left: 2px solid var(--muted); border-radius: var(--radius-sm); padding: 10px 12px; line-height: 1.55; }
  .analysis-rec .rec-k { display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
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
  .drift-sev { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; border: 1px solid transparent; text-transform: uppercase; letter-spacing: 0.03em; }
  .drift-sev.error { background: var(--fail-bg); color: var(--fail); border-color: var(--fail-border); }
  .drift-sev.warn { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-border); }
  .drift-sev.ok { background: var(--pass-bg); color: var(--pass); border-color: var(--pass-border); }
  .drift-cat { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .drift-step { font-family: var(--mono); font-size: 11px; color: var(--muted-2); }
  .drift-msg { margin-top: 4px; color: var(--fg-dim); }
  .drift-detail { margin-top: 3px; color: var(--muted); font-size: 12px; }
  .drift-clean { color: var(--pass); font-size: 13px; }

  /* triage grading — an explicit question + a segmented single-select, framed
     as an action ("tell us the real cause"), not a data readout. */
  .grade { margin-top: 4px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); }
  .grade-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .grade-q { font-size: 13px; font-weight: 600; color: var(--fg); }
  .grade-pred { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12px; color: var(--muted); }
  .grade-pred .grade-arrow { color: var(--muted-2); }
  .grade-bottom { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .grade-seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-md); overflow: hidden; background: var(--surface); }
  .grade-seg .seg { height: 34px; padding: 0 14px; border: 0; background: transparent; color: var(--muted); font-size: 13px; font-weight: 500; border-right: 1px solid var(--border); display: inline-flex; align-items: center; gap: 5px; }
  .grade-seg .seg:last-child { border-right: 0; }
  .grade-seg .seg:hover { background: var(--surface-2); color: var(--fg); }
  .grade-seg .seg[aria-pressed="true"] { font-weight: 600; }
  .grade-seg .seg[aria-pressed="true"].TEST_DRIFT  { color: var(--info); background: var(--info-bg); }
  .grade-seg .seg[aria-pressed="true"].SPEC_CHANGE { color: var(--amber); background: var(--amber-bg); }
  .grade-seg .seg[aria-pressed="true"].PRODUCT_BUG { color: var(--fail); background: var(--fail-bg); }
  .grade-seg .seg[disabled] { opacity: 0.6; pointer-events: none; }
  .grade-status { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); border-style: dashed; }
  .grade-status.saved-match { color: var(--pass); background: var(--pass-bg); border-color: var(--pass-border); border-style: solid; }
  .grade-status.saved-corrected { color: var(--amber); background: var(--amber-bg); border-color: var(--amber-border); border-style: solid; }
  .grade-status.saving { color: var(--muted); border-style: solid; }
  .grade-status.err { color: var(--fail); background: var(--fail-bg); border-color: var(--fail-border); border-style: solid; }

  .matrix-wrap { padding: 18px 20px; overflow-x: auto; }
  .matrix-table { border-collapse: collapse; font-size: 12.5px; }
  .matrix-table th, .matrix-table td { border: 1px solid var(--border); padding: 9px 16px; text-align: center; font-variant-numeric: tabular-nums; }
  .matrix-table thead th { background: var(--surface-2); color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .matrix-table tbody th { background: var(--surface-2); color: var(--fg-dim); font-weight: 600; font-size: 11px; text-align: left; white-space: nowrap; }
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

  .learn-cta { display: flex; align-items: center; gap: 16px; margin-top: 18px; padding: 16px 18px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); }
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

  @media (max-width: 900px) { .app { grid-template-columns: 1fr; } .sidebar { display: none; } .logo .wm { display: none; } .split { grid-template-columns: 1fr; } .rd-head .meta { margin-left: 0; } }
  @media (max-width: 700px) { .prompt-grid { grid-template-columns: 1fr; } .prompt-diff { grid-template-columns: 1fr; } }
`;

// ─────────────────────────────────────────────────────────────────────────
// Vanilla JS, no build step: fetch()-only against /api/v1. Runs are immutable
// once pushed, so there is nothing to poll. The URL hash routes between views
// (#/runs/<id> deep-links a run — the URL `ccqa hub push` prints — and
// #/secrets opens the secrets manager). FAILURE_LABELS / PREDICTED_LABELS are
// injected below so the browser doesn't need to re-derive them from anywhere.
//
// Blocks, in order: token/auth gate, fetch/dom helpers, view routing,
// projects list, runs list, run detail (spec cards + evidence images),
// triage (grading + confusion matrix), secrets tab, add sheet
// (variable/session), project switching/menu, new-project dialog, wiring.
// ─────────────────────────────────────────────────────────────────────────
const CLIENT_JS = `
(function () {
  var FAILURE_LABELS = ${JSON.stringify(FAILURE_LABELS)};
  // Rows of the confusion matrix: the three actual labels plus UNKNOWN, since
  // the model can predict UNKNOWN. Columns (actual causes) are FAILURE_LABELS
  // only (a human never records UNKNOWN as the ground-truth cause).
  var PREDICTED_LABELS = ${JSON.stringify(PREDICTED_LABELS)};
  var AGENT_BROWSER_TARGET = ${JSON.stringify(AGENT_BROWSER_TARGET)};
  var state = { token: "", project: "", profile: "default", detailRunId: "", jobPollToken: 0 };
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
      "nav.projects": "Projects", "nav.runs": "Runs", "nav.secrets": "Secrets",
      "nav.prompts": "Prompts", "nav.learning": "Learning",
      "app.project": "project", "app.profile": "profile", "app.disconnect": "Disconnect", "app.noProject": "no project",
      "app.newProfile": "New profile",
      "login.title": "Connect to your hub", "login.sub": "Enter your bearer token to continue.",
      "login.token": "Token", "login.connect": "Connect",
      "login.note": "The token is stored only in this browser; secret values never are. Use the hub only behind TLS on a trusted network.",
      "projects.title": "Projects", "projects.new": "New project",
      "runs.title": "Runs", "runs.empty": "Select a project to see its runs.",
      "runs.none": "No runs yet for this project.", "projects.none": "No projects yet. Create one to get started.", "projects.noneShort": "No projects yet",
      "runs.col.run": "Run", "runs.col.branch": "Branch", "runs.col.status": "Status",
      "runs.col.specs": "Specs", "runs.col.created": "Created",
      "detail.back": "Runs", "detail.specs": "Specs",
      "detail.download": "Download artifacts",
      "detail.triage": "Triage",
      "meta.branch": "Branch", "meta.specs": "Specs", "meta.prompt": "Prompt",
      "meta.created": "Created", "meta.passed": "passed", "meta.profile": "Profile",
      "meta.drift": "Drift",
      "rec.title": "Recommendation",
      "acc.reasoning": "Reasoning", "acc.evidence": "Evidence", "acc.steps": "Live run steps",
      "acc.assertions": "Assertions", "acc.drift": "Drift audit",
      "acc.artifacts": "Artifacts",
      "art.open": "Open", "art.loadFailed": "could not load (it may have been omitted from the push)",
      "acc.assertions.hint": "Test cases from the recorded spec run",
      "spec.kind.live": "Live", "spec.kind.det": "Deterministic",
      "spec.driftWarn": "Spec drift", "det.steps": "Steps",
      "kind.run": "Test run", "kind.drift": "Drift audit",
      "drift.summary.issues": "Issues", "drift.summary.errors": "Errors",
      "drift.summary.warnings": "Warnings", "drift.summary.specsWithIssues": "Specs with issues",
      "drift.clean": "No drift issues",
      "grade.question": "What was the real cause?", "grade.predicted": "predicted",
      "grade.ungraded": "ungraded", "grade.matches": "saved · matches",
      "grade.corrected": "saved · corrected", "grade.saving": "saving…",
      "grade.error": "couldn't save — retry",
      "matrix.empty": "No graded cases yet. Grade a failed spec above to populate the confusion matrix.",
      "matrix.predicted": "predicted \\\\ actual", "matrix.accuracy": "Accuracy",
      "matrix.accSuffix": "of graded cases match the prediction", "matrix.graded": "graded",
      "matrix.progress": "Recorded actual cause: {n} / {total} failing specs",
      "learn.cta.title": "Learn from these grades",
      "learn.cta.desc": "Learn from what you graded so ccqa classifies failure causes the same way next time.",
      "learn.cta.run": "Learn",
      "secrets.title": "Secrets", "prompts.title": "Prompts", "learning.title": "Learning",
      "prompt.card.record": "Recording browser actions",
      "prompt.card.live": "Live run (AI-driven)",
      "prompt.card.customPrompt": "Failure-cause classification",
      "prompt.sub.user": "Your instructions", "prompt.sub.agent": "Learned by ccqa",
      "prompt.recordUser.hint": "Rules you write for how a test is recorded — what to click, what to ignore. Applied whenever you record a new test.",
      "prompt.recordAgent.hint": "Notes ccqa keeps for itself while recording, refined automatically as it runs. Read-only — ccqa regenerates it.",
      "prompt.liveUser.hint": "Rules you write for how the AI drives the browser to run a test on its own. Applied on every live run.",
      "prompt.liveAgent.hint": "Notes ccqa keeps for itself while running tests live, refined automatically as it runs. Read-only — ccqa regenerates it.",
      "prompt.triageUser.hint": "Rules you write for how failure causes are classified — e.g. which kinds of changes count as a spec change on this project. Applied on every failure analysis.",
      "prompt.customPrompt.hint": "Learned from your triage grades to make ccqa classify failure causes the way you do. Read-only — a learning job creates it.",
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
      "nav.projects": "プロジェクト", "nav.runs": "実行", "nav.secrets": "シークレット",
      "nav.prompts": "プロンプト", "nav.learning": "学習",
      "app.project": "プロジェクト", "app.profile": "プロファイル", "app.disconnect": "切断", "app.noProject": "プロジェクト未選択",
      "app.newProfile": "新規プロファイル",
      "login.title": "ハブに接続", "login.sub": "続けるにはベアラートークンを入力してください。",
      "login.token": "トークン", "login.connect": "接続",
      "login.note": "トークンはこのブラウザにのみ保存され、シークレット値は保存されません。ハブは信頼できるネットワークのTLS配下でのみ利用してください。",
      "projects.title": "プロジェクト", "projects.new": "新規プロジェクト",
      "runs.title": "実行", "runs.empty": "プロジェクトを選択すると実行一覧が表示されます。",
      "runs.none": "このプロジェクトにはまだ実行がありません。", "projects.none": "まだプロジェクトがありません。作成して始めましょう。", "projects.noneShort": "プロジェクトなし",
      "runs.col.run": "実行", "runs.col.branch": "ブランチ", "runs.col.status": "ステータス",
      "runs.col.specs": "スペック", "runs.col.created": "作成",
      "detail.back": "実行", "detail.specs": "スペック",
      "detail.download": "アーティファクトをダウンロード",
      "detail.triage": "トリアージ",
      "meta.branch": "ブランチ", "meta.specs": "スペック", "meta.prompt": "プロンプト",
      "meta.created": "作成", "meta.passed": "合格", "meta.profile": "プロファイル",
      "meta.drift": "ドリフト",
      "rec.title": "推奨対応",
      "acc.reasoning": "推論", "acc.evidence": "根拠", "acc.steps": "実行ステップ",
      "acc.assertions": "アサーション", "acc.drift": "ドリフト監査",
      "acc.artifacts": "成果物",
      "art.open": "開く", "art.loadFailed": "読み込めませんでした（push時に省略された可能性があります）",
      "acc.assertions.hint": "記録したスペック実行のテストケース",
      "spec.kind.live": "ライブ", "spec.kind.det": "決定的",
      "spec.driftWarn": "仕様ドリフト", "det.steps": "ステップ",
      "kind.run": "テスト実行", "kind.drift": "ドリフト監査",
      "drift.summary.issues": "問題数", "drift.summary.errors": "エラー",
      "drift.summary.warnings": "警告", "drift.summary.specsWithIssues": "問題のあるスペック",
      "drift.clean": "ドリフトの問題なし",
      "grade.question": "実際の原因は何でしたか？", "grade.predicted": "予測",
      "grade.ungraded": "未評価", "grade.matches": "保存済み · 一致",
      "grade.corrected": "保存済み · 修正", "grade.saving": "保存中…",
      "grade.error": "保存に失敗 — 再試行",
      "matrix.empty": "まだ評価がありません。上の失敗スペックを評価すると混同行列に反映されます。",
      "matrix.predicted": "予測 \\\\ 実際", "matrix.accuracy": "正解率",
      "matrix.accSuffix": "件の採点が予測と一致", "matrix.graded": "採点済み",
      "matrix.progress": "実際の原因を記録: {total} 件中 {n} 件の失敗スペック",
      "learn.cta.title": "この採点から学習",
      "learn.cta.desc": "採点した内容をもとに、ccqaが次回から同じように失敗の原因を分類できるよう学習します。",
      "learn.cta.run": "学習",
      "secrets.title": "シークレット", "prompts.title": "プロンプト", "learning.title": "学習",
      "prompt.card.record": "ブラウザ操作の記録",
      "prompt.card.live": "ライブ実行（AI操作）",
      "prompt.card.customPrompt": "失敗原因の分類",
      "prompt.sub.user": "あなたの指示", "prompt.sub.agent": "ccqaの学習",
      "prompt.recordUser.hint": "テストを記録するときのルールを自分で書きます（何をクリックするか、何を無視するか）。新しいテストを記録するたびに適用されます。",
      "prompt.recordAgent.hint": "記録中にccqaが自分用に書き留め、実行のたびに自動で洗練していくメモです。読み取り専用 — ccqaが再生成します。",
      "prompt.liveUser.hint": "AIがその場でブラウザを操作してテストを実行するときのルールを自分で書きます。ライブ実行のたびに適用されます。",
      "prompt.liveAgent.hint": "ライブ実行中にccqaが自分用に書き留め、実行のたびに自動で洗練していくメモです。読み取り専用 — ccqaが再生成します。",
      "prompt.triageUser.hint": "失敗原因を分類するときのルールを自分で書きます（例: どの変更をこのプロジェクトで仕様変更として扱うか）。失敗分析のたびに適用されます。",
      "prompt.customPrompt.hint": "あなたの採点から学習し、ccqaがあなたと同じように失敗の原因を分類できるようにします。読み取り専用 — 学習ジョブが生成します。",
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
  var FAILURE_LABEL_JA = { TEST_DRIFT: "テストずれ", SPEC_CHANGE: "仕様変更", PRODUCT_BUG: "プロダクト不具合", UNKNOWN: "不明" };

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
          throw new Error((b && b.error && b.error.message) || (res.status + " " + res.statusText));
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

  function statusBadge(status) {
    var span = el("span", "badge " + status);
    span.appendChild(el("span", "d"));
    span.appendChild(document.createTextNode(" " + status));
    return span;
  }

  function ciBadge(run) {
    return run.ciRunId
      ? el("span", "ci-badge", "Actions #" + run.ciRunId)
      : el("span", "ci-badge local", "local run");
  }

  function labelChip(label) {
    var known = FAILURE_LABELS.indexOf(label) !== -1 || label === "UNKNOWN";
    // class carries the English value (for color); text shows the localized name.
    return el("span", "lbl " + (known ? label : "none"), labelText(label));
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

  // ── view routing ────────────────────────────────────────────────────

  var VIEWS = ["projects", "runs", "detail", "secrets", "prompts", "jobs"];
  var NAV_FOR_VIEW = { projects: ".nav-projects", secrets: ".nav-secrets", prompts: ".nav-prompts", runs: ".nav-runs", detail: ".nav-runs", jobs: ".nav-jobs" };
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

  function renderRunsList(runs) {
    var tbody = document.getElementById("runs-tbody");
    clear(tbody);
    var empty = document.getElementById("runs-empty");
    if (runs.length === 0) {
      empty.hidden = false;
      empty.textContent = t("runs.none");
      return;
    }
    empty.hidden = true;
    runs.forEach(function (r) {
      var tr = el("tr", "row");
      tr.addEventListener("click", function () { location.hash = "#/runs/" + encodeURIComponent(r.id); });

      var runCell = document.createElement("td");
      runCell.appendChild(el("div", "runid", r.id.slice(0, 8)));
      var sub = el("div", "subline");
      sub.appendChild(ciBadge(r));
      if (r.kind === "drift") {
        sub.appendChild(el("span", "chip kind-chip", t("kind.drift")));
        if (r.drift) {
          if (r.drift.errors > 0) {
            sub.appendChild(el("span", "chip drift-errors-chip", t("drift.summary.errors") + " " + r.drift.errors));
          }
          if (r.drift.warnings > 0) {
            sub.appendChild(el("span", "chip drift-count-chip", t("drift.summary.warnings") + " " + r.drift.warnings));
          }
        }
      } else {
        sub.appendChild(el("span", "chip kind-chip", t("kind.run")));
      }
      runCell.appendChild(sub);
      tr.appendChild(runCell);

      var branchCell = document.createElement("td");
      branchCell.appendChild(el("span", "chip", r.branch || "—"));
      tr.appendChild(branchCell);

      var profileCell = document.createElement("td");
      profileCell.appendChild(r.profile ? el("span", "chip", r.profile) : el("span", "muted", "—"));
      tr.appendChild(profileCell);

      var statusCell = document.createElement("td");
      statusCell.appendChild(statusBadge(r.status));
      tr.appendChild(statusCell);

      var specsCell = document.createElement("td");
      var specsWrap = el("div", "specs");
      var meter = el("span", "meter");
      var pct = r.specs.total > 0 ? Math.round((r.specs.passed / r.specs.total) * 100) : 0;
      var bar = el("i");
      bar.style.width = pct + "%";
      meter.appendChild(bar);
      specsWrap.appendChild(meter);
      specsWrap.appendChild(el("span", "num muted", r.specs.passed + " / " + r.specs.total));
      specsCell.appendChild(specsWrap);
      tr.appendChild(specsCell);

      tr.appendChild(el("td", "muted num", relTime(r.createdAt)));
      tbody.appendChild(tr);
    });
  }

  function loadRuns() {
    var empty = document.getElementById("runs-empty");
    empty.hidden = true;
    apiFetch("/api/v1/runs?project=" + encodeURIComponent(state.project) + "&limit=50")
      .then(function (data) { renderRunsList(data.runs); })
      .catch(function (err) {
        clear(document.getElementById("runs-tbody"));
        empty.hidden = false;
        empty.textContent = "Error loading runs: " + err.message;
      });
  }

  // ── run detail: header ──────────────────────────────────────────────

  function renderRunHead(run) {
    var head = document.getElementById("rd-head");
    clear(head);

    var idblock = el("div", "idblock");
    // NB: not named "t" — that would shadow the global t() translator in this scope.
    var titleRow = el("div", "t");
    titleRow.appendChild(el("span", "runid", run.id.slice(0, 8)));
    titleRow.appendChild(statusBadge(run.status));
    idblock.appendChild(titleRow);
    var sub = el("div", "subline");
    sub.appendChild(ciBadge(run));
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
    if (run.kind === "drift" && run.drift) {
      // Drift runs have no live/deterministic spec pass count. Errors/warnings
      // are the actionable counts and get colored chips; issues/specsWithIssues
      // are supplementary totals shown as a muted line below.
      if (run.drift.errors === 0 && run.drift.warnings === 0) {
        metaItem(t("meta.drift"), el("div", "drift-clean", t("drift.clean")));
      } else {
        var driftBox = el("div", "drift-meta-box");
        var chips = el("div", "drift-meta-chips");
        if (run.drift.errors > 0) {
          chips.appendChild(el("span", "chip drift-errors-chip", t("drift.summary.errors") + " " + run.drift.errors));
        }
        if (run.drift.warnings > 0) {
          chips.appendChild(el("span", "chip drift-count-chip", t("drift.summary.warnings") + " " + run.drift.warnings));
        }
        driftBox.appendChild(chips);
        var driftSub = el("div", "muted", t("drift.summary.specsWithIssues") + " " + run.drift.specsWithIssues + " / " + t("drift.summary.issues") + " " + run.drift.issues);
        driftBox.appendChild(driftSub);
        metaItem(t("meta.drift"), driftBox);
      }
    } else {
      metaItem(t("meta.specs"), run.specs.passed + " / " + run.specs.total + " " + t("meta.passed"));
    }
    metaItem(t("meta.prompt"), run.promptVersion || "—");
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

  // Tier2 verdict block: label + confidence, headline, and the recommendation
  // callout. Reasoning is NOT here — renderSpecCard places it as a Tier3
  // accordion (or inline when it's too short to be worth folding).
  function analysisSection(runId, r) {
    var wrap = el("div", "analysis-box");
    var a = r.analysis;
    var head = el("div", "analysis-head");
    head.appendChild(labelChip(a.label));
    head.appendChild(el("span", "conf", Math.round(a.confidence * 100) + "%"));
    if (a.subDiagnosis && a.subDiagnosis !== "NONE") head.appendChild(el("span", "muted", a.subDiagnosis));
    wrap.appendChild(head);
    if (a.headline) wrap.appendChild(el("div", "analysis-headline", a.headline));
    if (a.recommendation) {
      var rec = el("div", "analysis-rec");
      rec.appendChild(el("span", "rec-k", t("rec.title")));
      rec.appendChild(document.createTextNode(a.recommendation));
      wrap.appendChild(rec);
    }
    return wrap;
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
        built.head.appendChild(el("span", "cost", "$" + s.cost.totalCostUsd.toFixed(4)));
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

  // Deterministic-spec evidence rendered as the same step-card list as live
  // runs, since report.json already carries one evidence entry per step.
  function detStepsSection(runId, evidence) {
    var wrap = el("div");
    evidence.forEach(function (e, i) {
      var built = stepCard(e.status, "#" + (i + 1), e.stepId, e.description, e.title);
      if (e.failureSummary) built.card.appendChild(el("div", "cap", e.failureSummary));
      if (e.pngPath) {
        var frames = el("div", "step-frames");
        frames.appendChild(frameEl(runId, e.pngPath, e.stepId));
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

  function driftSection(issues) {
    var wrap = el("div");
    issues.forEach(function (issue) {
      var row = el("div", "drift-row");
      var head = el("div", "drift-head");
      head.appendChild(el("span", "drift-sev " + issue.severity.toLowerCase(), issue.severity));
      head.appendChild(el("span", "drift-cat", issue.category));
      if (issue.stepId) head.appendChild(el("span", "drift-step", "#" + issue.stepId));
      row.appendChild(head);
      row.appendChild(el("div", "drift-msg", issue.message));
      if (issue.detail) row.appendChild(el("div", "drift-detail", issue.detail));
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

  // The grading action: an explicit question ("What was the real cause?") with
  // the model's guess as muted context, a segmented single-select over the
  // failure labels, and a status chip (ungraded / saved·matches / saved·
  // corrected). One tap grades it. Optimistic PUT with rollback; on success it
  // refreshes the confusion matrix. The English label value is what's sent and
  // stored; the segment just shows its localized name.
  function triageGradeControl(runId, r, triageState) {
    var key = r.feature + "/" + r.spec;
    var predicted = r.analysis ? r.analysis.label : "UNKNOWN";

    var wrap = el("div", "grade");

    var top = el("div", "grade-top");
    top.appendChild(el("span", "grade-q", t("grade.question")));
    var pred = el("span", "grade-pred");
    pred.appendChild(document.createTextNode(t("grade.predicted")));
    pred.appendChild(el("span", "grade-arrow", "→"));
    pred.appendChild(labelChip(predicted));
    top.appendChild(pred);
    wrap.appendChild(top);

    var bottom = el("div", "grade-bottom");
    var seg = el("div", "grade-seg");
    var status = el("span", "grade-status");
    var segByLabel = {};

    // Reflect the current selection (colour + check) and the status chip.
    function paint(selected) {
      FAILURE_LABELS.forEach(function (lbl) {
        var b = segByLabel[lbl];
        b.setAttribute("aria-pressed", String(lbl === selected));
        b.firstChild.textContent = (lbl === selected ? "✓ " : "") + labelText(lbl);
      });
      status.className = "grade-status";
      if (!selected) { status.textContent = t("grade.ungraded"); return; }
      if (selected === predicted) { status.classList.add("saved-match"); status.textContent = t("grade.matches"); }
      else { status.classList.add("saved-corrected"); status.textContent = t("grade.corrected"); }
    }

    var existing = triageState.byKey[key];
    var current = existing && existing.actual ? existing.actual.cause : "";

    FAILURE_LABELS.forEach(function (lbl) {
      var b = el("button", "seg " + lbl);
      b.type = "button";
      b.appendChild(el("span", null, labelText(lbl))); // text node the paint() updates
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", function () {
        if (lbl === current) return; // no-op re-click
        var prev = current;
        FAILURE_LABELS.forEach(function (l) { segByLabel[l].disabled = true; });
        paint(lbl);
        status.className = "grade-status saving";
        status.textContent = t("grade.saving");
        putActualCause(runId, r.feature, r.spec, lbl)
          .then(function () {
            current = lbl;
            if (!triageState.byKey[key]) {
              triageState.byKey[key] = { feature: r.feature, spec: r.spec, predicted: r.analysis, actual: null };
            }
            triageState.byKey[key].actual = { cause: lbl };
            paint(lbl); // clears .saving, sets final matches/corrected
            renderMatrix(triageState);
          })
          .catch(function (err) {
            paint(prev); // roll back the optimistic selection
            status.className = "grade-status err";
            status.textContent = t("grade.error");
          })
          .then(function () {
            FAILURE_LABELS.forEach(function (l) { segByLabel[l].disabled = false; });
          });
      });
      segByLabel[lbl] = b;
      seg.appendChild(b);
    });

    bottom.appendChild(seg);
    bottom.appendChild(status);
    wrap.appendChild(bottom);
    paint(current); // restore saved state on (re)render
    return wrap;
  }

  function renderSpecCard(runId, r, triageState, isDrift) {
    var card = el("div", "spec-card " + r.status); // .passed / .failed rail
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
    var external = r.target && r.target !== AGENT_BROWSER_TARGET;
    if (isDrift) head.appendChild(el("span", "badge badge-drift", t("kind.drift")));
    else if (r.liveRun) head.appendChild(el("span", "badge-live", t("spec.kind.live")));
    else if (!external) head.appendChild(el("span", "badge-det", t("spec.kind.det")));
    head.appendChild(statusBadge(r.status));
    var hasDriftError = r.driftIssues && r.driftIssues.some(function (d) { return d.severity === "ERROR"; });
    if (hasDriftError) {
      var w = el("span", "badge drift-warn");
      w.appendChild(el("span", "d"));
      w.appendChild(document.createTextNode(" " + t("spec.driftWarn")));
      head.appendChild(w);
    }
    card.appendChild(head);

    var body = el("div", "spec-card-body");
    var any = false;

    if (isDrift && (!r.driftIssues || r.driftIssues.length === 0)) {
      body.appendChild(el("div", "drift-clean", t("drift.clean")));
      any = true;
    }

    if (r.status === "failed" && r.analysis) {
      // Tier2: the verdict block (analysis) + the grading action, always shown.
      body.appendChild(analysisSection(runId, r));
      body.appendChild(triageGradeControl(runId, r, triageState));
      // Reasoning: fold it as a Tier3 accordion, but only when it carries real
      // content. A one-char/empty reasoning behind a disclosure reads as broken
      // (the old "▸ r"), so drop it entirely below the threshold.
      var reasoning = r.analysis.reasoning ? String(r.analysis.reasoning).trim() : "";
      if (reasoning.length > 2) {
        body.appendChild(detailsBlock(t("acc.reasoning"), null, el("div", "analysis-reasoning", reasoning)));
      }
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

    if (r.driftIssues && r.driftIssues.length > 0) {
      body.appendChild(detailsBlock(t("acc.drift"), r.driftIssues.length, driftSection(r.driftIssues)));
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

  function renderMatrix(triageState) {
    var card = document.getElementById("matrix-card");
    clear(card);
    var wrap = el("div", "matrix-wrap");
    var cases = Object.keys(triageState.byKey).map(function (k) { return triageState.byKey[k]; })
      .filter(function (c) { return c.predicted && c.actual; });

    // Recompute the progress line here so it stays in sync after each grade,
    // not just on initial load.
    var total = typeof triageState.total === "number" ? triageState.total : Object.keys(triageState.byKey).length;
    document.getElementById("triage-progress").textContent =
      t("matrix.progress").replace("{n}", cases.length).replace("{total}", total);

    var summary = document.getElementById("triage-summary");

    if (cases.length === 0) {
      if (summary) summary.textContent = t("matrix.graded") + " 0 / " + total;
      wrap.appendChild(el("div", "muted", t("matrix.empty")));
      card.appendChild(wrap);
      return;
    }

    var matrix = {};
    PREDICTED_LABELS.forEach(function (p) {
      matrix[p] = {};
      FAILURE_LABELS.forEach(function (a) { matrix[p][a] = 0; });
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
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    headRow.appendChild(el("th", null, t("matrix.predicted")));
    FAILURE_LABELS.forEach(function (a) { headRow.appendChild(el("th", null, labelText(a))); });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    PREDICTED_LABELS.forEach(function (p) {
      var row = document.createElement("tr");
      row.appendChild(el("th", null, labelText(p)));
      FAILURE_LABELS.forEach(function (a) {
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

    if (summary) summary.textContent = t("matrix.graded") + " " + cases.length + " / " + total + " · " + accuracy + "%";

    card.appendChild(wrap);

    // The learn CTA only makes sense once there's at least one graded case.
    var cta = document.getElementById("learn-cta");
    if (cta) cta.hidden = cases.length === 0;
  }

  function loadTriage(runId, onLoaded) {
    apiFetch("/api/v1/runs/" + encodeURIComponent(runId) + "/triage").then(function (res) {
      var byKey = {};
      res.cases.forEach(function (c) { byKey[c.feature + "/" + c.spec] = c; });
      var triageState = { byKey: byKey, total: res.total };
      renderMatrix(triageState);
      onLoaded(triageState);
    }).catch(function (err) {
      document.getElementById("triage-progress").textContent = "Error loading triage: " + err.message;
      onLoaded({ byKey: {} });
    });
  }

  // ── run detail: orchestration ───────────────────────────────────────

  function detailError(what) {
    return function (err) {
      var e = document.getElementById("detail-error");
      e.hidden = false;
      e.textContent = what + ": " + err.message;
    };
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
    document.getElementById("triage-progress").textContent = "";
    document.getElementById("triage-summary").textContent = "";

    apiFetch("/api/v1/runs/" + encodeURIComponent(runId)).then(function (run) {
      renderRunHead(run);
    }).catch(detailError("Error loading run"));

    apiFetch("/api/v1/runs/" + encodeURIComponent(runId) + "/report").then(function (report) {
      // Draw the spec cards first from the report alone, then re-draw once
      // triage loads so the saved grades restore. Keeping these separate means
      // a triage failure (or a throw while rendering cards) can't be mislabelled
      // as the other, and neither escapes its own catch.
      var isDrift = report.kind === "drift";
      document.getElementById("triage-head").hidden = isDrift;
      document.getElementById("matrix-card").hidden = isDrift;
      document.getElementById("triage-progress").hidden = isDrift;
      renderSpecCards(runId, report.results, { byKey: {} }, isDrift);
      if (isDrift) return; // drift runs have no triage: skip loadTriage entirely
      loadTriage(runId, function (triageState) {
        renderSpecCards(runId, report.results, triageState, isDrift);
      });
    }).catch(detailError("Error loading report"));
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
  // Reserved prompt names (mirror src/prompts/prompt-names.ts), grouped into 3
  // cards. Each ".user" slot is editable; the ".agent" slots and the custom prompt
  // are ccqa-generated and read-only. Each slot names its sub-label (Your
  // instructions / Learned by ccqa) and a "when to use" hint. The triage card
  // pairs the editable triage.user guidance with the learned custom prompt.
  var CUSTOM_PROMPT_NAME = "analysis-custom-prompt";
  var PROMPT_CARDS = [
    { titleKey: "prompt.card.record", slots: [
      { name: "record.user", subKey: "prompt.sub.user", hintKey: "prompt.recordUser.hint", agent: false },
      { name: "record.agent", subKey: "prompt.sub.agent", hintKey: "prompt.recordAgent.hint", agent: true },
    ] },
    { titleKey: "prompt.card.live", slots: [
      { name: "live.user", subKey: "prompt.sub.user", hintKey: "prompt.liveUser.hint", agent: false },
      { name: "live.agent", subKey: "prompt.sub.agent", hintKey: "prompt.liveAgent.hint", agent: true },
    ] },
    { titleKey: "prompt.card.customPrompt", slots: [
      { name: "triage.user", subKey: "prompt.sub.user", hintKey: "prompt.triageUser.hint", agent: false },
      { name: CUSTOM_PROMPT_NAME, subKey: "prompt.sub.agent", hintKey: "prompt.customPrompt.hint", agent: true },
    ] },
  ];
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
    var svg = svgIcon();
    // Round caps so the "i" dot (a zero-length segment) actually paints as a
    // filled dot instead of vanishing under a butt cap at small sizes.
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "10");
    svg.appendChild(c);
    svg.appendChild(svgPath("M12 16v-4M12 8h.01"));
    span.appendChild(svg);
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

  // The custom prompt body is JSON (schemaVersion/basePromptVersion/customPromptVersion/
  // generatedAt/guidance); the textarea only ever shows the learned guidance
  // text, never the raw JSON. A parse failure falls back to the raw text so a
  // malformed custom prompt still shows something instead of leaving the UI stuck.
  function customPromptDisplayText(text) {
    if (text == null) return "";
    try {
      var parsed = JSON.parse(text);
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
          slot._ta.value = slot.name === CUSTOM_PROMPT_NAME ? customPromptDisplayText(text) : (text == null ? "" : text);
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

  // ── profile switching (Secrets-tab dropdown) ───────────────────────────
  // Profiles scope ONLY variables + sessions (a profile is a set of env vars,
  // like .ccqa/profiles/<name>.env). Prompts are project-wide and runs are
  // cross-profile, so the selector lives inside the Secrets tab, not the header.

  function setProfile(p) {
    state.profile = p || "default";
    var cur = document.getElementById("sec-profile-current");
    if (cur) cur.textContent = state.profile;
  }

  // Switch profile and reload the Secrets tab under the new scope.
  function chooseProfile(p) {
    setProfile(p);
    storeProfileForProject(state.project, state.profile);
    loadSecrets();
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

  function buildProfileMenu() {
    var menu = document.getElementById("sec-profile-menu");
    clear(menu);
    knownProfiles.forEach(function (p) {
      var mi = el("button", "mi" + (p === state.profile ? " current" : ""));
      mi.type = "button";
      mi.setAttribute("role", "menuitem");
      mi.appendChild(el("span", "name", p));
      mi.addEventListener("click", function () { closeProfileMenu(); chooseProfile(p); });
      menu.appendChild(mi);
    });
    menu.appendChild(el("div", "sep"));
    var newItem = el("button", "mi action");
    newItem.type = "button";
    newItem.setAttribute("role", "menuitem");
    newItem.appendChild(svgPlus());
    newItem.appendChild(document.createTextNode(t("app.newProfile")));
    newItem.addEventListener("click", function () { closeProfileMenu(); openProfileDialog(); });
    menu.appendChild(newItem);
  }

  function openProfileMenu() {
    if (!state.token || !state.project) return;
    buildProfileMenu();
    document.getElementById("sec-profile-menu").hidden = false;
    document.getElementById("sec-profile-switch").setAttribute("aria-expanded", "true");
  }
  function closeProfileMenu() {
    var menu = document.getElementById("sec-profile-menu");
    if (!menu) return;
    menu.hidden = true;
    document.getElementById("sec-profile-switch").setAttribute("aria-expanded", "false");
  }
  function toggleProfileMenu() {
    document.getElementById("sec-profile-menu").hidden ? openProfileMenu() : closeProfileMenu();
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
      chooseProfile(name);
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
  // Secrets-tab profile dropdown
  document.getElementById("sec-profile-switch").addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectMenu();
    toggleProfileMenu();
  });
  document.getElementById("sec-profile-menu").addEventListener("click", function (e) { e.stopPropagation(); });
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
  document.getElementById("learn-run").addEventListener("click", startLearn);
  document.getElementById("jobs-refresh").addEventListener("click", loadJobs);
  // Wrap so the click PointerEvent isn't passed as loadSecrets' statusAfter
  // argument (which would render "[object PointerEvent]" in the status box).
  document.getElementById("sec-load").addEventListener("click", function () { loadSecrets(); });

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
