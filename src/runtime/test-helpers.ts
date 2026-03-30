import { spawnSync } from "node:child_process";

const AB = new URL(import.meta.resolve("agent-browser/bin/agent-browser.js")).pathname;

function spawnAB(args: string[], stdio: "inherit" | "pipe" = "inherit"): { status: number | null; stdout: string } {
  const result = spawnSync(AB, args, { stdio });
  return { status: result.status, stdout: result.stdout?.toString().trim() ?? "" };
}

export function ab(...args: string[]): void {
  const { status } = spawnAB(args);
  if (status !== 0) throw new Error(`agent-browser ${args[0]} failed (exit ${status})`);
}

/** Wait for element/text with an explicit timeout so long-running async ops don't hang. */
export function abWait(selector: string, timeoutMs = 180_000): void {
  const args = selector.startsWith("text=")
    ? ["wait", "--text", selector.slice(5), "--timeout", String(timeoutMs)]
    : ["wait", selector, "--timeout", String(timeoutMs)];
  const { status } = spawnAB(args);
  if (status !== 0) throw new Error(`agent-browser wait failed (exit ${status})`);
}

/** Assert stable text is visible on page (via wait --text). */
export function abAssertTextVisible(text: string, timeoutMs = 30_000): void {
  const { status } = spawnAB(["wait", "--text", text, "--timeout", String(timeoutMs)]);
  if (status !== 0) throw new Error(`Assertion failed: text ${JSON.stringify(text)} not found within ${timeoutMs}ms`);
}

/** Assert element is visible (via wait). */
export function abAssertVisible(selector: string, timeoutMs = 30_000): void {
  const { status } = spawnAB(["wait", selector, "--timeout", String(timeoutMs)]);
  if (status !== 0) throw new Error(`Assertion failed: ${JSON.stringify(selector)} not visible within ${timeoutMs}ms`);
}

/** Assert element is NOT visible (via wait --state hidden). */
export function abAssertNotVisible(selector: string, timeoutMs = 30_000): void {
  const args = selector.startsWith("text=")
    ? ["wait", "--text", selector.slice(5), "--state", "hidden", "--timeout", String(timeoutMs)]
    : ["wait", selector, "--state", "hidden", "--timeout", String(timeoutMs)];
  const { status } = spawnAB(args);
  if (status !== 0) throw new Error(`Assertion failed: ${JSON.stringify(selector)} still visible after ${timeoutMs}ms`);
}

/** Assert URL contains a pattern (via get url). */
export function abAssertUrl(pattern: string): void {
  const { stdout: url } = spawnAB(["get", "url"], "pipe");
  if (!url.includes(pattern)) throw new Error(`Assertion failed: URL ${JSON.stringify(url)} does not contain ${JSON.stringify(pattern)}`);
}

/** Assert element is enabled (via is enabled). */
export function abAssertEnabled(selector: string): void {
  const { status, stdout } = spawnAB(["is", "enabled", selector], "pipe");
  if (status !== 0) throw new Error(`Assertion failed: element ${JSON.stringify(selector)} not found`);
  if (stdout !== "true") throw new Error(`Assertion failed: ${JSON.stringify(selector)} is not enabled (got: ${stdout})`);
}

/** Assert element is disabled (via is enabled). */
export function abAssertDisabled(selector: string): void {
  const { status, stdout } = spawnAB(["is", "enabled", selector], "pipe");
  if (status !== 0) throw new Error(`Assertion failed: element ${JSON.stringify(selector)} not found`);
  if (stdout !== "false") throw new Error(`Assertion failed: ${JSON.stringify(selector)} is not disabled (got: ${stdout})`);
}

/** Assert checkbox is checked (via is checked). */
export function abAssertChecked(selector: string): void {
  const { status, stdout } = spawnAB(["is", "checked", selector], "pipe");
  if (status !== 0) throw new Error(`Assertion failed: element ${JSON.stringify(selector)} not found`);
  if (stdout !== "true") throw new Error(`Assertion failed: ${JSON.stringify(selector)} is not checked (got: ${stdout})`);
}

/** Assert checkbox is unchecked (via is checked). */
export function abAssertUnchecked(selector: string): void {
  const { status, stdout } = spawnAB(["is", "checked", selector], "pipe");
  if (status !== 0) throw new Error(`Assertion failed: element ${JSON.stringify(selector)} not found`);
  if (stdout !== "false") throw new Error(`Assertion failed: ${JSON.stringify(selector)} is not unchecked (got: ${stdout})`);
}
