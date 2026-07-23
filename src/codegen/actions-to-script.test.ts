import { describe, expect, it } from "vitest";
import { actionsToScript, type StepMarker } from "./actions-to-script.ts";
import type { RecordedAction } from "../types.ts";

const css = (value: string) => ({ by: "css", value }) as const;

describe("actionsToScript", () => {
  it("emits ab() lines for a simple navigate + fill + assert sequence", () => {
    const actions: RecordedAction[] = [
      { action: "navigate", value: "http://localhost:3000/login" },
      { action: "fill", locator: css("[type='password']"), value: "literal" },
      { action: "assert", assert: "text_visible", value: "Welcome" },
    ];
    const script = actionsToScript({ actions, testName: "demo" });
    expect(script).toContain(`ab("open", "http://localhost:3000/login")`);
    expect(script).toContain(`ab("fill", "[type='password']", "literal")`);
    expect(script).toContain(`abAssertTextVisible("Welcome")`);
  });

  describe("input-value-trap assertions", () => {
    it("drops a text_visible assert whose value was just typed into a field this step", () => {
      const actions: RecordedAction[] = [
        { action: "fill", locator: css("[aria-label='Title']"), value: "created-item-42", stepId: "step-06" },
        { action: "assert", assert: "text_visible", value: "created-item-42", stepId: "step-06" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // The fill stays; the reflection assert on the typed value is dropped.
      expect(script).toContain('ab("fill", "[aria-label=\'Title\']", "created-item-42")');
      expect(script).not.toMatch(/abAssertTextVisible\("created-item-42"\)/);
      expect(script).toContain("dropped input-value assert");
    });

    it("drops the same trap for semantic-locator fills", () => {
      const actions: RecordedAction[] = [
        { action: "fill", locator: { by: "label", value: "Title" }, value: "my-title", stepId: "step-06" },
        { action: "assert", assert: "text_visible", value: "my-title", stepId: "step-06" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toMatch(/abAssertTextVisible\("my-title"\)/);
    });

    it("KEEPS a text_visible assert for a value NOT typed this step (real result-page check)", () => {
      const actions: RecordedAction[] = [
        { action: "fill", locator: css("[aria-label='Title']"), value: "created-item-42", stepId: "step-06" },
        // Different step: asserting the row shows up on the list — a genuine check.
        { action: "assert", assert: "text_visible", value: "created-item-42", stepId: "step-07" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toMatch(/abAssertTextVisible\("created-item-42"\)/);
    });
  });

  describe("post-navigate settle sleep", () => {
    it("inserts a settle sleep before the first element interaction after navigate", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/login" },
        { action: "fill", locator: css("[type='email']"), value: "a@b" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toMatch(/ab\("open", "\/login"\);\s*\n\s*spawnSync\("sleep", \["3"\]/);
    });

    it("still inserts the settle sleep when a snapshot/assert sits between navigate and the first interaction", () => {
      // Regression: the latch must survive intervening non-interaction lines
      // (a snapshot comment, a dropped over-assertion breadcrumb) so the
      // freshly-navigated page still gets time to render. Previously the sleep
      // was keyed on `prevAction === "navigate"` and got swallowed.
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/login" },
        { action: "snapshot", observation: "login form" },
        { action: "assert", assert: "element_visible", locator: css("[aria-label='Email']"),
          replayUnstable: true, replayReason: "selector not present within 10000ms (get count returned 0)" },
        { action: "fill", locator: css("[type='email']"), value: "a@b" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // The sleep must appear before the fill, even though snapshot + dropped
      // over-assertion lines came between navigate and fill.
      const sleepIdx = script.indexOf('spawnSync("sleep", ["3"]');
      const fillIdx = script.indexOf('ab("fill", "[type=\'email\']"');
      expect(sleepIdx).toBeGreaterThan(-1);
      expect(fillIdx).toBeGreaterThan(sleepIdx);
    });

    it("inserts only one settle sleep per navigate even with multiple interactions", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/login" },
        { action: "fill", locator: css("[type='email']"), value: "a@b" },
        { action: "fill", locator: css("[type='password']"), value: "pw" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script.match(/spawnSync\("sleep", \["3"\]/g)).toHaveLength(1);
    });
  });

  describe("ref-selector skipping", () => {
    it("skips an action whose selector is a bare @ref", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("@e14") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("@e14");
    });

    it("skips an assert whose selector embeds a ref attribute (button[ref='e4'])", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_enabled", locator: css("button[ref='e4']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("ref='e4'");
      // abAssertEnabled appears in the import line; assert there's no CALL.
      expect(script).not.toMatch(/abAssertEnabled\(/);
    });

    it("does NOT skip a legitimate selector that merely contains the letters 'ref'", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[aria-label='Preferences']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain("[aria-label='Preferences']");
    });
  });

  describe("tautological state-assert dropping", () => {
    it("drops element_disabled whose selector is button[disabled] (tautology)", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_disabled", locator: css("button[disabled]") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toMatch(/abAssertDisabled\(/);
      expect(script).toContain("dropped tautological assert");
    });

    it("drops element_enabled whose selector uses the :enabled pseudo-class", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_enabled", locator: css("button:enabled") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toMatch(/abAssertEnabled\(/);
      expect(script).toContain("dropped tautological assert");
    });

    it("drops element_disabled selecting by [aria-disabled='true']", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_disabled", locator: css("[aria-disabled='true']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toMatch(/abAssertDisabled\(/);
      expect(script).toContain("dropped tautological assert");
    });

    it("KEEPS element_disabled with a state-independent selector (real check)", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_disabled", locator: css("#submit-btn") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abAssertDisabled("#submit-btn");');
      expect(script).not.toContain("dropped tautological assert");
    });

    it("KEEPS element_enabled with a data-testid selector", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_enabled", locator: css("[data-testid='save']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain(`abAssertEnabled("[data-testid='save']");`);
      expect(script).not.toContain("dropped tautological assert");
    });
  });

  describe("env var expansion", () => {
    it("expands $VAR in a fill value to process.env.VAR", () => {
      const actions: RecordedAction[] = [
        {
          action: "fill",
          locator: css("[placeholder='email']"),
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
      const actions: RecordedAction[] = [
        {
          action: "fill",
          locator: css("[type='password']"),
          value: "${CCQA_PASSWORD}",
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('`${process.env.CCQA_PASSWORD ?? ""}`');
    });

    it("expands env refs in opened URLs", () => {
      const actions: RecordedAction[] = [{ action: "navigate", value: "${APP_URL}/articles" }];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("open", `${process.env.APP_URL ?? ""}/articles`)');
    });

    it("expands env refs in assertion values (text_visible, url_contains)", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "text_visible", value: "Welcome ${USER_NAME}" },
        { action: "assert", assert: "url_contains", value: "${APP_PATH}/done" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abAssertTextVisible(`Welcome ${process.env.USER_NAME ?? ""}`)');
      expect(script).toContain('abAssertUrl(`${process.env.APP_PATH ?? ""}/done`)');
    });

    it("leaves literal values without env refs as JSON strings", () => {
      const actions: RecordedAction[] = [
        { action: "fill", locator: css("x"), value: "plain literal" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("fill", "x", "plain literal")');
    });

    it("expands ${VAR} in a css selector on an element_not_visible assert (deletion-verify bug)", () => {
      // The reported bug: the css selector's `${VAR}` baked in verbatim, so the
      // selector matched nothing and the deletion assert passed unconditionally.
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_not_visible", locator: css("text=ccqa-item-${CCQA_RUN_ID}") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abAssertNotVisible(`text=ccqa-item-${process.env.CCQA_RUN_ID ?? ""}`);');
      expect(script).not.toMatch(/ccqa-item-\$\{CCQA_RUN_ID\}/);
    });

    it("expands ${VAR} in a css selector on an interaction (click)", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[data-row='item-${CCQA_RUN_ID}']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("click", `[data-row=\'item-${process.env.CCQA_RUN_ID ?? ""}\']`)');
    });

    it("escapes backticks in a css selector carrying an env ref (no template-literal breakout)", () => {
      const actions: RecordedAction[] = [
        { action: "assert", assert: "element_not_visible", locator: css("text=`x` ${CCQA_RUN_ID}") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // The ref expands and the literal backticks are escaped so they can't
      // close the emitted template literal early.
      expect(script).toContain('${process.env.CCQA_RUN_ID ?? ""}');
      expect(script).toContain("\\`x\\`");
    });

    it("keeps a CSS `$=` ends-with operator literal (not a well-formed env ref)", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[href$='.pdf']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("click", "[href$=\'.pdf\']")');
    });

    it("expands env refs in `wait` text locators (regression: used to emit a plain string)", () => {
      const actions: RecordedAction[] = [
        { action: "wait", locator: { by: "text", value: "run-${CCQA_TEST_RUN_ID}" } },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abWait(`text=run-${process.env.CCQA_TEST_RUN_ID ?? ""}`);');
      expect(script).not.toMatch(/abWait\("text=run-\${CCQA_TEST_RUN_ID}"\)/);
    });

    it("keeps a plain `wait` text locator as a regular string literal", () => {
      const actions: RecordedAction[] = [
        { action: "wait", locator: { by: "text", value: "Done" } },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('abWait("text=Done");');
    });

    it("skips flag-form waits (--load / --fn / --url) entirely — their argument can't round-trip", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/" },
        { action: "wait", locator: css("--load"), label: "networkidle" },
        { action: "wait", locator: css("--fn"), label: "window.ready" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // No broken `ab("wait", "--load")` / `ab("wait", "--fn")` and no abWait("--*").
      expect(script).not.toContain('"--load"');
      expect(script).not.toContain('"--fn"');
      expect(script).not.toMatch(/abWait\("--/);
    });
  });

  describe("find-form locators", () => {
    it("emits ab(\"find\", \"text\", value, \"click\") for a text-locator click", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: { by: "text", value: "Sign In" } },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "text", "Sign In", "click")');
    });

    it("expands `${ENV}` in the locator value (text locator)", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: { by: "text", value: "run-${CCQA_RUN_ID}" } },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('`run-${process.env.CCQA_RUN_ID ?? ""}`');
    });

    it("emits --exact AFTER the action token (agent-browser argv order)", () => {
      // Regression: previously emitted `find text "OK" --exact click`, which
      // agent-browser rejects with "Unknown subaction: --exact". The correct
      // shape is `find text "OK" click --exact`.
      const actions: RecordedAction[] = [
        { action: "click", locator: { by: "text", value: "OK", exact: true } },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "text", "OK", "click", "--exact")');
    });

    it("emits --name AFTER the action token for role locators", () => {
      // Regression: see above — `Unknown subaction: --name` came from putting
      // the flag before `click`.
      const actions: RecordedAction[] = [
        { action: "click", locator: { by: "role", value: "button", name: "Submit" } },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "role", "button", "click", "--name", "Submit")');
    });

    it("emits the inner selector literally for `last` (no env-expansion)", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[aria-label='Reply']"), index: "last" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "last", "[aria-label=\'Reply\']", "click")');
    });

    it("emits the index for `nth`", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("button.reply"), index: 2 },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "nth", "2", "button.reply", "click")');
    });

    it("emits the fill input after the action for semantic-locator fills", () => {
      const actions: RecordedAction[] = [
        { action: "fill", locator: { by: "label", value: "Email" }, value: "user@example.com" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain('ab("find", "label", "Email", "fill", "user@example.com")');
    });

    it("emits a // [warn] marker (not a broken ab() line) when an element action lacks its locator", () => {
      // Regression: previously emitted `ab("find", , , "click")` which is a
      // TS syntax error and crashes the generated test at parse time. Now we
      // surface a visible breadcrumb so CI logs flag the upstream corruption.
      const actions: RecordedAction[] = [
        { action: "click" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("ab(\"find\"");
      expect(script).not.toMatch(/ab\([^)]*,\s*,/);
      expect(script).toContain("[warn] action dropped: click");
    });

    it("includes the stepId in the dropped-action marker when present", () => {
      const actions: RecordedAction[] = [
        { action: "click", stepId: "step-03" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain("[warn] action dropped: click");
      expect(script).toContain("stepId=step-03");
    });
  });

  describe("upload action", () => {
    it("emits abUpload(...) with a single literal file path", () => {
      const actions: RecordedAction[] = [
        {
          action: "upload",
          locator: css("[aria-label='Attach']"),
          files: ["/tmp/sample.pdf"],
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain(`abUpload("[aria-label='Attach']", "/tmp/sample.pdf")`);
    });

    it("expands ${ENV_VAR} refs in file paths to template literals", () => {
      const actions: RecordedAction[] = [
        {
          action: "upload",
          locator: css("[type='file']"),
          files: ["${CCQA_FIXTURES_DIR}/a.pdf"],
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // File paths become back-tick template literals — the same shape used
      // for fill values.
      expect(script).toMatch(/abUpload\("\[type='file'\]", `\$\{process\.env\.CCQA_FIXTURES_DIR \?\? ""\}\/a\.pdf`\)/);
    });

    it("emits multiple positional file args", () => {
      const actions: RecordedAction[] = [
        {
          action: "upload",
          locator: css("[aria-label='Attach']"),
          files: ["/tmp/a.png", "/tmp/b.png"],
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain(`abUpload("[aria-label='Attach']", "/tmp/a.png", "/tmp/b.png")`);
    });

    it("imports abUpload from ccqa/test-helpers", () => {
      const actions: RecordedAction[] = [
        { action: "upload", locator: css("[type='file']"), files: ["/tmp/a.png"] },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toMatch(/import \{[^}]*\babUpload\b[^}]*\} from "ccqa\/test-helpers"/);
    });

    it("skips upload missing locator or files", () => {
      const actions: RecordedAction[] = [
        { action: "upload", files: ["/tmp/a.png"] },
        { action: "upload", locator: css("[type='file']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("abUpload(");
    });
  });

  describe("emptySteps notices", () => {
    it("injects a warning block for a spec step that lost all its actions", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/", stepId: "step-01" },
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
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[aria-label='X']"), stepId: "step-02" },
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
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/", stepId: "step-01" },
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
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/", stepId: "step-01" },
        {
          action: "click",
          locator: css("[aria-label='Delete']"),
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
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[aria-label='OK']") },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("[warn] replay-unstable");
    });

    it("falls back to a placeholder when replayReason is missing", () => {
      const actions: RecordedAction[] = [
        { action: "click", locator: css("[aria-label='X']"), replayUnstable: true },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).toContain("[warn] replay-unstable: (no reason recorded)");
    });

    it("drops an element assert whose selector the validator could not find (over-assertion)", () => {
      const actions: RecordedAction[] = [
        {
          action: "assert",
          assert: "element_visible",
          locator: css("[aria-label='Email']"),
          replayUnstable: true,
          replayReason: "selector not present within 10000ms (get count returned 0)",
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // No abAssertVisible CALL — the over-assertion is dropped, only the warning comment remains.
      expect(script).not.toMatch(/abAssertVisible\(/);
      expect(script).toContain("[warn] replay-unstable");
    });

    it("KEEPS a replay-unstable assert that merely timed out (may pass in a real run)", () => {
      const actions: RecordedAction[] = [
        {
          action: "assert",
          assert: "text_visible",
          value: "Created",
          replayUnstable: true,
          replayReason: "✗ Wait timed out after 10000ms",
        },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      // Timed-out (not "selector not present") asserts are retained.
      expect(script).toMatch(/abAssertTextVisible\(/);
    });
  });

  describe("step markers", () => {
    it("places exactly one marker at the first action of each contiguous stepId run", () => {
      const actions: RecordedAction[] = [
        { action: "cookies_clear", stepId: "step-01" },
        { action: "navigate", value: "https://idp/", stepId: "step-01" },
        { action: "fill", locator: css("[type='email']"), value: "a@b", stepId: "step-02" },
        { action: "fill", locator: css("[type='password']"), value: "p", stepId: "step-02" },
        { action: "press", value: "Enter", stepId: "step-02" },
        { action: "navigate", value: "https://app/", stepId: "step-03" },
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

    it("emits abStepEvidence at every step boundary and once at the end", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "https://idp/", stepId: "step-01" },
        { action: "fill", locator: css("[type='email']"), value: "a@b", stepId: "step-02" },
        { action: "navigate", value: "https://app/", stepId: "step-03" },
      ];
      const markers: StepMarker[] = [
        { actionIndex: 0, stepId: "step-01", source: "login" },
        { actionIndex: 1, stepId: "step-02", source: "login" },
        { actionIndex: 2, stepId: "step-03", source: "spec" },
      ];
      const script = actionsToScript({ actions, testName: "demo", stepMarkers: markers });

      expect(script).toContain("abStepEvidence");
      expect(script).toContain(`import { ab, abWait, abUpload, abAssertTextVisible`);
      expect(script).toContain("__setCurrentStep");
      const evidenceLines = script
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("abStepEvidence("));
      expect(evidenceLines).toEqual([
        `abStepEvidence("step-01", "login");`,
        `abStepEvidence("step-02", "login");`,
        `abStepEvidence("step-03", "spec");`,
      ]);
      const setStepLines = script
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("__setCurrentStep("));
      expect(setStepLines).toEqual([
        `__setCurrentStep("step-01", "login");`,
        `__setCurrentStep("step-02", "login");`,
        `__setCurrentStep("step-03", "spec");`,
      ]);

      // The closing abStepEvidence for a step must appear AFTER its own
      // action lines and BEFORE the next step's marker.
      const fillIdx = script.indexOf(`"[type='email']"`);
      const step01Evidence = script.indexOf(`abStepEvidence("step-01"`);
      const step02Marker = script.indexOf("// step: step-02");
      expect(step01Evidence).toBeGreaterThan(-1);
      expect(step01Evidence).toBeLessThan(step02Marker);
      expect(fillIdx).toBeGreaterThan(step02Marker);
    });

    it("does not emit abStepEvidence when no step markers are provided", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "https://idp/" },
        { action: "assert", assert: "text_visible", value: "Hello" },
      ];
      const script = actionsToScript({ actions, testName: "demo" });
      expect(script).not.toContain("abStepEvidence(");
    });

    it("inserts a blank line before each step marker except the first", () => {
      const actions: RecordedAction[] = [
        { action: "navigate", value: "a", stepId: "step-01" },
        { action: "navigate", value: "b", stepId: "step-02" },
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
      const actions: RecordedAction[] = [
        { action: "navigate", value: "/login", stepId: "step-01" },
        { action: "fill", locator: css("[type='email']"), value: "u", stepId: "step-01" },
        { action: "navigate", value: "/home", stepId: "step-02" },
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
