import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { agentBrowserInvokeBase } from "../../../src/claude/agent-browser-invoke.ts";
import { runCommands } from "../../../src/cli/trace-tools.ts";
import { spawnAB } from "../../../src/runtime/spawn-ab.ts";
import { realBrowserAvailable } from "../_helpers/real-browser.ts";

const SESSION = `ccqa-e2e-covered-${process.pid}`;

const PAGE = `<!doctype html><html><body style="margin:0">
<div style="height:640px"></div>
<button type="button" id="add" onclick="document.getElementById('out').textContent+='added;'">Add item</button>
<div style="height:600px"></div>
<div id="out"></div>
<div style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#333">
  <button type="button">Save</button>
</div>
</body></html>`;

const ab = (...args: string[]) => spawnAB(["--session", SESSION, ...args]);
const out = () => ab("get", "text", "#out").stdout.trim();

// A button inside the viewport but under a fixed footer, which agent-browser refuses
// to click.
describe.skipIf(!realBrowserAvailable())("a click on an element under a fixed footer", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ccqa-covered-"));
    writeFileSync(join(dir, "page.html"), PAGE);
  });

  afterAll(() => {
    ab("close");
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    ab("set", "viewport", "1280", "720");
    expect(ab("open", `file://${join(dir, "page.html")}`).status).toBe(0);
  });

  test.each([
    ["a selector", ["click", "#add"]],
    ["a role locator", ["find", "role", "button", "click", "--name", "Add item", "--exact"]],
    ["a positional locator", ["find", "first", "#add", "click"]],
  ])("goes through spawnAB with %s", (_, args) => {
    expect(ab(...args).status).toBe(0);
    expect(out()).toBe("added;");
  });

  test("goes through run_commands and is recorded once", async () => {
    const recorded: unknown[] = [];
    const text = await runCommands([`CCQA_STEP=step-01 agent-browser click "#add"`], {
      previous: [],
      sessionName: SESSION,
      env: agentBrowserInvokeBase({ sessionName: SESSION, runId: SESSION }).env ?? {},
      envScrubMap: [],
      onReplayed: () => {},
      onAbAction: (e) => recorded.push(e),
      beforeAbCommand: () => null,
    });
    expect(text).toContain("✓");
    expect(recorded).toHaveLength(1);
    expect(out()).toBe("added;");
  });
});
