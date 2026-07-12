import { describe, test, expect } from "vitest";
import { extractAbActionFromBashCommand, extractCcqaAssertFromBashCommand, extractCcqaStepFromBashCommand, extractInvocationCost, extractObservationAbAction, isBlockedAbSubcommand, hasRefSelector, isBashToolResponseError, shellTokenize, findPositionalBareTag, hasMultipleAbInvocations, hasErrorSuppression } from "./invoke.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

  test("parses upload with a single file", () => {
    expect(
      extractAbActionFromBashCommand(
        `agent-browser --session s1 upload "[aria-label='Attach']" "/fixtures/a.pdf"`,
      ),
    ).toBe("AB_ACTION|upload|[aria-label='Attach']|/fixtures/a.pdf");
  });

  test("parses upload with multiple files", () => {
    expect(
      extractAbActionFromBashCommand(
        `agent-browser --session s1 upload "[type='file']" "/tmp/a.png" "/tmp/b.png"`,
      ),
    ).toBe("AB_ACTION|upload|[type='file']|/tmp/a.png|/tmp/b.png");
  });

  test("returns null for upload without selector or files", () => {
    // `upload` with no positionals — not a recordable action.
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 upload`),
    ).toBeNull();
    // selector only, no files
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 upload "[type='file']"`),
    ).toBeNull();
  });

  test("a CCQA_STEP env prefix does not disturb the extraction", () => {
    expect(
      extractAbActionFromBashCommand(`CCQA_STEP=step-01 agent-browser --session s1 click "[aria-label='Submit']" "Submit"`),
    ).toBe("AB_ACTION|click|[aria-label='Submit']|Submit");
  });
});

describe("extractCcqaStepFromBashCommand", () => {
  test("extracts the step id from a CCQA_STEP prefix", () => {
    expect(
      extractCcqaStepFromBashCommand(`CCQA_STEP=step-03 agent-browser --session s1 click "text=Submit"`),
    ).toBe("step-03");
  });

  test("returns null when the prefix is absent", () => {
    expect(
      extractCcqaStepFromBashCommand(`agent-browser --session s1 click "text=Submit"`),
    ).toBeNull();
  });

  test("finds CCQA_STEP anywhere in a run of env assignments", () => {
    expect(
      extractCcqaStepFromBashCommand(`FOO=x CCQA_STEP=step-02 BAR=y agent-browser --session s1 snapshot`),
    ).toBe("step-02");
  });

  test("accepts a quoted value", () => {
    expect(
      extractCcqaStepFromBashCommand(`CCQA_STEP="step-04" agent-browser --session s1 snapshot`),
    ).toBe("step-04");
  });

  test("finds the prefix on a later statement of a compound command", () => {
    expect(
      extractCcqaStepFromBashCommand(`cd /tmp && CCQA_STEP=step-05 agent-browser --session s1 click "text=OK"`),
    ).toBe("step-05");
  });

  test("rejects invalid slugs (spaces, empty)", () => {
    expect(
      extractCcqaStepFromBashCommand(`CCQA_STEP='step 03' agent-browser --session s1 snapshot`),
    ).toBeNull();
    expect(
      extractCcqaStepFromBashCommand(`CCQA_STEP= agent-browser --session s1 snapshot`),
    ).toBeNull();
  });

  test("ignores CCQA_STEP on a non-agent-browser statement", () => {
    expect(
      extractCcqaStepFromBashCommand(`CCQA_STEP=step-09 echo hi && agent-browser --session s1 snapshot`),
    ).toBeNull();
  });

  test("ignores an assignment from command substitution", () => {
    expect(
      extractCcqaStepFromBashCommand(`result=$(CCQA_STEP=step-05 agent-browser --session s1 snapshot 2>&1)`),
    ).toBeNull();
  });

  test("returns null for non-agent-browser commands", () => {
    expect(extractCcqaStepFromBashCommand(`CCQA_STEP=step-01 ls -la`)).toBeNull();
  });
});

describe("extractCcqaAssertFromBashCommand", () => {
  test("extracts the bare '1' marker (alongside CCQA_STEP)", () => {
    expect(
      extractCcqaAssertFromBashCommand(`CCQA_STEP=step-03 CCQA_ASSERT=1 agent-browser --session s1 wait --text "Submitted" --timeout 3000`),
    ).toBe("1");
  });

  test("extracts an assert-type marker", () => {
    expect(
      extractCcqaAssertFromBashCommand(`CCQA_ASSERT=element_visible agent-browser --session s1 get count "[aria-label='Settings']"`),
    ).toBe("element_visible");
  });

  test("extracts url_contains with its payload", () => {
    expect(
      extractCcqaAssertFromBashCommand(`CCQA_STEP=step-02 CCQA_ASSERT=url_contains:/settings/apps agent-browser --session s1 get url`),
    ).toBe("url_contains:/settings/apps");
  });

  test("finds CCQA_ASSERT anywhere in a run of env assignments", () => {
    expect(
      extractCcqaAssertFromBashCommand(`FOO=x CCQA_ASSERT=1 CCQA_STEP=step-02 agent-browser --session s1 wait --text "OK"`),
    ).toBe("1");
  });

  test("returns null when the prefix is absent or empty", () => {
    expect(
      extractCcqaAssertFromBashCommand(`CCQA_STEP=step-01 agent-browser --session s1 wait --text "OK"`),
    ).toBeNull();
    expect(
      extractCcqaAssertFromBashCommand(`CCQA_ASSERT= agent-browser --session s1 wait --text "OK"`),
    ).toBeNull();
  });

  test("ignores CCQA_ASSERT on a non-agent-browser statement", () => {
    expect(
      extractCcqaAssertFromBashCommand(`CCQA_ASSERT=1 echo hi && agent-browser --session s1 wait --text "OK"`),
    ).toBeNull();
    expect(extractCcqaAssertFromBashCommand(`CCQA_ASSERT=1 ls -la`)).toBeNull();
  });
});

describe("extractObservationAbAction", () => {
  test("surfaces `get count <selector>` as a get_count wire line", () => {
    expect(
      extractObservationAbAction(`CCQA_STEP=step-03 CCQA_ASSERT=element_visible agent-browser --session s1 get count "[data-qa='panel']"`),
    ).toBe("AB_ACTION|get_count|[data-qa='panel']");
  });

  test("surfaces `get url` as a get_url wire line", () => {
    expect(
      extractObservationAbAction(`CCQA_ASSERT=url_contains:/x agent-browser --session s1 get url`),
    ).toBe("AB_ACTION|get_url");
  });

  test("returns null for other get subcommands and non-get commands", () => {
    expect(
      extractObservationAbAction(`agent-browser --session s1 get text "[data-qa='panel']"`),
    ).toBeNull();
    expect(
      extractObservationAbAction(`agent-browser --session s1 get count`),
    ).toBeNull();
    expect(
      extractObservationAbAction(`agent-browser --session s1 click "text=OK"`),
    ).toBeNull();
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

  test("a CCQA_ASSERT env prefix does not disturb the guard", () => {
    expect(
      isBlockedAbSubcommand(`CCQA_STEP=step-01 CCQA_ASSERT=1 agent-browser --session s1 eval "document.title"`),
    ).toBe(true);
    expect(
      isBlockedAbSubcommand(`CCQA_ASSERT=element_visible agent-browser --session s1 get count "[data-qa='x']"`),
    ).toBe(false);
  });

  test("does not block fill", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 fill "[placeholder='Email']" "test@example.com"`)).toBe(false);
  });

  test("no longer blocks find command (semantic locator fallback)", () => {
    expect(isBlockedAbSubcommand(`agent-browser --session s1 find text "Select category" click`)).toBe(false);
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

describe("extractAbActionFromBashCommand with `find` semantic locator", () => {
  test("find text click → AB_ACTION|find_click|text|<value>|||<label?>", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find text "Sign In" click`),
    ).toBe("AB_ACTION|find_click|text|Sign In|||");
  });

  test("find text click --exact records the exact flag", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find text "OK" --exact click`),
    ).toBe("AB_ACTION|find_click|text|OK||exact|");
  });

  test("find role click --name puts the name in <extra>", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find role button --name "Submit" click`),
    ).toBe("AB_ACTION|find_click|role|button|Submit||");
  });

  test("find last <css> click keeps the inner selector in <value>", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find last "[aria-label='Reply']" click`),
    ).toBe("AB_ACTION|find_click|last|[aria-label='Reply']|||");
  });

  test("find nth <i> <css> click puts the index in <extra>", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find nth 2 "[aria-label='Reply']" click`),
    ).toBe("AB_ACTION|find_click|nth|[aria-label='Reply']|2||");
  });

  test("find label fill carries the input value after the action", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find label "Email" fill "user@example.com"`),
    ).toBe("AB_ACTION|find_fill|label|Email|||user@example.com|");
  });

  test("rejects unknown locator", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find unknown "x" click`),
    ).toBeNull();
  });

  test("ignores --name when locator is not role (--name is role-only)", () => {
    // Even if the LLM mistakenly passes --name to a text locator, the wire
    // format must not carry it into findName — replay would then send
    // `find text "..." --name "..." click` and agent-browser rejects "--name".
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find text "Sign In" --name "Submit" click`),
    ).toBe("AB_ACTION|find_click|text|Sign In|||");
  });

  test("rejects missing action", () => {
    expect(
      extractAbActionFromBashCommand(`agent-browser --session s1 find text "Sign In"`),
    ).toBeNull();
  });
});

describe("findPositionalBareTag", () => {
  test("flags `find last button click` (bare tag)", () => {
    expect(
      findPositionalBareTag(`agent-browser --session s1 find last button click`),
    ).toEqual({ locator: "last", selector: "button", action: "click" });
  });

  test("flags `find first a click` (bare tag <a>)", () => {
    expect(
      findPositionalBareTag(`agent-browser --session s1 find first a click`),
    ).toEqual({ locator: "first", selector: "a", action: "click" });
  });

  test("flags `find nth 5 div hover` (bare tag <div>)", () => {
    expect(
      findPositionalBareTag(`agent-browser --session s1 find nth 5 div hover`),
    ).toEqual({ locator: "nth", selector: "div", action: "hover" });
  });

  test("allows `find last [aria-label='Reply'] click` (specific attribute)", () => {
    expect(
      findPositionalBareTag(`agent-browser --session s1 find last "[aria-label='Reply']" click`),
    ).toBeNull();
  });

  test("allows `find last [data-testid='reply-link'] click` (data-testid)", () => {
    expect(
      findPositionalBareTag(`agent-browser --session s1 find last "[data-testid='reply-link']" click`),
    ).toBeNull();
  });

  test("ignores non-positional finders (role/text/etc.)", () => {
    expect(
      findPositionalBareTag(`agent-browser --session s1 find role button --name "Submit" click`),
    ).toBeNull();
    expect(
      findPositionalBareTag(`agent-browser --session s1 find text "Sign In" click`),
    ).toBeNull();
  });

  test("ignores non-find commands", () => {
    expect(findPositionalBareTag(`agent-browser --session s1 click "button"`)).toBeNull();
  });
});

describe("hasMultipleAbInvocations", () => {
  test("returns false for a single agent-browser call", () => {
    expect(hasMultipleAbInvocations(`agent-browser --session s1 click "x"`)).toBe(false);
  });

  test("flags && chains of agent-browser calls", () => {
    expect(
      hasMultipleAbInvocations(`agent-browser --session s1 snapshot && agent-browser --session s1 click "x"`),
    ).toBe(true);
  });

  test("flags ; chains", () => {
    expect(
      hasMultipleAbInvocations(`agent-browser --session s1 wait 100; agent-browser --session s1 click "x"`),
    ).toBe(true);
  });

  test("flags pipe chains", () => {
    expect(
      hasMultipleAbInvocations(`agent-browser --session s1 snapshot | agent-browser --session s1 click "x"`),
    ).toBe(true);
  });

  test("ignores `agent-browser` inside string literals", () => {
    expect(
      hasMultipleAbInvocations(`agent-browser --session s1 fill "[name='x']" "agent-browser was here"`),
    ).toBe(false);
  });

  test("allows a single agent-browser piped into a non-ab tool (grep, head, etc)", () => {
    expect(
      hasMultipleAbInvocations(`agent-browser --session s1 snapshot | grep treeitem`),
    ).toBe(false);
  });

  test("ignores non-ab statement chains (e.g. echo + ls)", () => {
    expect(hasMultipleAbInvocations(`echo foo && ls -la`)).toBe(false);
  });

  test("counts env-prefixed invocations (CCQA_STEP=... chains still blocked)", () => {
    expect(
      hasMultipleAbInvocations(`CCQA_STEP=step-01 agent-browser --session s1 snapshot && CCQA_STEP=step-01 agent-browser --session s1 click "x"`),
    ).toBe(true);
    expect(
      hasMultipleAbInvocations(`CCQA_STEP=step-01 agent-browser --session s1 click "x"`),
    ).toBe(false);
    expect(
      hasMultipleAbInvocations(`CCQA_STEP=step-01 CCQA_ASSERT=1 agent-browser --session s1 wait --text "OK" && CCQA_ASSERT=element_visible agent-browser --session s1 get count "x"`),
    ).toBe(true);
  });

  test("does not count assignment-from-substitution reads (polling loops)", () => {
    expect(
      hasMultipleAbInvocations(
        `for i in $(seq 1 3); do sleep 1; result=$(agent-browser --session s1 snapshot 2>&1); echo "$result" | grep -q done && break; done\nCCQA_STEP=step-02 agent-browser --session s1 snapshot`,
      ),
    ).toBe(false);
  });
});

describe("hasErrorSuppression", () => {
  test("flags `|| true` after an agent-browser command", () => {
    expect(
      hasErrorSuppression(`agent-browser --session s1 click "x" || true`),
    ).toBe(true);
  });

  test("flags `|| :` (colon noop) after an agent-browser command", () => {
    expect(
      hasErrorSuppression(`agent-browser --session s1 click "x" || :`),
    ).toBe(true);
  });

  test("flags `2>/dev/null`", () => {
    expect(
      hasErrorSuppression(`agent-browser --session s1 click "x" 2>/dev/null`),
    ).toBe(true);
  });

  test("flags `; true` swallowing", () => {
    expect(
      hasErrorSuppression(`agent-browser --session s1 click "x"; true`),
    ).toBe(true);
  });

  test("allows plain `2>&1` (does not change exit status)", () => {
    expect(
      hasErrorSuppression(`agent-browser --session s1 snapshot 2>&1 | head -20`),
    ).toBe(false);
  });

  test("returns false when there is no agent-browser in the command", () => {
    expect(hasErrorSuppression(`echo hello || true`)).toBe(false);
  });

  test("returns false for a clean agent-browser command", () => {
    expect(hasErrorSuppression(`agent-browser --session s1 click "x"`)).toBe(false);
  });
});

describe("isBashToolResponseError", () => {
  test("treats is_error: true as a failure", () => {
    expect(isBashToolResponseError({ is_error: true })).toBe(true);
  });

  test("treats non-zero exitCode as a failure (Bash shape)", () => {
    expect(isBashToolResponseError({ output: "selector not found", exitCode: 1 })).toBe(true);
  });

  test("treats killed: true as a failure (Bash timeout)", () => {
    expect(isBashToolResponseError({ output: "", exitCode: 0, killed: true })).toBe(true);
  });

  test("treats exitCode 0 without is_error as success", () => {
    expect(isBashToolResponseError({ output: "ok", exitCode: 0 })).toBe(false);
  });

  test("treats missing fields as success (never spuriously roll back)", () => {
    expect(isBashToolResponseError({})).toBe(false);
  });

  test("treats non-object responses as success", () => {
    expect(isBashToolResponseError(null)).toBe(false);
    expect(isBashToolResponseError(undefined)).toBe(false);
    expect(isBashToolResponseError("ok")).toBe(false);
  });
});

describe("extractInvocationCost", () => {
  test("reads cost / duration / turns / usage off a success result message", () => {
    const msg = {
      type: "result",
      subtype: "success",
      duration_ms: 12345,
      duration_api_ms: 6789,
      is_error: false,
      num_turns: 7,
      result: "STEP_RESULT|step-01|pass|ok",
      stop_reason: "end_turn",
      total_cost_usd: 0.123,
      usage: {
        input_tokens: 200,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 12000,
        output_tokens: 800,
      },
      modelUsage: {
        "claude-opus-4-7": { input_tokens: 200 },
      },
    } as unknown as SDKMessage;
    expect(extractInvocationCost(msg)).toEqual({
      totalCostUsd: 0.123,
      durationMs: 12345,
      durationApiMs: 6789,
      numTurns: 7,
      inputTokens: 200,
      cacheCreationInputTokens: 1500,
      cacheReadInputTokens: 12000,
      outputTokens: 800,
      models: ["claude-opus-4-7"],
    });
  });

  test("returns all nulls when the SDK omits cost fields (e.g. mock replay)", () => {
    const msg = {
      type: "result",
      subtype: "success",
      result: "",
      is_error: false,
    } as unknown as SDKMessage;
    expect(extractInvocationCost(msg)).toEqual({
      totalCostUsd: null,
      durationMs: null,
      durationApiMs: null,
      numTurns: null,
      inputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
      models: [],
    });
  });
});
