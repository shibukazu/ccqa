import { describe, expect, it } from "vitest";
import { actionsToScript, type StepMarker } from "./actions-to-script.ts";
import type { TraceAction } from "../types.ts";

describe("actionsToScript", () => {
  it("emits ab() lines for a simple open + fill + assert sequence", () => {
    const actions: TraceAction[] = [
      { command: "open", value: "http://localhost:3000/login" },
      { command: "fill", selector: "[type='password']", value: "literal" },
      { command: "assert", assertType: "text_visible", value: "Welcome" },
    ];
    const script = actionsToScript({ actions, testName: "demo" });
    expect(script).toContain(`ab("open", "http://localhost:3000/login")`);
    expect(script).toContain(`ab("fill", "[type='password']", "literal")`);
    expect(script).toContain(`abAssertTextVisible("Welcome")`);
  });

  describe("env var expansion", () => {
    it("expands $VAR in a fill value to process.env.VAR", () => {
      const actions: TraceAction[] = [
        {
          command: "fill",
          selector: "[placeholder='email']",
          value: "$CCQA_EMAIL",
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain(
        'ab("fill", "[placeholder=\'email\']", `${process.env.CCQA_EMAIL ?? ""}`)',
      );
      // Critically, the literal "$CCQA_EMAIL" string must NOT appear in the
      // generated script's RHS (it would otherwise be typed into the form
      // verbatim).
      expect(script).not.toMatch(/"\$CCQA_EMAIL"/);
    });

    it("expands ${VAR} in a fill value", () => {
      const actions: TraceAction[] = [
        {
          command: "fill",
          selector: "[type='password']",
          value: "${CCQA_PASSWORD}",
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('`${process.env.CCQA_PASSWORD ?? ""}`');
    });

    it("expands env refs in open URLs", () => {
      const actions: TraceAction[] = [{ command: "open", value: "${APP_URL}/articles" }];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("open", `${process.env.APP_URL ?? ""}/articles`)');
    });

    it("expands env refs in assertion values (text_visible, url_contains)", () => {
      const actions: TraceAction[] = [
        { command: "assert", assertType: "text_visible", value: "Welcome ${USER_NAME}" },
        { command: "assert", assertType: "url_contains", value: "${APP_PATH}/done" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abAssertTextVisible(`Welcome ${process.env.USER_NAME ?? ""}`)');
      expect(script).toContain('abAssertUrl(`${process.env.APP_PATH ?? ""}/done`)');
    });

    it("leaves literal values without env refs as JSON strings", () => {
      const actions: TraceAction[] = [
        { command: "fill", selector: "x", value: "plain literal" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("fill", "x", "plain literal")');
    });

    it("does not transform selectors (a $ in a selector is treated literally)", () => {
      const actions: TraceAction[] = [
        { command: "click", selector: "[data-id='$weird']" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("click", "[data-id=\'$weird\']")');
    });
  });

  describe("step markers", () => {
    it("places exactly one marker at the first action of each contiguous stepId run", () => {
      const actions: TraceAction[] = [
        { command: "cookies_clear", stepId: "step-01" },
        { command: "open", value: "https://idp/", stepId: "step-01" },
        { command: "fill", selector: "[type='email']", value: "a@b", stepId: "step-02" },
        { command: "fill", selector: "[type='password']", value: "p", stepId: "step-02" },
        { command: "press", value: "Enter", stepId: "step-02" },
        { command: "open", value: "https://app/", stepId: "step-03" },
      ];
      const markers: StepMarker[] = [
        { actionIndex: 0, stepId: "step-01", source: "login" },
        { actionIndex: 2, stepId: "step-02", source: "login" },
        { actionIndex: 5, stepId: "step-03", source: "spec" },
      ];
      const script = actionsToScript({ actions, testName: "demo", stepMarkers: markers });

      const commentLines = script.split("\n").filter((l) => l.trim().startsWith("// step:"));
      expect(commentLines).toEqual([
        "  // step: step-01 [login]",
        "  // step: step-02 [login]",
        "  // step: step-03 [spec]",
      ]);

      // The fill lines must appear BETWEEN the step-02 and step-03 markers,
      // never under step-01.
      const step02Idx = script.indexOf("step-02 [login]");
      const step03Idx = script.indexOf("step-03 [spec]");
      const fillIdx = script.indexOf(`"[type='email']"`);
      expect(fillIdx).toBeGreaterThan(step02Idx);
      expect(fillIdx).toBeLessThan(step03Idx);
    });

    it("inserts a blank line before each step marker except the first", () => {
      const actions: TraceAction[] = [
        { command: "open", value: "a", stepId: "step-01" },
        { command: "open", value: "b", stepId: "step-02" },
      ];
      const markers: StepMarker[] = [
        { actionIndex: 0, stepId: "step-01", source: "spec" },
        { actionIndex: 1, stepId: "step-02", source: "spec" },
      ];
      const script = actionsToScript({ actions, testName: "demo", stepMarkers: markers });
      // The second marker should be preceded by an empty line within the test body.
      // (Each test-body line is indented two spaces, so the blank line shows
      // up as `\n  \n` between consecutive sections.)
      expect(script).toMatch(/\n  \n  \/\/ step: step-02/);
    });
  });

  describe("inlined block source tag", () => {
    it("labels step markers with the source coming from the block name", () => {
      const actions: TraceAction[] = [
        { command: "open", value: "/login", stepId: "step-01" },
        { command: "fill", selector: "[type='email']", value: "u", stepId: "step-01" },
        { command: "open", value: "/home", stepId: "step-02" },
      ];
      const script = actionsToScript({
        actions,
        testName: "demo",
        stepMarkers: [
          { actionIndex: 0, stepId: "step-01", source: "login" },
          { actionIndex: 2, stepId: "step-02", source: "spec" },
        ],
      });
      expect(script).toContain("// step: step-01 [login]");
      expect(script).toContain("// step: step-02 [spec]");
    });
  });
});
