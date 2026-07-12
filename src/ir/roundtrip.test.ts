import { describe, expect, test } from "vitest";
import { parseAbActionLine } from "./from-agent-browser.ts";
import { toAgentBrowserArgs } from "./to-agent-browser.ts";

/**
 * Round-trip identity: for every allowed command and selector form, the
 * agent-browser argv captured at trace time must be reproduced exactly by
 * `IR → to-agent-browser`. The capture side encodes an argv as an
 * `AB_ACTION|...` wire line (see `claude/invoke.ts`), so the identity under
 * test is: wire line → RecordedAction → argv tokens === original argv.
 *
 * This is what guarantees the neutral Locator model loses no precision
 * against the old selector-string / find_* dual addressing.
 */

/** Parse a wire line and re-emit the agent-browser argv token texts. */
function roundtrip(line: string): string[] | null {
  const action = parseAbActionLine(line);
  if (!action) return null;
  const tokens = toAgentBrowserArgs(action);
  return tokens === null ? null : tokens.map((t) => t.text);
}

describe("round-trip identity: plain commands", () => {
  test("cookies_clear", () => {
    expect(roundtrip("AB_ACTION|cookies_clear")).toEqual(["cookies", "clear"]);
  });

  test("open (plain URL and ${VAR} URL)", () => {
    expect(roundtrip("AB_ACTION|open|https://example.com/items")).toEqual([
      "open", "https://example.com/items",
    ]);
    expect(roundtrip("AB_ACTION|open|${APP_URL}/items")).toEqual([
      "open", "${APP_URL}/items",
    ]);
  });

  test("press", () => {
    expect(roundtrip("AB_ACTION|press|Enter")).toEqual(["press", "Enter"]);
  });

  test("scroll with and without pixels", () => {
    expect(roundtrip("AB_ACTION|scroll|down|300")).toEqual(["scroll", "down", "300"]);
    expect(roundtrip("AB_ACTION|scroll|up")).toEqual(["scroll", "up"]);
  });

  // Every ALLOWED selector form from the trace prompt must survive a click
  // round trip byte-for-byte.
  const ALLOWED_SELECTORS = [
    "[aria-label='Submit']",
    "text=Sign In",
    "[placeholder='Email']",
    "[type='password']",
    "a[href*='/settings']",
    "[data-testid='save']",
    "[data-qa='confirm']",
  ];
  for (const sel of ALLOWED_SELECTORS) {
    test(`click ${sel}`, () => {
      expect(roundtrip(`AB_ACTION|click|${sel}|label`)).toEqual(["click", sel]);
    });
  }

  test("dblclick / check / uncheck / hover", () => {
    expect(roundtrip("AB_ACTION|dblclick|[aria-label='Item']|Item")).toEqual(["dblclick", "[aria-label='Item']"]);
    expect(roundtrip("AB_ACTION|check|[aria-label='Agree']|Agree")).toEqual(["check", "[aria-label='Agree']"]);
    expect(roundtrip("AB_ACTION|uncheck|[aria-label='Agree']|Agree")).toEqual(["uncheck", "[aria-label='Agree']"]);
    expect(roundtrip("AB_ACTION|hover|[aria-label='Menu']|Menu")).toEqual(["hover", "[aria-label='Menu']"]);
  });

  test("fill with selector + value", () => {
    expect(roundtrip("AB_ACTION|fill|[placeholder='Email']|user@example.com|Email")).toEqual([
      "fill", "[placeholder='Email']", "user@example.com",
    ]);
  });

  test("select", () => {
    expect(roundtrip("AB_ACTION|select|[aria-label='Color']|red|Color")).toEqual([
      "select", "[aria-label='Color']", "red",
    ]);
  });

  test("drag", () => {
    expect(roundtrip("AB_ACTION|drag|[aria-label='Card']|[aria-label='Done column']|Card")).toEqual([
      "drag", "[aria-label='Card']", "[aria-label='Done column']",
    ]);
  });

  test("upload with one and multiple files", () => {
    expect(roundtrip("AB_ACTION|upload|[aria-label='Attach']|${CCQA_FIXTURES_DIR}/a.pdf")).toEqual([
      "upload", "[aria-label='Attach']", "${CCQA_FIXTURES_DIR}/a.pdf",
    ]);
    expect(roundtrip("AB_ACTION|upload|[type='file']|/tmp/a.png|/tmp/b.png")).toEqual([
      "upload", "[type='file']", "/tmp/a.png", "/tmp/b.png",
    ]);
  });

  test("wait --text", () => {
    expect(roundtrip("AB_ACTION|wait|--text|Done")).toEqual(["wait", "--text", "Done"]);
  });

  test("wait with a raw selector string stays verbatim", () => {
    expect(roundtrip("AB_ACTION|wait|[aria-label='Saved']|Saved")).toEqual(["wait", "[aria-label='Saved']"]);
    // `text=` in the raw-selector slot is the selector-engine alias — it
    // stays a css Locator and round-trips verbatim.
    expect(roundtrip("AB_ACTION|wait|text=Done|done")).toEqual(["wait", "text=Done"]);
  });
});

describe("round-trip identity: find forms", () => {
  const SEMANTIC_LOCATORS = ["text", "label", "placeholder", "alt", "title", "testid"] as const;
  for (const locator of SEMANTIC_LOCATORS) {
    test(`find ${locator} <value> click`, () => {
      expect(roundtrip(`AB_ACTION|find_click|${locator}|Sign In|||`)).toEqual([
        "find", locator, "Sign In", "click",
      ]);
    });
    test(`find ${locator} <value> click --exact`, () => {
      expect(roundtrip(`AB_ACTION|find_click|${locator}|OK||exact|`)).toEqual([
        "find", locator, "OK", "click", "--exact",
      ]);
    });
  }

  test("find role with --name (flags after the action token)", () => {
    expect(roundtrip("AB_ACTION|find_click|role|button|Submit||OK")).toEqual([
      "find", "role", "button", "click", "--name", "Submit",
    ]);
  });

  test("find role with --name and --exact", () => {
    expect(roundtrip("AB_ACTION|find_click|role|button|Submit|exact|OK")).toEqual([
      "find", "role", "button", "click", "--name", "Submit", "--exact",
    ]);
  });

  test("find role without --name", () => {
    expect(roundtrip("AB_ACTION|find_click|role|button|||")).toEqual([
      "find", "role", "button", "click",
    ]);
  });

  test("find first/last with an inner CSS selector", () => {
    expect(roundtrip("AB_ACTION|find_click|first|[data-qa='row']|||")).toEqual([
      "find", "first", "[data-qa='row']", "click",
    ]);
    expect(roundtrip("AB_ACTION|find_click|last|[aria-label='Reply']|||latest reply")).toEqual([
      "find", "last", "[aria-label='Reply']", "click",
    ]);
  });

  test("find nth with the index before the inner selector", () => {
    expect(roundtrip("AB_ACTION|find_click|nth|[aria-label='Reply']|2||3rd reply")).toEqual([
      "find", "nth", "2", "[aria-label='Reply']", "click",
    ]);
  });

  test("every find action verb round-trips", () => {
    for (const verb of ["click", "dblclick", "hover", "focus", "check", "uncheck"]) {
      expect(roundtrip(`AB_ACTION|find_${verb}|text|Item|||`)).toEqual([
        "find", "text", "Item", verb,
      ]);
    }
  });

  test("find fill carries the input value after the action", () => {
    expect(roundtrip("AB_ACTION|find_fill|label|Email|||user@example.com|Email field")).toEqual([
      "find", "label", "Email", "fill", "user@example.com",
    ]);
  });

  test("find fill with role + --name keeps flag order (value before flags)", () => {
    expect(roundtrip("AB_ACTION|find_fill|role|textbox|Comment||hello|comment box")).toEqual([
      "find", "role", "textbox", "fill", "hello", "--name", "Comment",
    ]);
  });
});

describe("documented normalizations (aliases, not identities)", () => {
  test("`type` normalizes to `fill` (both codegen and replay always emitted fill)", () => {
    expect(roundtrip("AB_ACTION|type|[aria-label='Search']|query|Search")).toEqual([
      "fill", "[aria-label='Search']", "query",
    ]);
    expect(roundtrip("AB_ACTION|find_type|label|Search|||query|")).toEqual([
      "find", "label", "Search", "fill", "query",
    ]);
  });

  test("surrounding quotes on an opened URL are stripped at parse time", () => {
    expect(roundtrip('AB_ACTION|open|"https://example.com"')).toEqual([
      "open", "https://example.com",
    ]);
  });

  test("injectivity: a plain text= click and a find-text click stay distinct", () => {
    // The plain command keeps the raw selector-engine string (css Locator);
    // the find form uses the semantic text Locator. They must not collapse
    // into the same IR, or one of the two would re-emit as the other.
    expect(roundtrip("AB_ACTION|click|text=Reply|Reply")).toEqual(["click", "text=Reply"]);
    expect(roundtrip("AB_ACTION|find_click|text|Reply|||")).toEqual(["find", "text", "Reply", "click"]);
  });
});

describe("non-replayable wire lines", () => {
  test("snapshot and assert have no direct argv form", () => {
    expect(roundtrip("AB_ACTION|snapshot|login page loaded")).toBeNull();
    expect(roundtrip("AB_ACTION|assert|text_visible||Done|op completed")).toBeNull();
  });
});
