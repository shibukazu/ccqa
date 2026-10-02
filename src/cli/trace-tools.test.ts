import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AbActionEvent } from "../claude/invoke.ts";
import { runCommands } from "./trace-tools.ts";

// Stands in for agent-browser: `#fail` fails, `get count` answers 0, anything else succeeds.
function fakeAgentBrowser(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccqa-fake-ab-"));
  const bin = join(dir, "agent-browser");
  writeFileSync(
    bin,
    '#!/bin/sh\ncase "$*" in *"#fail"*) echo "Element not found" >&2; exit 1;; *"get count"*) echo 0;; *) echo ok;; esac\n',
  );
  chmodSync(bin, 0o755);
  return dir;
}

async function run(commands: string[]) {
  const recorded: AbActionEvent[] = [];
  const text = await runCommands(commands, {
    previous: [],
    sessionName: "S",
    env: { PATH: `${fakeAgentBrowser()}:${process.env["PATH"]}` },
    envScrubMap: [],
    onReplayed: () => {},
    onAbAction: (e) => recorded.push(e),
    beforeAbCommand: () => null,
  });
  return { text, recorded };
}

describe("run_commands", () => {
  it("records each command that passes and stops at the first failure", async () => {
    const { text, recorded } = await run([
      'CCQA_STEP=step-01 agent-browser --session S click "#ok"',
      'CCQA_STEP=step-01 agent-browser --session S click "#fail"',
      'CCQA_STEP=step-01 agent-browser --session S click "#never"',
    ]);
    expect(recorded).toHaveLength(1);
    expect(text).toContain("✗");
    expect(text).toContain("1 command(s) after it were not run");
  });

  it("treats a marked check whose answer contradicts it as a failure, and records nothing for it", async () => {
    const { text, recorded } = await run([
      `CCQA_STEP=step-01 CCQA_ASSERT=element_visible agent-browser --session S get count "[aria-label='Save']"`,
    ]);
    expect(recorded).toHaveLength(0);
    expect(text).toContain("did not hold");
  });

  it("refuses what the Bash hook refuses", async () => {
    const { text, recorded } = await run(["CCQA_STEP=step-01 agent-browser --session S click @e14"]);
    expect(recorded).toHaveLength(0);
    expect(text).toContain("@ref");
  });
});
