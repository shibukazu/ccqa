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
  throw new Error(summary);
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

