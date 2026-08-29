import { describe, expect, it } from "vitest";
import {
  emitPlaywrightDraft,
  judgeCall,
  locatorToPlaywright,
  stepEvidenceCall,
} from "./emit-mechanical.ts";
import type { RecordedAction } from "../../ir/types.ts";

function emit(actions: RecordedAction[]): string {
  return emitPlaywrightDraft({ actions, testName: "sample" });
}

/** The single body line an action compiles to (assumes exactly one). */
function line(action: RecordedAction): string {
  const body = bodyLines([action]);
  expect(body).toHaveLength(1);
  return body[0]!;
}

/** The emitted statements, without the test's own indentation. */
function bodyLines(actions: RecordedAction[]): string[] {
  return emit(actions)
    .split("\n")
    .filter((l) => l.startsWith("  "))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("locatorToPlaywright", () => {
  it("maps every semantic strategy to its getBy* call", () => {
    expect(locatorToPlaywright({ by: "role", value: "button", name: "Submit" })).toBe(
      `page.getByRole("button", { name: "Submit" })`,
    );
    expect(locatorToPlaywright({ by: "role", value: "button", name: "Save", exact: true })).toBe(
      `page.getByRole("button", { name: "Save", exact: true })`,
    );
    expect(locatorToPlaywright({ by: "role", value: "dialog" })).toBe(`page.getByRole("dialog")`);
    expect(locatorToPlaywright({ by: "text", value: "Submit" })).toBe(`page.getByText("Submit")`);
    expect(locatorToPlaywright({ by: "text", value: "Submit", exact: true })).toBe(
      `page.getByText("Submit", { exact: true })`,
    );
    expect(locatorToPlaywright({ by: "label", value: "Email" })).toBe(`page.getByLabel("Email")`);
    expect(locatorToPlaywright({ by: "placeholder", value: "Search" })).toBe(
      `page.getByPlaceholder("Search")`,
    );
    expect(locatorToPlaywright({ by: "alt", value: "Logo" })).toBe(`page.getByAltText("Logo")`);
    expect(locatorToPlaywright({ by: "title", value: "Close" })).toBe(`page.getByTitle("Close")`);
    expect(locatorToPlaywright({ by: "testid", value: "submit-button" })).toBe(
      `page.getByTestId("submit-button")`,
    );
  });

  it("keeps raw selector-engine strings for css locators", () => {
    expect(locatorToPlaywright({ by: "css", value: "[aria-label='Save']" })).toBe(
      `page.locator("[aria-label='Save']")`,
    );
    expect(locatorToPlaywright({ by: "css", value: "text=Submit" })).toBe(
      `page.locator("text=Submit")`,
    );
  });

  it("expands env refs in css locator values (regression: used to bake the literal ref)", () => {
    // A `${VAR}` in a css/selector-engine string must become a process.env
    // template literal — same as every semantic strategy — so a deletion-verify
    // assert doesn't target a selector that can never match.
    expect(locatorToPlaywright({ by: "css", value: "text=ccqa-item-${CCQA_RUN_ID}" })).toBe(
      'page.locator(`text=ccqa-item-${process.env.CCQA_RUN_ID ?? ""}`)',
    );
  });

  it("renders positional picks as first/last/nth", () => {
    const css = { by: "css", value: "li.item" } as const;
    expect(locatorToPlaywright(css, "first")).toBe(`page.locator("li.item").first()`);
    expect(locatorToPlaywright(css, "last")).toBe(`page.locator("li.item").last()`);
    expect(locatorToPlaywright(css, 2)).toBe(`page.locator("li.item").nth(2)`);
  });
});

describe("emitPlaywrightDraft — actions", () => {
  const btn = { by: "role", value: "button", name: "Submit" } as const;

  it("emits the @playwright/test scaffold", () => {
    const script = emit([{ action: "navigate", value: "https://example.test/" }]);
    expect(script).toContain(`import { test, expect } from "@playwright/test";`);
    expect(script).toContain(`test("sample", async ({ page }) => {`);
    expect(script.trimEnd().endsWith("});")).toBe(true);
  });

  it("emits no coverage code — measurement attaches from outside the test", () => {
    // Under `--coverage` the run owns the browser and attaches to it over CDP
    // (see the target's `browserCoverage`), so nothing measurement-related may
    // land in the generated file for an LLM rewrite to drop.
    const script = emit([{ action: "navigate", value: "https://example.test/" }]);
    expect(script).not.toContain("coverage");
  });

  it("keeps the resolved value when a URL assert carries a ${VAR}", () => {
    // Neither up-front form can express this: a regex would have to match the
    // reference span with `.*` (so a value that is only refs asserts nothing),
    // and toHaveURL's glob is compared against the whole URL.
    expect(line({ action: "assert", assert: "url_contains", value: "${APP_BASE_URL}/settings/new" })).toBe(
      'await expect.poll(() => page.url()).toContain(`${process.env.APP_BASE_URL ?? ""}/settings/new`);',
    );
    // Ref-free values keep the regex form, metacharacters escaped.
    expect(line({ action: "assert", assert: "url_contains", value: "/runs/a.b" })).toBe(
      String.raw`await expect(page).toHaveURL(new RegExp("/runs/a\\.b"));`,
    );
  });

  it("maps interactions 1:1", () => {
    expect(line({ action: "navigate", value: "https://example.test/" })).toBe(
      `await page.goto("https://example.test/");`,
    );
    expect(line({ action: "click", locator: btn })).toBe(
      `await page.getByRole("button", { name: "Submit" }).first().click();`,
    );
    expect(line({ action: "dblclick", locator: { by: "css", value: ".card" } })).toBe(
      `await page.locator(".card").first().dblclick();`,
    );
    expect(line({ action: "fill", locator: { by: "label", value: "Email" }, value: "a@example.test" })).toBe(
      `await page.getByLabel("Email").first().fill("a@example.test");`,
    );
    // `type` is an alias of fill.
    expect(line({ action: "type", locator: { by: "css", value: "#name" }, value: "hello" })).toBe(
      `await page.locator("#name").first().fill("hello");`,
    );
    expect(line({ action: "press", value: "Enter" })).toBe(
      `await page.keyboard.press("Enter");`,
    );
    expect(line({ action: "check", locator: { by: "css", value: "[type='checkbox']" } })).toBe(
      `await page.locator("[type='checkbox']").first().check();`,
    );
    expect(line({ action: "uncheck", locator: { by: "css", value: "[type='checkbox']" } })).toBe(
      `await page.locator("[type='checkbox']").first().uncheck();`,
    );
    expect(line({ action: "select", locator: { by: "css", value: "select#lang" }, value: "en" })).toBe(
      `await page.locator("select#lang").first().selectOption("en");`,
    );
    expect(line({ action: "hover", locator: { by: "text", value: "Menu" } })).toBe(
      `await page.getByText("Menu").first().hover();`,
    );
    expect(line({ action: "focus", locator: { by: "placeholder", value: "Search" } })).toBe(
      `await page.getByPlaceholder("Search").first().focus();`,
    );
    expect(
      line({
        action: "drag",
        locator: { by: "css", value: "#src" },
        target: { by: "css", value: "#dst" },
      }),
    ).toBe(`await page.locator("#src").first().dragTo(page.locator("#dst").first());`);
    expect(
      line({ action: "upload", locator: { by: "css", value: "input[type='file']" }, files: ["a.pdf", "b.pdf"] }),
    ).toBe(`await page.locator("input[type='file']").first().setInputFiles(["a.pdf", "b.pdf"]);`);
    expect(line({ action: "cookies_clear" })).toBe(`await page.context().clearCookies();`);
  });

  it("maps scroll directions to mouse.wheel deltas", () => {
    expect(line({ action: "scroll", direction: "down", pixels: "250" })).toBe(
      `await page.mouse.wheel(0, 250);`,
    );
    expect(line({ action: "scroll", direction: "up", pixels: "250" })).toBe(
      `await page.mouse.wheel(0, -250);`,
    );
    expect(line({ action: "scroll", direction: "right", pixels: "100" })).toBe(
      `await page.mouse.wheel(100, 0);`,
    );
    expect(line({ action: "scroll", direction: "left", pixels: "100" })).toBe(
      `await page.mouse.wheel(-100, 0);`,
    );
    // Missing pixel count falls back to the default delta.
    expect(line({ action: "scroll", direction: "down" })).toBe(`await page.mouse.wheel(0, 400);`);
  });

  it("maps waits: selector waitFor, numeric sleep, skipped flag-forms", () => {
    expect(line({ action: "wait", locator: { by: "css", value: "[role='dialog']" } })).toBe(
      `await page.locator("[role='dialog']").first().waitFor();`,
    );
    expect(line({ action: "wait", locator: { by: "text", value: "Loaded" } })).toBe(
      `await page.getByText("Loaded").first().waitFor();`,
    );
    expect(line({ action: "wait", locator: { by: "css", value: "3" } })).toBe(
      `await page.waitForTimeout(3000);`,
    );
    expect(bodyLines([{ action: "wait", locator: { by: "css", value: "--load" } }])).toEqual([]);
  });

  it("maps every AssertType to its expect form", () => {
    expect(line({ action: "assert", assert: "text_visible", value: "Saved" })).toBe(
      `await expect(page.getByText("Saved").first()).toBeVisible();`,
    );
    expect(line({ action: "assert", assert: "text_not_visible", value: "Error" })).toBe(
      `await expect(page.getByText("Error")).toHaveCount(0);`,
    );
    // element_visible carries `get count >= 1` semantics — `.first()` keeps it
    // strict-mode safe when the locator matches several elements.
    expect(line({ action: "assert", assert: "element_visible", locator: btn })).toBe(
      `await expect(page.getByRole("button", { name: "Submit" }).first()).toBeVisible();`,
    );
    expect(line({ action: "assert", assert: "element_visible", locator: btn, index: "last" })).toBe(
      `await expect(page.getByRole("button", { name: "Submit" }).last()).toBeVisible();`,
    );
    // element_not_visible carries `get count == 0` semantics.
    expect(line({ action: "assert", assert: "element_not_visible", locator: btn })).toBe(
      `await expect(page.getByRole("button", { name: "Submit" })).toHaveCount(0);`,
    );
    expect(line({ action: "assert", assert: "url_contains", value: "/tasks?done=1" })).toBe(
      `await expect(page).toHaveURL(new RegExp("/tasks\\\\?done=1"));`,
    );
    expect(line({ action: "assert", assert: "element_enabled", locator: btn })).toBe(
      `await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();`,
    );
    expect(line({ action: "assert", assert: "element_disabled", locator: btn })).toBe(
      `await expect(page.getByRole("button", { name: "Submit" })).toBeDisabled();`,
    );
    expect(line({ action: "assert", assert: "element_checked", locator: { by: "css", value: "#opt" } })).toBe(
      `await expect(page.locator("#opt")).toBeChecked();`,
    );
    expect(line({ action: "assert", assert: "element_unchecked", locator: { by: "css", value: "#opt" } })).toBe(
      `await expect(page.locator("#opt")).not.toBeChecked();`,
    );
  });

  it("prefixes an assert with its observation comment", () => {
    const script = emit([
      { action: "assert", assert: "text_visible", value: "Saved", observation: "the toast appears" },
    ]);
    expect(script).toContain("// Assert: the toast appears\n  await expect(");
  });

  it("expands env refs in values into process.env template literals", () => {
    expect(line({ action: "fill", locator: { by: "label", value: "Password" }, value: "${PASSWORD}" })).toBe(
      'await page.getByLabel("Password").first().fill(`${process.env.PASSWORD ?? ""}`);',
    );
    expect(line({ action: "assert", assert: "url_contains", value: "/runs/${RUN_ID}" })).toBe(
      'await expect.poll(() => page.url()).toContain(`/runs/${process.env.RUN_ID ?? ""}`);',
    );
  });

  it("renders snapshots as comments and step markers as boundaries", () => {
    const script = emitPlaywrightDraft({
      actions: [
        { action: "navigate", value: "https://example.test/", stepId: "step-01" },
        { action: "snapshot", observation: "the list shows one item", stepId: "step-02" },
        { action: "click", locator: { by: "text", value: "Submit" }, stepId: "step-02" },
      ],
      testName: "t",
      stepMarkers: [
        { actionIndex: 0, stepId: "step-01", source: "spec" },
        { actionIndex: 1, stepId: "step-02", source: "login" },
      ],
    });
    expect(script).toContain("// step: step-01 [spec]");
    expect(script).toContain("// step: step-02 [login]");
    expect(script).toContain("// the list shows one item");
  });

  it("wraps each step in before/after step-evidence calls, flat (no closure)", () => {
    const script = emitPlaywrightDraft({
      actions: [
        { action: "navigate", value: "https://example.test/", stepId: "step-01" },
        { action: "click", locator: { by: "text", value: "Submit" }, stepId: "step-02" },
      ],
      testName: "t",
      stepMarkers: [
        { actionIndex: 0, stepId: "step-01", source: "spec" },
        { actionIndex: 1, stepId: "step-02", source: "spec" },
      ],
    });
    // The module is imported and both boundaries fire per step.
    expect(script).toContain(`import { ccqaStepBefore, ccqaStepAfter } from "ccqa/step-evidence";`);
    expect(script).toContain(`await ccqaStepBefore(page, "step-01", "spec");`);
    // step-01 closes just before step-02 opens, and step-02 closes at the end.
    expect(script).toContain(`await ccqaStepAfter(page, "step-01", "spec");`);
    expect(script).toContain(`await ccqaStepBefore(page, "step-02", "spec");`);
    expect(script).toContain(`await ccqaStepAfter(page, "step-02", "spec");`);
    // Flat calls, never a wrapper closure a page-object rewrite would fight.
    expect(script).not.toContain("ccqaStep(");
    expect(script).not.toContain("async () =>");
    // Exactly one after-call per step (open→next-open flush + end flush, deduped).
    expect(script.match(/ccqaStepAfter\(page, "step-01"/g)).toHaveLength(1);
  });

  it("omits the step-evidence import when there are no step markers", () => {
    const script = emit([{ action: "navigate", value: "https://example.test/" }]);
    expect(script).not.toContain("ccqa/step-evidence");
    expect(script).not.toContain("ccqaStep");
  });

  it("emits replay-unstable warnings and dropped-action markers", () => {
    const script = emit([
      {
        action: "click",
        locator: { by: "text", value: "Save" },
        replayUnstable: true,
        replayReason: "Wait timed out",
      },
      { action: "click", stepId: "step-03" },
    ]);
    expect(script).toContain("// [warn] replay-unstable: Wait timed out");
    expect(script).toContain("// [warn] action dropped: click (stepId=step-03)");
  });

  it("dedupes consecutive identical lines", () => {
    const click: RecordedAction = { action: "click", locator: { by: "text", value: "Next" } };
    const body = emit([click, click])
      .split("\n")
      .filter((l) => l.includes(".click()"));
    expect(body).toHaveLength(1);
  });
});

describe("replay-unstable over-assertions", () => {
  it("drops a 'selector not present' assert to a breadcrumb comment (same rule as agent-browser)", () => {
    const body = emit([
      {
        action: "assert",
        assert: "element_visible",
        locator: { by: "css", value: "[aria-label='Email']" },
        replayUnstable: true,
        replayReason: "selector not present within 10000ms (get count returned 0)",
      },
    ]);
    expect(body).not.toContain("toBeVisible");
    expect(body).toContain("dropped over-assertion");
  });

  it("keeps a wait-timeout unstable assert runnable (may pass in a real run)", () => {
    const body = emit([
      {
        action: "assert",
        assert: "element_visible",
        locator: { by: "css", value: "[data-qa='panel']" },
        replayUnstable: true,
        replayReason: "Wait timed out after 10000ms",
      },
    ]);
    expect(body).toContain("toBeVisible");
  });
});

describe("emitPlaywrightDraft — judgements", () => {
  it("emits the judge call and its import, so no LLM pass is needed to keep the claim", () => {
    const script = emitPlaywrightDraft({
      actions: [],
      testName: "sample",
      judgements: [
        {
          step: { id: "step-02", source: "spec", judgeByLlm: "the answer lists steps", from: ".out" },
          afterActionIndex: -1,
        },
      ],
    });
    expect(script).toContain(`import { judgeByLlm } from "ccqa/judge";`);
    expect(script).toContain(`// step: step-02 [spec]`);
    expect(script).toContain(`await judgeByLlm(page, "the answer lists steps", ".out");`);
  });

  it("omits the selector when the claim reads the whole page", () => {
    const script = emitPlaywrightDraft({
      actions: [],
      testName: "sample",
      judgements: [
        {
          step: { id: "step-01", source: "spec", judgeByLlm: "the page apologises" },
          afterActionIndex: -1,
        },
      ],
    });
    expect(script).toContain(`await judgeByLlm(page, "the page apologises");`);
  });

  it("emits a claim before the actions of the step that follows it", () => {
    const script = emitPlaywrightDraft({
      actions: [
        { action: "navigate", value: "/" },
        { action: "click", locator: { by: "text", value: "Open" } },
      ],
      testName: "sample",
      judgements: [
        {
          step: { id: "step-02", source: "spec", judgeByLlm: "the reply answers" },
          afterActionIndex: 0,
        },
      ],
    });
    const judgeAt = script.indexOf("judgeByLlm(page");
    expect(judgeAt).toBeGreaterThan(script.indexOf("page.goto"));
    expect(judgeAt).toBeLessThan(script.indexOf(".click()"));
  });

  it("expands env refs in a claim and its selector", () => {
    const script = emitPlaywrightDraft({
      actions: [],
      testName: "sample",
      judgements: [
        {
          step: { id: "step-01", source: "spec", judgeByLlm: "the reply names ${TENANT}", from: "#${SLOT}" },
          afterActionIndex: -1,
        },
      ],
    });
    expect(script).toContain(
      'await judgeByLlm(page, `the reply names ${process.env.TENANT ?? ""}`, `#${process.env.SLOT ?? ""}`);',
    );
  });

  it("leaves a bare $WORD in a claim alone — prose, not a reference", () => {
    const script = emitPlaywrightDraft({
      actions: [],
      testName: "sample",
      judgements: [
        {
          step: { id: "step-01", source: "spec", judgeByLlm: "the answer mentions $USD" },
          afterActionIndex: -1,
        },
      ],
    });
    expect(script).toContain('await judgeByLlm(page, "the answer mentions $USD");');
  });

  it("raises the test's own timeout, which a model round trip was not sized for", () => {
    const script = emitPlaywrightDraft({
      actions: [],
      testName: "sample",
      judgements: [
        { step: { id: "step-01", source: "spec", judgeByLlm: "c" }, afterActionIndex: -1 },
      ],
    });
    expect(script).toContain("test.slow();");
    expect(emit([{ action: "navigate", value: "/" }])).not.toContain("test.slow()");
  });

  it("leaves the import out when there is nothing to judge", () => {
    expect(emit([{ action: "navigate", value: "/" }])).not.toContain("ccqa/judge");
  });
});

describe("an injected call's pattern", () => {
  const evidence = stepEvidenceCall("ccqaStepAfter", { stepId: "step-05", source: "spec" }).pattern;

  // A click that opens a new tab has to capture evidence on that tab.
  it.each([
    [`await ccqaStepAfter(page, "step-05", "spec");`, true],
    [`await ccqaStepAfter(contentPage, "step-05", "spec");`, true],
    [`await ccqaStepAfter(await ctx.newPage(), "step-05", "spec");`, true],
    [`await ccqaStepAfter(page.context().pages()[1], "step-05", "spec");`, true],
    [`await ccqaStepAfter(\n  contentPage,\n  "step-05",\n  "spec",\n);`, true],
    // Unawaited, the closing capture races the end of the test and the step
    // reports as unfinished; a mention in a comment is not a call at all.
    [`ccqaStepAfter(page, "step-05", "spec");`, false],
    [`// ccqaStepAfter(page, "step-05", "spec")`, false],
    [`await ccqaStepAfter(page, "step-04", "spec");`, false],
  ])("%s → %s", (source, expected) => {
    expect(evidence.test(source)).toBe(expected);
  });

  it("holds the claim text but not the page it is judged on", () => {
    const claim = judgeCall({ id: "s", source: "spec", judgeByLlm: "the reply is concrete (enough)" }).pattern;
    expect(claim.test(`await judgeByLlm(tab, "the reply is concrete (enough)");`)).toBe(true);
    expect(claim.test(`await judgeByLlm(page, "the reply is vague");`)).toBe(false);
  });
});
