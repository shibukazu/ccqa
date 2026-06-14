import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FAILURE_SOURCE, FAILURE_STEP_ID } from "./evidence-constants.ts";
import { sleepSync, spawnAB, type Result } from "./spawn-ab.ts";

// `ab open` returns as soon as the navigation is dispatched, but the
// daemon keeps writing to its state file for a beat afterwards. Without
// this short pause the very next assertion routinely hits EAGAIN even
// with the retry loop in `spawn-ab.ts`. 600ms covers the typical settle
// time observed in practice without adding noticeable latency to the test.
const POST_OPEN_SETTLE_MS = 600;

function logStep(action: string, args: readonly unknown[]): void {
  const pretty = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join("  ");
  process.stdout.write(`  ▶ ${action.padEnd(14)} ${pretty}\n`);
}

function fail(summary: string, result: Result): never {
  process.stdout.write(`  ✗ ${summary}\n`);
  const details = [result.stdout, result.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
  if (details) {
    for (const line of details.split("\n")) {
      process.stdout.write(`      ${line}\n`);
    }
  }
  // Capture the page state at the moment of failure so the run report can
  // show what was actually on screen when the assertion gave up. Best-effort:
  // a wedged daemon / dead browser must not turn into a different failure mode.
  captureFailureEvidence(summary);
  throw new Error(summary);
}

/**
 * Tracks the step the test is currently inside. The codegen emits one of these
 * calls right after every `// step: ...` marker so when fail() fires we know
 * which step to attribute the failure to. Older generated scripts that don't
 * emit this still work — captureFailureEvidence() falls back to a generic
 * `failure.png` when currentStep is null.
 */
let currentStep: { stepId: string; source: string } | null = null;

export function __setCurrentStep(stepId: string, source: string): void {
  currentStep = { stepId, source };
}

function captureFailureEvidence(summary: string): void {
  if (currentStep) {
    const safe = currentStep.stepId.replace(/[^A-Za-z0-9_.-]/g, "_");
    captureEvidence({
      stepId: currentStep.stepId,
      source: currentStep.source,
      pngFile: `${safe}.png`,
      failureSummary: summary,
      silent: true,
    });
    return;
  }
  captureEvidence({
    stepId: FAILURE_STEP_ID,
    source: FAILURE_SOURCE,
    pngFile: "failure.png",
    failureSummary: summary,
    silent: true,
  });
}

export function ab(...args: string[]): void {
  const [command = "", ...rest] = args;
  logStep(command, rest);
  const result = spawnAB(args);
  if (result.status !== 0) {
    fail(`agent-browser ${command} failed (exit ${result.status})`, result);
  }
  // `open` returns before the daemon finishes writing its state file. Pause
  // briefly so the very next assertion doesn't lose the race and surface as
  // a spurious EAGAIN.
  if (command === "open") sleepSync(POST_OPEN_SETTLE_MS);
}

// agent-browser's `wait <css-selector>` does NOT honour `--timeout`: when the
// selector never matches it blocks the daemon for ~150s and then dies with
// `os error 35` (EAGAIN), which cascades into every following command. Only
// `wait --text` and `wait --fn` respect the timeout. So for element-existence
// waits we poll `get count <selector>` (which returns in ~180ms whether the
// element exists or not) and enforce the timeout ourselves.
const SELECTOR_POLL_INTERVAL_MS = 500;

function selectorCount(selector: string): number {
  const r = spawnAB(["get", "count", selector]);
  if (r.status !== 0) return 0;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Poll until `get count <selector>` reaches the desired presence state or the
 * timeout elapses. `want: "present"` waits for >=1 match; `"absent"` waits for
 * 0 matches. Returns true on success, false on timeout.
 */
function pollSelector(selector: string, want: "present" | "absent", timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = selectorCount(selector);
    const ok = want === "present" ? count > 0 : count === 0;
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(SELECTOR_POLL_INTERVAL_MS);
  }
}

/** Wait for element/text with an explicit timeout so long-running async ops don't hang. */
export function abWait(selector: string, timeoutMs = 30_000): void {
  logStep("wait", [selector]);
  if (selector.startsWith("text=")) {
    // `wait --text` honours --timeout correctly.
    const result = spawnAB(["wait", "--text", selector.slice(5), "--timeout", String(timeoutMs)]);
    if (result.status !== 0) fail(`wait failed: ${selector}`, result);
    return;
  }
  // CSS selector: poll `get count` instead of `wait <selector>` (which ignores --timeout).
  if (!pollSelector(selector, "present", timeoutMs)) {
    fail(`wait failed: ${selector} not present within ${timeoutMs}ms`, { status: 1, stdout: "", stderr: "" });
  }
}

/** Assert stable text is visible on page (via wait --text). */
export function abAssertTextVisible(text: string, timeoutMs = 30_000): void {
  logStep("assert.text", [text]);
  const result = spawnAB(["wait", "--text", text, "--timeout", String(timeoutMs)]);
  if (result.status !== 0) {
    fail(`Assertion failed: text ${JSON.stringify(text)} not found within ${timeoutMs}ms`, result);
  }
}

/** Assert element is visible (polls `get count`; never uses the blocking `wait <selector>`). */
export function abAssertVisible(selector: string, timeoutMs = 30_000): void {
  logStep("assert.visible", [selector]);
  if (selector.startsWith("text=")) {
    const result = spawnAB(["wait", "--text", selector.slice(5), "--timeout", String(timeoutMs)]);
    if (result.status !== 0) fail(`Assertion failed: ${JSON.stringify(selector)} not visible within ${timeoutMs}ms`, result);
    return;
  }
  if (!pollSelector(selector, "present", timeoutMs)) {
    fail(`Assertion failed: ${JSON.stringify(selector)} not visible within ${timeoutMs}ms`, { status: 1, stdout: "", stderr: "" });
  }
}

/** Assert element is NOT visible (polls `get count` for absence; --fn for text). */
export function abAssertNotVisible(selector: string, timeoutMs = 30_000): void {
  logStep("assert.hidden", [selector]);
  if (selector.startsWith("text=")) {
    // agent-browser does not support `--text` and `--state` together.
    // For text selectors, use --fn with a negated innerText check instead.
    const result = spawnAB(["wait", "--fn", `!document.body.innerText.includes(${JSON.stringify(selector.slice(5))})`, "--timeout", String(timeoutMs)]);
    if (result.status !== 0) fail(`Assertion failed: ${JSON.stringify(selector)} still visible after ${timeoutMs}ms`, result);
    return;
  }
  if (!pollSelector(selector, "absent", timeoutMs)) {
    fail(`Assertion failed: ${JSON.stringify(selector)} still visible after ${timeoutMs}ms`, { status: 1, stdout: "", stderr: "" });
  }
}

/** Assert URL contains a pattern (via get url). */
export function abAssertUrl(pattern: string): void {
  logStep("assert.url", [pattern]);
  const result = spawnAB(["get", "url"]);
  const url = result.stdout.trim();
  if (!url.includes(pattern)) {
    fail(`Assertion failed: URL ${JSON.stringify(url)} does not contain ${JSON.stringify(pattern)}`, result);
  }
}

/** Assert element is enabled (via is enabled). */
export function abAssertEnabled(selector: string): void {
  logStep("assert.enabled", [selector]);
  const result = spawnAB(["is", "enabled", selector]);
  if (result.status !== 0) fail(`Assertion failed: element ${JSON.stringify(selector)} not found`, result);
  const value = result.stdout.trim();
  if (value !== "true") fail(`Assertion failed: ${JSON.stringify(selector)} is not enabled (got: ${value})`, result);
}

/** Assert element is disabled (via is enabled). */
export function abAssertDisabled(selector: string): void {
  logStep("assert.disabled", [selector]);
  const result = spawnAB(["is", "enabled", selector]);
  if (result.status !== 0) fail(`Assertion failed: element ${JSON.stringify(selector)} not found`, result);
  const value = result.stdout.trim();
  if (value !== "false") fail(`Assertion failed: ${JSON.stringify(selector)} is not disabled (got: ${value})`, result);
}

/** Assert checkbox is checked (via is checked). */
export function abAssertChecked(selector: string): void {
  logStep("assert.checked", [selector]);
  const result = spawnAB(["is", "checked", selector]);
  if (result.status !== 0) fail(`Assertion failed: element ${JSON.stringify(selector)} not found`, result);
  const value = result.stdout.trim();
  if (value !== "true") fail(`Assertion failed: ${JSON.stringify(selector)} is not checked (got: ${value})`, result);
}

/** Assert checkbox is unchecked (via is checked). */
export function abAssertUnchecked(selector: string): void {
  logStep("assert.unchecked", [selector]);
  const result = spawnAB(["is", "checked", selector]);
  if (result.status !== 0) fail(`Assertion failed: element ${JSON.stringify(selector)} not found`, result);
  const value = result.stdout.trim();
  if (value !== "false") fail(`Assertion failed: ${JSON.stringify(selector)} is not unchecked (got: ${value})`, result);
}

/**
 * Capture a step-boundary evidence pair (PNG + JSON metadata) so a reviewer
 * can confirm at a glance that a passing spec actually drove the app to the
 * state its `expected` describes. Opt-in at runtime via `CCQA_EVIDENCE_DIR` so
 * generated scripts hand-run outside `ccqa run` don't write stray files. All
 * errors are swallowed with a stderr warning — evidence capture must never
 * flip a passing spec to red.
 */
export function abStepEvidence(stepId: string, source: string): void {
  const safe = stepId.replace(/[^A-Za-z0-9_.-]/g, "_");
  captureEvidence({ stepId, source, pngFile: `${safe}.png` });
  // The step closed without throwing, so the next fail() (if any) belongs to
  // the NEXT step's `__setCurrentStep` — not to this one.
  if (currentStep && currentStep.stepId === stepId) currentStep = null;
}

interface CaptureOpts {
  stepId: string;
  source: string;
  pngFile: string;
  failureSummary?: string;
  /** Suppress logStep + stderr warnings. Used by the failure-path capture, which is already noisy. */
  silent?: boolean;
}

/**
 * Shared screenshot+meta pipeline behind both abStepEvidence (step boundary)
 * and captureFailureEvidence (called from fail()). The url/title eval is one
 * round-trip; agent-browser wraps eval output in JSON.stringify, so the JS
 * expression must itself stringify the payload — hence the double JSON.parse.
 */
function captureEvidence(opts: CaptureOpts): void {
  const dir = process.env["CCQA_EVIDENCE_DIR"];
  if (!dir) return;
  const { stepId, source, pngFile, failureSummary, silent } = opts;
  const pngPath = join(dir, pngFile);
  const metaPath = join(dir, pngFile.replace(/\.png$/, ".json"));
  try {
    mkdirSync(dirname(pngPath), { recursive: true });
  } catch (e) {
    if (!silent) warnEvidence(`mkdir failed (${(e as Error).message})`);
    return;
  }
  if (!silent) logStep("evidence", [stepId]);
  const shot = spawnAB(["screenshot", pngPath]);
  if (shot.status !== 0) {
    if (!silent) warnEvidence(`screenshot failed for ${stepId} (${shot.stderr.trim() || shot.stdout.trim()})`);
    return;
  }
  const { url, title } = readPageContext();
  const meta: Record<string, unknown> = {
    stepId,
    source,
    url,
    title,
    capturedAt: new Date().toISOString(),
    pngFile,
  };
  if (failureSummary !== undefined) meta["failureSummary"] = failureSummary;
  try {
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch (e) {
    if (!silent) warnEvidence(`meta write failed (${(e as Error).message})`);
  }
}

function readPageContext(): { url: string | null; title: string | null } {
  const ctx = spawnAB(["eval", "JSON.stringify({url: location.href, title: document.title})"]);
  if (ctx.status !== 0) return { url: null, title: null };
  try {
    const outer = JSON.parse(ctx.stdout.trim()) as unknown;
    const inner = typeof outer === "string" ? (JSON.parse(outer) as unknown) : outer;
    if (inner && typeof inner === "object") {
      const obj = inner as { url?: unknown; title?: unknown };
      return {
        url: typeof obj.url === "string" ? obj.url : null,
        title: typeof obj.title === "string" ? obj.title : null,
      };
    }
  } catch {
    // eval payload not JSON — leave both null, PNG alone is still useful.
  }
  return { url: null, title: null };
}

function warnEvidence(msg: string): void {
  process.stderr.write(`[ccqa] evidence: ${msg}\n`);
}

