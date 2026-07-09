import { describe, expect, test } from "vitest";
import { agentBrowserInvokeBase } from "./agent-browser-invoke.ts";

describe("agentBrowserInvokeBase", () => {
  test("exposes session + run id + PATH in env, and the standard allowed tools", () => {
    const base = agentBrowserInvokeBase({ sessionName: "sess-1", runId: "run-1" });
    expect(base.env).toMatchObject({
      AGENT_BROWSER_SESSION: "sess-1",
      CCQA_RUN_ID: "run-1",
    });
    expect(base.env?.["PATH"]).toBeTypeOf("string");
    expect(base.allowedTools).toEqual(["Bash(*)", "Read", "Grep", "Glob"]);
  });

  test("CCQA_RUN_ID lets the model and any Bash it spawns share a single per-run id", () => {
    const a = agentBrowserInvokeBase({ sessionName: "sess", runId: "abc" });
    const b = agentBrowserInvokeBase({ sessionName: "sess", runId: "xyz" });
    expect(a.env?.["CCQA_RUN_ID"]).toBe("abc");
    expect(b.env?.["CCQA_RUN_ID"]).toBe("xyz");
  });
});
