import { describe, expect, it } from "vitest";
import { renderPreviousRecording } from "./previous-recording.ts";
import { buildTraceSystemPrompt } from "./trace.ts";
import type { RecordedAction } from "../ir/types.ts";

const css = (value: string) => ({ by: "css" as const, value });

describe("renderPreviousRecording", () => {
  it("renders each step's actions as the commands that perform them, asserts as their marked probes", () => {
    const out = renderPreviousRecording(
      [
        { action: "cookies_clear" },
        { action: "navigate", value: "${APP_URL}/login", stepId: "step-01" },
        { action: "fill", locator: css("[type='password']"), value: "${PASSWORD}", secret: true, stepId: "step-01" },
        { action: "wait", locator: css("--load"), label: "networkidle", stepId: "step-01" },
        { action: "assert", assert: "text_visible", value: "Welcome", stepId: "step-02" },
        { action: "assert", assert: "element_visible", locator: { by: "role", value: "button", name: "Save", exact: true }, stepId: "step-02" },
        { action: "snapshot", stepId: "step-02" },
        { action: "wait", locator: css(".panel"), stepId: "step-02" },
        { action: "assert", assert: "text_visible", value: "Total $5", stepId: "step-02" },
        { action: "assert", assert: "url_contains", value: "/items?tab=a&sort=b", stepId: "step-02" },
        { action: "click", locator: css("#gone"), stepId: "step-99" },
      ],
      "S",
      new Set(["step-01", "step-02"]),
    );
    expect(out).toContain('CCQA_STEP=step-01 agent-browser --session S open "${APP_URL}/login"');
    expect(out).toContain(`CCQA_STEP=step-01 CCQA_SECRET=1 agent-browser --session S fill "[type='password']" "\${PASSWORD}"`);
    expect(out).toContain('CCQA_STEP=step-02 CCQA_ASSERT=1 agent-browser --session S wait --text "Welcome"');
    expect(out).toContain('CCQA_STEP=step-02 CCQA_ASSERT=element_visible agent-browser --session S find role "button" text --name "Save" --exact');
    expect(out).not.toContain("cookies clear");
    expect(out).not.toContain("--load");
    expect(out).not.toContain("snapshot\n");
    // A selector wait blocks the daemon; a step not offered for replay is not shown.
    expect(out).not.toContain(".panel");
    expect(out).not.toContain("#gone");
    expect(out).toContain('wait --text "Total \\$5"');
    expect(out).toContain("CCQA_ASSERT='url_contains:/items?tab=a&sort=b' agent-browser --session S get url");
  });

  it("marks failures only in the first broken step — later ones replayed on the wrong page", () => {
    const failed = (stepId: string, value: string): RecordedAction => ({
      action: "click",
      locator: css(value),
      stepId,
      replayUnstable: true,
      replayReason: "Element not found",
    });
    const out = renderPreviousRecording(
      [
        { action: "click", locator: css("#ok"), stepId: "step-01" },
        failed("step-02", "#moved"),
        { action: "assert", assert: "text_visible", value: "x", stepId: "step-02", replayUnstable: true, replayReason: "skipped after a preceding action failed" },
        failed("step-03", "#later"),
      ],
      "S",
      new Set(["step-01", "step-02", "step-03"]),
    );
    const marked = out.split("\n").filter((l) => l.includes("# did not replay last time") && l.startsWith("CCQA_STEP"));
    expect(marked).toEqual([expect.stringContaining('"#moved"')]);
  });

  it("is empty with nothing to show, and the trace prompt then has no such section", () => {
    expect(renderPreviousRecording([{ action: "cookies_clear" }], "S", new Set())).toBe("");
    const steps = [{ id: "step-01", source: "spec", instruction: "open it", expected: "" }];
    expect(buildTraceSystemPrompt({ title: "t", steps })).not.toContain("## Previous recording");
    expect(
      buildTraceSystemPrompt({
        title: "t",
        steps,
        previousRecording: {
          actions: [{ action: "navigate", value: "/", stepId: "step-01" }],
          replayable: new Set(["step-01"]),
        },
      }),
    ).toContain("## Previous recording");
  });
});
