import { describe, test, expect } from "vitest";
import { parseAbActionLine, promoteMarkedAssert } from "./from-agent-browser.ts";

describe("parseAbActionLine", () => {
  test("returns null for non-AB_ACTION lines", () => {
    expect(parseAbActionLine("some text")).toBeNull();
    expect(parseAbActionLine("")).toBeNull();
    expect(parseAbActionLine("STEP_START|step-01|title")).toBeNull();
  });

  test("returns null for unknown commands", () => {
    expect(parseAbActionLine("AB_ACTION|unknown|arg")).toBeNull();
    expect(parseAbActionLine("AB_ACTION|navigate|http://example.com")).toBeNull();
  });

  test("parses open as navigate", () => {
    expect(parseAbActionLine("AB_ACTION|open|http://localhost:3000")).toEqual({
      action: "navigate",
      value: "http://localhost:3000",
    });
  });

  test("strips surrounding quotes from an opened URL", () => {
    expect(parseAbActionLine('AB_ACTION|open|"http://localhost:3000"')).toEqual({
      action: "navigate",
      value: "http://localhost:3000",
    });
  });

  test("parses press", () => {
    expect(parseAbActionLine("AB_ACTION|press|Enter")).toEqual({
      action: "press",
      value: "Enter",
    });
  });

  test("parses scroll", () => {
    expect(parseAbActionLine("AB_ACTION|scroll|down|300")).toEqual({
      action: "scroll",
      direction: "down",
      pixels: "300",
    });
  });

  test("parses snapshot", () => {
    expect(parseAbActionLine("AB_ACTION|snapshot|Login page loaded")).toEqual({
      action: "snapshot",
      observation: "Login page loaded",
    });
  });

  test("parses assert with a selector into a css locator", () => {
    expect(
      parseAbActionLine("AB_ACTION|assert|element_visible|[aria-label='OK']||dialog shown"),
    ).toEqual({
      action: "assert",
      assert: "element_visible",
      locator: { by: "css", value: "[aria-label='OK']" },
      observation: "dialog shown",
    });
  });

  test("parses a text assert (empty selector slot)", () => {
    expect(parseAbActionLine("AB_ACTION|assert|text_visible||Done|op completed")).toEqual({
      action: "assert",
      assert: "text_visible",
      value: "Done",
      observation: "op completed",
    });
  });

  test("parses click into a css locator", () => {
    expect(parseAbActionLine("AB_ACTION|click|[aria-label='Login']|Login")).toEqual({
      action: "click",
      locator: { by: "css", value: "[aria-label='Login']" },
      label: "Login",
    });
  });

  test("parses dblclick / check / uncheck / hover", () => {
    expect(parseAbActionLine("AB_ACTION|dblclick|[aria-label='Item']|Item")).toEqual({
      action: "dblclick", locator: { by: "css", value: "[aria-label='Item']" }, label: "Item",
    });
    expect(parseAbActionLine("AB_ACTION|check|[aria-label='Agree']|Agree")).toEqual({
      action: "check", locator: { by: "css", value: "[aria-label='Agree']" }, label: "Agree",
    });
    expect(parseAbActionLine("AB_ACTION|uncheck|[aria-label='Agree']|Agree")).toEqual({
      action: "uncheck", locator: { by: "css", value: "[aria-label='Agree']" }, label: "Agree",
    });
    expect(parseAbActionLine("AB_ACTION|hover|[aria-label='Menu']|Menu")).toEqual({
      action: "hover", locator: { by: "css", value: "[aria-label='Menu']" }, label: "Menu",
    });
  });

  test("parses wait with a raw selector as a css locator", () => {
    expect(parseAbActionLine("AB_ACTION|wait|[aria-label='Loading']|Loading")).toEqual({
      action: "wait",
      locator: { by: "css", value: "[aria-label='Loading']" },
      label: "Loading",
    });
  });

  test("parses wait --text as a text locator", () => {
    expect(parseAbActionLine("AB_ACTION|wait|--text|Done")).toEqual({
      action: "wait",
      locator: { by: "text", value: "Done" },
    });
  });

  test("parses fill / type / select", () => {
    expect(parseAbActionLine("AB_ACTION|fill|[aria-label='Email']|user@example.com|Email")).toEqual({
      action: "fill",
      locator: { by: "css", value: "[aria-label='Email']" },
      value: "user@example.com",
      label: "Email",
    });
    expect(parseAbActionLine("AB_ACTION|type|[aria-label='Search']|query text|Search")).toEqual({
      action: "type",
      locator: { by: "css", value: "[aria-label='Search']" },
      value: "query text",
      label: "Search",
    });
    expect(parseAbActionLine("AB_ACTION|select|[aria-label='Color']|red|Color")).toEqual({
      action: "select",
      locator: { by: "css", value: "[aria-label='Color']" },
      value: "red",
      label: "Color",
    });
  });

  test("parses drag with source and target locators", () => {
    expect(parseAbActionLine("AB_ACTION|drag|[aria-label='Source']|[aria-label='Target']|Source")).toEqual({
      action: "drag",
      locator: { by: "css", value: "[aria-label='Source']" },
      target: { by: "css", value: "[aria-label='Target']" },
      label: "Source",
    });
  });

  test("parses upload with one and multiple files", () => {
    expect(parseAbActionLine("AB_ACTION|upload|[aria-label='Attach']|/fixtures/a.pdf")).toEqual({
      action: "upload",
      locator: { by: "css", value: "[aria-label='Attach']" },
      files: ["/fixtures/a.pdf"],
    });
    expect(
      parseAbActionLine("AB_ACTION|upload|[type='file']|/tmp/a.png|/tmp/b.png|/tmp/c.png"),
    ).toEqual({
      action: "upload",
      locator: { by: "css", value: "[type='file']" },
      files: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
    });
  });

  test("rejects upload missing selector or files", () => {
    expect(parseAbActionLine("AB_ACTION|upload||/fixtures/a.pdf")).toBeNull();
    expect(parseAbActionLine("AB_ACTION|upload|[type='file']")).toBeNull();
  });

  test("parses find_click with a text locator", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|text|Sign In|||")).toEqual({
      action: "click",
      locator: { by: "text", value: "Sign In" },
    });
  });

  test("parses find_click with text + --exact", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|text|OK||exact|")).toEqual({
      action: "click",
      locator: { by: "text", value: "OK", exact: true },
    });
  });

  test("parses find_click with role + --name", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|role|button|Submit||OK")).toEqual({
      action: "click",
      locator: { by: "role", value: "button", name: "Submit" },
      label: "OK",
    });
  });

  test("parses find_focus (no plain-command counterpart)", () => {
    expect(parseAbActionLine("AB_ACTION|find_focus|label|Email|||")).toEqual({
      action: "focus",
      locator: { by: "label", value: "Email" },
    });
  });

  test("parses find_click last as css locator + index", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|last|[aria-label='Reply']|||latest reply")).toEqual({
      action: "click",
      locator: { by: "css", value: "[aria-label='Reply']" },
      index: "last",
      label: "latest reply",
    });
  });

  test("parses find_click nth with the index in <extra>", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|nth|[aria-label='Reply']|2||3rd reply")).toEqual({
      action: "click",
      locator: { by: "css", value: "[aria-label='Reply']" },
      index: 2,
      label: "3rd reply",
    });
  });

  test("parses find_fill with the input value after the flags", () => {
    expect(parseAbActionLine("AB_ACTION|find_fill|label|Email|||user@example.com|Email field")).toEqual({
      action: "fill",
      locator: { by: "label", value: "Email" },
      value: "user@example.com",
      label: "Email field",
    });
  });

  test("rejects malformed find_click (unknown locator)", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|bogus|x|||")).toBeNull();
  });

  test("rejects find_click with nth but no valid index", () => {
    expect(parseAbActionLine("AB_ACTION|find_click|nth|[aria-label='Reply']|||")).toBeNull();
  });

  test("get_count / get_url observation probes never record as actions", () => {
    expect(parseAbActionLine("AB_ACTION|get_count|[data-qa='panel']")).toBeNull();
    expect(parseAbActionLine("AB_ACTION|get_url")).toBeNull();
  });
});

describe("promoteMarkedAssert", () => {
  test("'1' on a wait --text REPLACES the wait with a text_visible assert", () => {
    expect(promoteMarkedAssert("AB_ACTION|wait|--text|Submitted", "1")).toEqual([
      { action: "assert", assert: "text_visible", value: "Submitted" },
    ]);
  });

  test("'text_visible' is an alias of '1'", () => {
    expect(promoteMarkedAssert("AB_ACTION|wait|--text|Submitted", "text_visible")).toEqual([
      { action: "assert", assert: "text_visible", value: "Submitted" },
    ]);
  });

  test("element_visible / element_not_visible on a get_count probe", () => {
    expect(promoteMarkedAssert("AB_ACTION|get_count|[aria-label='Settings']", "element_visible")).toEqual([
      { action: "assert", assert: "element_visible", locator: { by: "css", value: "[aria-label='Settings']" } },
    ]);
    expect(promoteMarkedAssert("AB_ACTION|get_count|text=Deleted item", "element_not_visible")).toEqual([
      { action: "assert", assert: "element_not_visible", locator: { by: "css", value: "text=Deleted item" } },
    ]);
  });

  test("url_contains on a recorded command APPENDS the assert after the action", () => {
    expect(promoteMarkedAssert("AB_ACTION|click|text=Next|Next", "url_contains:/dashboard")).toEqual([
      { action: "click", locator: { by: "css", value: "text=Next" }, label: "Next" },
      { action: "assert", assert: "url_contains", value: "/dashboard" },
    ]);
  });

  test("url_contains on an observation probe records the assert alone", () => {
    expect(promoteMarkedAssert("AB_ACTION|get_url", "url_contains:/settings")).toEqual([
      { action: "assert", assert: "url_contains", value: "/settings" },
    ]);
    expect(promoteMarkedAssert(null, "url_contains:/settings")).toEqual([
      { action: "assert", assert: "url_contains", value: "/settings" },
    ]);
  });

  test("returns null for non-promotable marker/command pairs", () => {
    // '1' only pairs with a wait --text.
    expect(promoteMarkedAssert("AB_ACTION|click|text=Next|Next", "1")).toBeNull();
    expect(promoteMarkedAssert("AB_ACTION|get_count|[data-qa='x']", "1")).toBeNull();
    // element_visible only pairs with a get_count probe.
    expect(promoteMarkedAssert("AB_ACTION|wait|--text|Submitted", "element_visible")).toBeNull();
    // Empty payloads / unknown markers / commands with no wire form.
    expect(promoteMarkedAssert("AB_ACTION|get_url", "url_contains:")).toBeNull();
    expect(promoteMarkedAssert("AB_ACTION|wait|--text|", "1")).toBeNull();
    expect(promoteMarkedAssert("AB_ACTION|wait|--text|Submitted", "bogus")).toBeNull();
    expect(promoteMarkedAssert(null, "1")).toBeNull();
  });
});
