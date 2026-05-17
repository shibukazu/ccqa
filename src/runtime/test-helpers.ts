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

/** Wait for element/text with an explicit timeout so long-running async ops don't hang. */
export function abWait(selector: string, timeoutMs = 180_000): void {
  logStep("wait", [selector]);
  const args = selector.startsWith("text=")
    ? ["wait", "--text", selector.slice(5), "--timeout", String(timeoutMs)]
    : ["wait", selector, "--timeout", String(timeoutMs)];
  const result = spawnAB(args);
  if (result.status !== 0) {
    fail(`wait failed: ${selector}`, result);
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

/** Assert element is visible (via wait). */
export function abAssertVisible(selector: string, timeoutMs = 30_000): void {
  logStep("assert.visible", [selector]);
  const result = spawnAB(["wait", selector, "--timeout", String(timeoutMs)]);
  if (result.status !== 0) {
    fail(`Assertion failed: ${JSON.stringify(selector)} not visible within ${timeoutMs}ms`, result);
  }
}

/** Assert element is NOT visible (via wait --state hidden or --fn for text). */
export function abAssertNotVisible(selector: string, timeoutMs = 30_000): void {
  logStep("assert.hidden", [selector]);
  // agent-browser does not support `--text` and `--state` together.
  // For text selectors, use --fn with a negated innerText check instead.
  const args = selector.startsWith("text=")
    ? ["wait", "--fn", `!document.body.innerText.includes(${JSON.stringify(selector.slice(5))})`, "--timeout", String(timeoutMs)]
    : ["wait", selector, "--state", "hidden", "--timeout", String(timeoutMs)];
  const result = spawnAB(args);
  if (result.status !== 0) {
    fail(`Assertion failed: ${JSON.stringify(selector)} still visible after ${timeoutMs}ms`, result);
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

