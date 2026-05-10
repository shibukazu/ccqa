import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Use createRequire instead of import.meta.resolve so this module works under
// Vite/Vitest's SSR transform (which replaces import.meta with a shim that
// lacks .resolve). import.meta.url survives the transform, so createRequire
// based on it can still locate peer-installed packages.
const require = createRequire(import.meta.url);
const AB = require.resolve("agent-browser/bin/agent-browser.js");

type Result = { status: number | null; stdout: string; stderr: string };

// agent-browser surfaces EAGAIN (os error 35 / "Resource temporarily
// unavailable") when its state file is being written by a concurrent
// command and the reader hits the filesystem mid-flush. The flake is most
// severe right after `open` while a fresh Chrome instance is booting —
// the daemon's own internal retry budget (~ a couple of seconds) regularly
// exhausts before the state file stabilises.
//
// We wrap spawnSync with an outer retry loop that polls for up to ~30s
// before giving up. Real failures (selector mismatches, true timeouts,
// non-zero exits without the EAGAIN signature) are returned on the first
// attempt — we only loop when stdout/stderr explicitly mentions the
// EAGAIN signature.
const EAGAIN_PATTERN = /Resource temporarily unavailable|os error 35/i;
const EAGAIN_TOTAL_BUDGET_MS = 30_000;
const EAGAIN_BACKOFF_MS = [
  // Quick polls cover the common case (daemon settles in < 2s).
  100, 200, 300, 500, 700, 1000,
  // Then back off slowly through the budget for stubborn cases (a few
  // seconds of state-file contention, especially during fresh `open`).
  1500, 2000, 2500, 3000, 3000, 3000, 3000, 3000, 3000,
] as const;

// `ab open` returns as soon as the navigation is dispatched, but the
// daemon keeps writing to its state file for a beat afterwards. Without
// this short pause the very next assertion routinely hits EAGAIN even
// with the retry loop above. 600ms covers the typical settle time
// observed in practice without adding noticeable latency to the test.
const POST_OPEN_SETTLE_MS = 600;

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

// Hard ceiling on a single agent-browser invocation. agent-browser is
// supposed to honor its own --timeout, but if the daemon is wedged (stale
// session, dead Chrome) spawnSync would otherwise wait forever because
// stdio never closes. 90s is well past wait --timeout 30000ms + the
// 30s EAGAIN budget, so legitimate work always completes first.
const PROCESS_HARD_TIMEOUT_MS = 90_000;

function spawnABOnce(args: string[]): Result {
  const result = spawnSync(AB, args, { stdio: "pipe", timeout: PROCESS_HARD_TIMEOUT_MS });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr:
      (result.stderr?.toString() ?? "") +
      (result.signal === "SIGTERM" ? "\n[ccqa] agent-browser killed after hard timeout" : ""),
  };
}

function spawnAB(args: string[]): Result {
  let result = spawnABOnce(args);
  let elapsed = 0;
  let attempt = 0;
  while (result.status !== 0 && elapsed < EAGAIN_TOTAL_BUDGET_MS) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (!EAGAIN_PATTERN.test(combined)) return result;
    const wait = EAGAIN_BACKOFF_MS[attempt] ?? 3000;
    sleepSync(wait);
    elapsed += wait;
    attempt++;
    result = spawnABOnce(args);
  }
  return result;
}

function logStep(action: string, args: readonly unknown[]): void {
  const pretty = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join("  ");
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
