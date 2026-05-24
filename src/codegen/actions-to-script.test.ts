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

    it("expands env refs in `wait` selectors (regression: used to emit a plain string)", () => {
      const actions: TraceAction[] = [
        { command: "wait", selector: "text=run-${CCQA_TEST_RUN_ID}" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abWait(`text=run-${process.env.CCQA_TEST_RUN_ID ?? ""}`);');
      expect(script).not.toMatch(/abWait\("text=run-\${CCQA_TEST_RUN_ID}"\)/);
    });

    it("keeps a plain `wait` selector as a regular string literal", () => {
      const actions: TraceAction[] = [
        { command: "wait", selector: "text=Done" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abWait("text=Done");');
    });

    it("emits a raw ab(\"wait\", ...) for flag-form waits (--load networkidle), not abWait", () => {
      const actions: TraceAction[] = [
        { command: "wait", selector: "--load", label: "networkidle" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("wait", "--load", "networkidle");');
      // Must NOT become abWait("--load") — that would poll get count "--load".
      expect(script).not.toContain('abWait("--load")');
    });
  });

  describe("find_* commands", () => {
    it("emits ab(\"find\", \"text\", value, \"click\") for find_click + text locator", () => {
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "text", findValue: "Sign In" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "text", "Sign In", "click")');
    });

    it("expands `${ENV}` in findValue (text locator)", () => {
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "text", findValue: "run-${CCQA_RUN_ID}" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('`run-${process.env.CCQA_RUN_ID ?? ""}`');
    });

    it("emits --exact AFTER the action token (agent-browser argv order)", () => {
      // Regression: previously emitted `find text "OK" --exact click`, which
      // agent-browser rejects with "Unknown subaction: --exact". The correct
      // shape is `find text "OK" click --exact`.
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "text", findValue: "OK", findExact: true },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "text", "OK", "click", "--exact")');
    });

    it("emits --name AFTER the action token for role locator", () => {
      // Regression: see above — `Unknown subaction: --name` came from putting
      // the flag before `click`.
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "role", findValue: "button", findName: "Submit" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "role", "button", "click", "--name", "Submit")');
    });

    it("emits inner selector literally for `last` (no env-expansion)", () => {
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "last", findValue: "[aria-label='Reply']" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "last", "[aria-label=\'Reply\']", "click")');
    });

    it("emits the index for `nth`", () => {
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "nth", findValue: "button.reply", findIndex: 2 },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "nth", "2", "button.reply", "click")');
    });

    it("emits the fill input after the action for find_fill", () => {
      const actions: TraceAction[] = [
        { command: "find_fill", findLocator: "label", findValue: "Email", value: "user@example.com" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "label", "Email", "fill", "user@example.com")');
    });

    it("never emits --name when locator is not role (defensive)", () => {
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "text", findValue: "Sign In", findName: "ignored" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain('"--name"');
      expect(script).not.toContain('"ignored"');
    });

    it("emits a // [warn] marker (not a broken ab() line) when find_click lacks findLocator", () => {
      // Regression: previously emitted `ab("find", , , "click")` which is a
      // TS syntax error and crashes the generated test at parse time. Now we
      // surface a visible breadcrumb so CI logs flag the upstream corruption.
      const actions: TraceAction[] = [
        { command: "find_click" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("ab(\"find\"");
      expect(script).not.toMatch(/ab\([^)]*,\s*,/);
      expect(script).toContain("[warn] find_* dropped: find_click");
    });

    it("emits a // [warn] marker when find_click lacks findValue", () => {
      const actions: TraceAction[] = [
        { command: "find_click", findLocator: "text", stepId: "step-03" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("ab(\"find\"");
      expect(script).not.toMatch(/ab\([^)]*,\s*,/);
      expect(script).toContain("[warn] find_* dropped: find_click");
      expect(script).toContain("stepId=step-03");
    });
  });

  describe("emptySteps notices", () => {
    it("injects a warning block for a spec step that lost all its actions", () => {
      const actions: TraceAction[] = [
        { command: "open", value: "/", stepId: "step-01" },
      ];
      const script = actionsToScript({
        actions,
        testName: "demo",
        emptySteps: [{ stepId: "step-02", source: "spec", insertAfterIndex: 0 }],
      });
      expect(script).toContain("// step: step-02 [spec]");
      expect(script).toContain("[warn] all actions for this step were dropped during post-trace validation");
      expect(script).toMatch(/step step-02/);
    });

    it("places a notice before the first action when insertAfterIndex is -1", () => {
      const actions: TraceAction[] = [
        { command: "click", selector: "[aria-label='X']", stepId: "step-02" },
      ];
      const script = actionsToScript({
        actions,
        testName: "demo",
        emptySteps: [{ stepId: "step-01", source: "spec", insertAfterIndex: -1 }],
      });
      const stepCommentIdx = script.indexOf("// step: step-01");
      const clickIdx = script.indexOf('ab("click"');
      expect(stepCommentIdx).toBeGreaterThan(-1);
      expect(clickIdx).toBeGreaterThan(stepCommentIdx);
    });

    it("emits one notice per lost step in order", () => {
      const actions: TraceAction[] = [
        { command: "open", value: "/", stepId: "step-01" },
      ];
      const script = actionsToScript({
        actions,
        testName: "demo",
        emptySteps: [
          { stepId: "step-02", source: "spec", insertAfterIndex: 0 },
          { stepId: "step-03", source: "spec", insertAfterIndex: 0 },
        ],
      });
      expect(script).toContain("// step: step-02 [spec]");
      expect(script).toContain("// step: step-03 [spec]");
      expect(script.indexOf("step-02")).toBeLessThan(script.indexOf("step-03"));
    });
  });

  describe("replayUnstable comments", () => {
    it("emits a `// [warn] replay-unstable:` line before an action carrying the flag", () => {
      const actions: TraceAction[] = [
        { command: "open", value: "/", stepId: "step-01" },
        {
          command: "click",
          selector: "[aria-label='Delete']",
          stepId: "step-01",
          replayUnstable: true,
          replayReason: "selector not found on fresh session",
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      const warnIdx = script.indexOf("[warn] replay-unstable");
      const lineIdx = script.indexOf(`ab("click", "[aria-label='Delete']")`);
      expect(warnIdx).toBeGreaterThan(-1);
      expect(lineIdx).toBeGreaterThan(warnIdx);
      expect(script).toContain("selector not found on fresh session");
    });

    it("does NOT add the comment when replayUnstable is absent (default behaviour)", () => {
      const actions: TraceAction[] = [
        { command: "click", selector: "[aria-label='OK']" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("[warn] replay-unstable");
    });

    it("falls back to a placeholder when replayReason is missing", () => {
      const actions: TraceAction[] = [
        { command: "click", selector: "[aria-label='X']", replayUnstable: true },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain("[warn] replay-unstable: (no reason recorded)");
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
