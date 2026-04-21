import { describe, test, expect } from "vitest";
import { extractAbActionFromBashCommand, isBlockedAbSubcommand, hasRefSelector, shellTokenize } from "./invoke.ts";

describe("extractAbActionFromBashCommand", () => {
  test("returns null for non-agent-browser commands", () => {
    expect(extractAbActionFromBashCommand("ls -la")).toBeNull();
    expect(extractAbActionFromBashCommand("echo hello")).toBeNull();
  });

  test("parses cookies clear", () => {
    expect(
      extractAbActionFromBashCommand("agent-browser --session s1 cookies clear"),
    ).toBe("AB_ACTION|cookies_clear");
  });

  test("parses open", () => {
    expect(
      extractAbActionFromBashCommand("agent-browser --session s1 open https://example.com"),
    ).toBe("AB_ACTION|open|https://example.com");
  });

  test("parses click with quoted selector", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 click "[aria-label='Submit']" "Submit"`),
    ).toBe("AB_ACTION|click|[aria-label='Submit']|Submit");
  });

  test("parses fill", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 fill "[placeholder='Email']" "test@example.com" "Email"`),
    ).toBe("AB_ACTION|fill|[placeholder='Email']|test@example.com|Email");
  });

  test("parses snapshot as null", () => {
    expect(
      extractAbActionFromBashCommand("agent-browser --session s1 snapshot"),
    ).toBeNull();
  });

  test("parses press", () => {
    expect(
      extractAbActionFromBashCommand("agent-browser --session s1 press Enter"),
    ).toBe("AB_ACTION|press|Enter");
  });

  test("parses wait", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 wait --text "Done"`),
    ).toBe("AB_ACTION|wait|--text|Done");
  });
});

describe("isBlockedAbSubcommand", () => {
  test("blocks eval with session", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 eval "document.querySelector('.btn').click()"`)).toBe(true);
  });

  test("blocks js with session", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 js "window.scrollTo(0, 100)"`)).toBe(true);
  });

  test("blocks eval without session flag", () => {
    expect(isBlockedAbSubcommand(`agent-browser eval "document.click()"`)).toBe(true);
  });

  test("does not block click", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 click "[aria-label='Submit']"`)).toBe(false);
  });

  test("does not block snapshot", () => {
    expect(isBlockedAbSubcommand("agent-browser --session s1 snapshot")).toBe(false);
  });

  test("does not block fill", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 fill "[placeholder='Email']" "test@example.com"`)).toBe(false);
  });

  test("blocks find command", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 find text "Select category" click`)).toBe(true);
  });

  test("blocks label command", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 label "Settings" click`)).toBe(true);
  });

  test("blocks textbox command", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 textbox "Search"`)).toBe(true);
  });

  test("does not block non-agent-browser commands", () => {
    expect(isBlockedAbSubcommand("ls -la")).toBe(false);
    expect(isBlockedAbSubcommand("echo hello")).toBe(false);
  });
});

describe("hasRefSelector", () => {
  test("detects @ref in click", () => {
    expect(hasRefSelector(`agent-browser --session s1 click "@e14"`)).toBe(true);
  });

  test("detects @ref in check", () => {
    expect(hasRefSelector(`agent-browser --session s1 check @e7`)).toBe(true);
  });

  test("detects @ref in fill", () => {
    expect(hasRefSelector(`agent-browser --session s1 fill "@e6" "value"`)).toBe(true);
  });

  test("does not flag aria-label selector", () => {
    expect(hasRefSelector(`agent-browser --session s1 click "[aria-label='Submit']"`)).toBe(false);
  });

  test("does not flag text= selector", () => {
    expect(hasRefSelector(`agent-browser --session s1 click "text=Select category"`)).toBe(false);
  });

  test("does not flag non-agent-browser commands", () => {
    expect(hasRefSelector("ls -la")).toBe(false);
  });

  test("does not flag snapshot (no args)", () => {
    expect(hasRefSelector("agent-browser --session s1 snapshot")).toBe(false);
  });
});

describe("shellTokenize", () => {
  test("splits simple tokens", () => {
    expect(shellTokenize("click foo bar")).toEqual(["click", "foo", "bar"]);
  });

  test("preserves spaces inside double quotes", () => {
    expect(shellTokenize(`click "[role='dialog'] button:last-child"`)).toEqual([
      "click",
      "[role='dialog'] button:last-child",
    ]);
  });

  test("preserves spaces inside single quotes", () => {
    expect(shellTokenize("fill 'text=hello world' value")).toEqual([
      "fill",
      "text=hello world",
      "value",
    ]);
  });

  test("handles empty string", () => {
    expect(shellTokenize("")).toEqual([]);
  });

  test("handles multiple spaces", () => {
    expect(shellTokenize("click  foo")).toEqual(["click", "foo"]);
  });
});

describe("extractAbActionFromBashCommand with compound selectors", () => {
  test("parses click with compound selector containing spaces", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 click "[role='dialog'] button:last-child"`),
    ).toBe("AB_ACTION|click|[role='dialog'] button:last-child|");
  });

  test("parses fill with placeholder containing spaces", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 fill ".modal-footer button" "OK"`),
    ).toBe("AB_ACTION|fill|.modal-footer button|OK|");
  });
});
