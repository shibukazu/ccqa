import { describe, expect, test, afterEach, beforeEach, vi } from "vitest";
import { actionToAbArgs, isCascadeReason, validateActions } from "./replay-validate.ts";
import { spawnAB, type Result } from "./spawn-ab.ts";
import type { RecordedAction } from "../types.ts";

vi.mock("./spawn-ab.ts", () => ({
  spawnAB: vi.fn(),
  sleepSync: vi.fn(),
}));

const mockedSpawnAB = vi.mocked(spawnAB);

const SESSION = "test-session";
const ORIGINAL_ENV = { ...process.env };

// An interaction now retries a "no element" failure, so a test that queues a
// finite number of replies would run past the end of its queue. The default
// says what every one of those tests means: it keeps failing.
beforeEach(() => {
  mockedSpawnAB.mockReturnValue({ status: 1, stdout: "", stderr: "selector not found" });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
  mockedSpawnAB.mockReset();
});

const OK = { status: 0, stdout: "", stderr: "" };
const FAIL = { status: 1, stdout: "", stderr: "selector not found" };
// `get count` poll responses for poll-present checks (wait <css>, element_visible).
const COUNT_PRESENT = { status: 0, stdout: "1", stderr: "" };
const COUNT_ABSENT = { status: 0, stdout: "0", stderr: "" };

const css = (value: string) => ({ by: "css", value }) as const;

/** Reply by what the command is, not by when it is called: an interaction that
 *  fails is retried, so a queue in call order no longer maps onto actions. */
function replyBy(match: (argv: string[]) => Result): void {
  mockedSpawnAB.mockImplementation(match);
}

describe("actionToAbArgs", () => {
  test("cookies_clear → cookies clear", () => {
    expect(actionToAbArgs({ action: "cookies_clear" }, SESSION)).toEqual([
      "--session", SESSION, "cookies", "clear",
    ]);
  });

  test("navigate resolves env refs in the URL", () => {
    process.env["APP_URL"] = "https://example.com";
    expect(actionToAbArgs({ action: "navigate", value: "${APP_URL}/x" }, SESSION)).toEqual([
      "--session", SESSION, "open", "https://example.com/x",
    ]);
  });

  test("fill/type both emit `fill` with selector + value", () => {
    expect(actionToAbArgs({ action: "fill", locator: css("[name='q']"), value: "hi" }, SESSION)).toEqual([
      "--session", SESSION, "fill", "[name='q']", "hi",
    ]);
    expect(actionToAbArgs({ action: "type", locator: css("[name='q']"), value: "hi" }, SESSION)).toEqual([
      "--session", SESSION, "fill", "[name='q']", "hi",
    ]);
  });

  test("wait routes a text locator through --text but uses a get-count poll for CSS selectors", () => {
    expect(actionToAbArgs({ action: "wait", locator: { by: "text", value: "Loading" } }, SESSION)).toEqual([
      "--session", SESSION, "wait", "--text", "Loading", "--timeout", "5000",
    ]);
    // A raw `text=` selector string (css Locator) takes the same route.
    expect(actionToAbArgs({ action: "wait", locator: css("text=Loading") }, SESSION)).toEqual([
      "--session", SESSION, "wait", "--text", "Loading", "--timeout", "5000",
    ]);
    // CSS selector waits become a poll-present check because agent-browser's
    // `wait <selector>` ignores --timeout and blocks the daemon.
    expect(actionToAbArgs({ action: "wait", locator: css("[aria-label='X']") }, SESSION)).toEqual({
      kind: "poll-present", selector: "[aria-label='X']", timeoutMs: 5000,
    });
  });

  test("flag-form waits (--load / --fn / --url) are unverifiable and return null", () => {
    // These land in the locator with the flag text (the wire format puts the
    // flag in the selector slot and its arg in the label). They are
    // readiness/observation conditions, not element-existence checks, so
    // validation must skip them rather than poll `get count "--load"`
    // (which always returns 0).
    expect(actionToAbArgs({ action: "wait", locator: css("--load") }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "wait", locator: css("--fn") }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "wait", locator: css("--url") }, SESSION)).toBeNull();
  });

  test("numeric wait (sleep duration) is unverifiable and returns null", () => {
    expect(actionToAbArgs({ action: "wait", locator: css("3") }, SESSION)).toBeNull();
  });

  test("snapshot is skipped (no side effect to verify)", () => {
    expect(actionToAbArgs({ action: "snapshot", observation: "page loaded" }, SESSION)).toBeNull();
  });

  test("assert text_visible verifies via `wait --text`", () => {
    const action: RecordedAction = { action: "assert", assert: "text_visible", value: "Done" };
    expect(actionToAbArgs(action, SESSION)).toEqual([
      "--session", SESSION, "wait", "--text", "Done", "--timeout", "10000",
    ]);
  });

  test("assert element_visible verifies via a get-count poll on the selector", () => {
    const action: RecordedAction = { action: "assert", assert: "element_visible", locator: css("[aria-label='OK']") };
    expect(actionToAbArgs(action, SESSION)).toEqual({
      kind: "poll-present", selector: "[aria-label='OK']", timeoutMs: 10000,
    });
  });

  test("text_not_visible and element_not_visible asserts are skipped (vacuously true on a fresh session)", () => {
    expect(actionToAbArgs({ action: "assert", assert: "text_not_visible", value: "Loading" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "assert", assert: "element_not_visible", locator: css("[aria-label='X']") }, SESSION)).toBeNull();
  });

  // A naming attribute is the one CSS form that routinely matches nothing
  // while the element is there, so a state answer about it is about no
  // element at all; Playwright notation is not CSS and `is` takes a selector.
  test("a state assert is asked as a state, and only of a selector that addresses the element", () => {
    expect(actionToAbArgs({ action: "assert", assert: "element_enabled", locator: css("text=Submit") }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "assert", assert: "element_enabled", locator: css("[aria-label='Submit']") }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "assert", assert: "element_unchecked", locator: css("#opt") }, SESSION)).toEqual({
      kind: "state", state: "checked", selector: "#opt", expected: false,
    });
    expect(actionToAbArgs({ action: "assert", assert: "element_enabled", locator: css(".btn-submit") }, SESSION)).toEqual({
      kind: "state", state: "enabled", selector: ".btn-submit", expected: true,
    });
  });

  test("url_contains is skipped (URL probe, not a DOM check)", () => {
    expect(actionToAbArgs({ action: "assert", assert: "url_contains", value: "/dashboard" }, SESSION)).toBeNull();
  });

  test("wait with an empty/missing locator is unverifiable (not a forced failure)", () => {
    // Without this guard, the empty selector would be passed positionally to
    // `agent-browser wait ""` and the failure would cascade-drop subsequent
    // passive actions. Treat it as a no-op instead.
    expect(actionToAbArgs({ action: "wait", locator: css("") }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "wait" }, SESSION)).toBeNull();
  });

  test("text-locator click → `find text <v> click`", () => {
    expect(
      actionToAbArgs(
        { action: "click", locator: { by: "text", value: "Sign In" } },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "text", "Sign In", "click"]);
  });

  test("text-locator click + --exact appends the flag in order", () => {
    expect(
      actionToAbArgs(
        { action: "click", locator: { by: "text", value: "OK", exact: true } },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "text", "OK", "click", "--exact"]);
  });

  test("role locator + --name", () => {
    expect(
      actionToAbArgs(
        { action: "click", locator: { by: "role", value: "button", name: "Submit" } },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "role", "button", "click", "--name", "Submit"]);
  });

  test("index: last + inner CSS selector", () => {
    expect(
      actionToAbArgs(
        { action: "click", locator: css("[aria-label='Reply']"), index: "last" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "last", "[aria-label='Reply']", "click"]);
  });

  test("index: nth puts the index before the inner selector", () => {
    expect(
      actionToAbArgs(
        { action: "click", locator: css("button.reply"), index: 2 },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "nth", "2", "button.reply", "click"]);
  });

  test("semantic-locator fill carries the input value after the action", () => {
    expect(
      actionToAbArgs(
        { action: "fill", locator: { by: "label", value: "Email" }, value: "user@example.com" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "label", "Email", "fill", "user@example.com"]);
  });

  test("treats a malformed element action (no locator / empty locator value) as unverifiable", () => {
    expect(actionToAbArgs({ action: "click" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ action: "click", locator: { by: "text", value: "" } }, SESSION)).toBeNull();
  });
});

describe("validateActions", () => {
  const actions: RecordedAction[] = [
    { action: "navigate", value: "/" },
    { action: "click", locator: css("[aria-label='Submit']") },
    { action: "wait", locator: { by: "text", value: "Done" } },
    { action: "assert", assert: "text_visible", value: "Done" },
    { action: "click", locator: css("[aria-label='Next']") },
    { action: "snapshot", observation: "next page" },
  ];

  test("keeps every action when each agent-browser call succeeds", () => {
    mockedSpawnAB.mockReturnValue(OK);
    const { kept, dropped } = validateActions(actions, { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(actions.length);
    expect(dropped).toHaveLength(0);
  });

  test("a failing click cascade-drops the dependent wait + assert until the next side-effecting command", () => {
    // click [Submit] fails on every attempt (including retries) → wait+assert
    // dropped as collateral → next click [Next] succeeds → snapshot kept.
    replyBy((argv) => (argv.includes("[aria-label='Submit']") ? FAIL : OK));
    const { kept, dropped } = validateActions(actions, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate", "click", "snapshot"]);
    expect(kept[1]!.locator?.value).toBe("[aria-label='Next']");
    expect(dropped.map((d) => d.action.action)).toEqual(["click", "wait", "assert"]);
    // First drop is the real failure; the next two are collateral.
    expect(dropped[0]!.reason).toContain("selector not found");
    expect(dropped[1]!.reason).toMatch(/skipped after/);
    expect(dropped[2]!.reason).toMatch(/skipped after/);
  });

  test("snapshot is always kept in isolation (no args to spawn), but dropped as collateral after a failure", () => {
    const inOrder: RecordedAction[] = [
      { action: "snapshot", observation: "home" },                    // always kept
      { action: "click", locator: css("[aria-label='X']") },          // FAIL
      { action: "snapshot", observation: "after click" },             // collateral drop
      { action: "click", locator: css("[aria-label='Y']") },          // OK; resets cascade
      { action: "snapshot", observation: "after Y" },                 // kept
    ];
    // click X fails on every attempt (including retries); click Y succeeds.
    replyBy((argv) => (argv.includes("[aria-label='X']") ? FAIL : OK));
    const { kept, dropped } = validateActions(inOrder, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["snapshot", "click", "snapshot"]);
    expect(kept[1]!.locator?.value).toBe("[aria-label='Y']");
    expect(dropped.map((d) => d.action.action)).toEqual(["click", "snapshot"]);
  });

  test("a failure on the last action does not crash and reports the one drop", () => {
    const tail: RecordedAction[] = [
      { action: "navigate", value: "/" },
      { action: "click", locator: css("[aria-label='X']") },
    ];
    mockedSpawnAB.mockReturnValueOnce(OK).mockReturnValueOnce(FAIL);
    const { kept, dropped } = validateActions(tail, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.action.action).toBe("click");
  });

  test("a CSS-selector wait is validated by polling `get count` (never the blocking `wait <selector>`)", () => {
    const seq: RecordedAction[] = [
      { action: "navigate", value: "/" },
      { action: "wait", locator: css("[aria-label='Saved']") },
    ];
    // navigate → OK; the wait becomes a poll-present → `get count` returns "1".
    mockedSpawnAB
      .mockReturnValueOnce(OK)            // navigate
      .mockReturnValueOnce(COUNT_PRESENT); // get count → 1
    const { kept, dropped } = validateActions(seq, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate", "wait"]);
    expect(dropped).toHaveLength(0);
    // Crucially, the spawn args were a `get count`, not a `wait <selector>`.
    const calls = mockedSpawnAB.mock.calls.map((c) => c[0]);
    expect(calls.some((a) => a.includes("get") && a.includes("count"))).toBe(true);
    expect(calls.some((a) => a[a.indexOf("--session") + 2] === "wait" && a.includes("[aria-label='Saved']"))).toBe(false);
  });

  test("a CSS-selector wait that never appears is dropped after the poll times out", () => {
    const seq: RecordedAction[] = [
      { action: "navigate", value: "/" },
      { action: "wait", locator: css("[aria-label='NeverShows']") },
    ];
    // navigate OK; poll always returns "0" → eventually times out and drops.
    mockedSpawnAB.mockReturnValueOnce(OK).mockReturnValue(COUNT_ABSENT);
    const { kept, dropped } = validateActions(seq, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate"]);
    expect(dropped.map((d) => d.action.action)).toEqual(["wait"]);
    expect(dropped[0]!.reason).toMatch(/not present/);
  });

  test("step boundary lifts the cascade — next step's wait/assert are retried", () => {
    // step-01 click fails. step-02's wait is independent and should be tried.
    const stepped: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-01" },
      { action: "wait", locator: { by: "text", value: "Loading" }, stepId: "step-01" }, // collateral
      { action: "wait", locator: { by: "text", value: "Welcome" }, stepId: "step-02" }, // independent
      { action: "assert", assert: "text_visible", value: "Welcome", stepId: "step-02" },
    ];
    // step-01 click fails on every attempt (cascade armed); step-02's wait
    // and assert are independent and succeed.
    replyBy((argv) => (argv.includes("[aria-label='X']") ? FAIL : OK));
    const { kept, dropped } = validateActions(stepped, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate", "wait", "assert"]);
    expect(kept[1]!.stepId).toBe("step-02");
    expect(dropped.map((d) => d.action.action)).toEqual(["click", "wait"]);
    expect(dropped[1]!.action.stepId).toBe("step-01");
  });

  test("a passive failure (assert/wait/snapshot) does NOT cascade — the next passive is still tried", () => {
    // Two independent asserts in the same step: the first fails, the second
    // should still get tried because asserts don't mutate page state.
    const sameStep: RecordedAction[] = [
      { action: "assert", assert: "text_visible", value: "Foo", stepId: "step-01" },
      { action: "assert", assert: "text_visible", value: "Bar", stepId: "step-01" },
      { action: "snapshot", observation: "after", stepId: "step-01" },
    ];
    // assert Foo fails on every attempt; assert Bar is independent and
    // succeeds because a passive failure doesn't arm the cascade.
    replyBy((argv) => (argv.includes("Foo") ? FAIL : OK));
    const { kept, dropped } = validateActions(sameStep, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["assert", "snapshot"]);
    expect(kept[0]!.value).toBe("Bar");
    expect(dropped.map((d) => d.action.value)).toEqual(["Foo"]);
  });

  test("hard timeout triggers exactly one retry; pass on retry is treated as success", () => {
    const timeout = { status: null, stdout: "", stderr: "[ccqa] agent-browser killed after hard timeout", wedged: true };
    mockedSpawnAB
      .mockReturnValueOnce(OK)       // navigate
      .mockReturnValueOnce(timeout)  // click fails with SIGTERM
      .mockReturnValueOnce(OK)       // retry → OK
      .mockReturnValueOnce(OK)       // wait
      .mockReturnValueOnce(OK)       // assert
      .mockReturnValueOnce(OK)       // click [Next]
      ;                              // snapshot (no spawn)
    const { kept, dropped } = validateActions(actions, { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(actions.length);
    expect(dropped).toHaveLength(0);
  });

  test("hard timeout still fails after one retry — drop and arm cascade", () => {
    const timeout = { status: null, stdout: "", stderr: "[ccqa] agent-browser killed after hard timeout", wedged: true };
    const tail: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-01" },
      { action: "wait", locator: { by: "text", value: "Done" }, stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)
      .mockReturnValueOnce(timeout) // 1st
      .mockReturnValueOnce(timeout) // retry
      ;
    const { kept, dropped } = validateActions(tail, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate"]);
    expect(dropped.map((d) => d.action.action)).toEqual(["click", "wait"]);
    expect(dropped[0]!.reason).toMatch(/killed after hard timeout/);
  });

  test("rescue: a step that lost everything has its surviving-on-retry actions promoted back", () => {
    // step-08 click fails (cascade armed) → wait dropped as collateral →
    // step-08 has zero kept actions → rescue replays both, second one passes.
    const recoverable: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-07" },
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-08" },
      { action: "wait", locator: { by: "text", value: "Saved" }, stepId: "step-08" },
    ];
    // click fails on the first pass and again on rescue; wait always passes.
    replyBy((argv) => (argv.includes("[aria-label='X']") ? FAIL : OK));
    const { kept, dropped, rescuedSteps } = validateActions(recoverable, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate", "wait"]);
    expect(kept[1]!.stepId).toBe("step-08");
    expect(dropped.map((d) => d.action.action)).toEqual(["click"]);
    expect(rescuedSteps).toEqual(["step-08"]);
  });

  test("rescue: a step where every retry also fails stays lost", () => {
    const unrecoverable: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-07" },
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-08" },
      { action: "wait", locator: { by: "text", value: "Saved" }, stepId: "step-08" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // navigate
      .mockReturnValueOnce(FAIL) // click
      .mockReturnValueOnce(FAIL) // rescue: click
      .mockReturnValueOnce(FAIL); // rescue: wait
    const { kept, dropped, rescuedSteps } = validateActions(unrecoverable, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.action)).toEqual(["navigate"]);
    expect(dropped.map((d) => d.action.action)).toEqual(["click", "wait"]);
    expect(rescuedSteps ?? []).toEqual([]);
  });

  test("rescue: does NOT touch steps that already kept at least one action", () => {
    const partiallyKept: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-07" },
      { action: "click", locator: css("[aria-label='OK']"), stepId: "step-07" },
      { action: "wait", locator: { by: "text", value: "Foo" }, stepId: "step-07" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // navigate
      .mockReturnValueOnce(FAIL) // click
      // wait collateral — not spawned, but step-07 already has `navigate` kept
      ;
    const { kept, dropped, rescuedSteps } = validateActions(partiallyKept, { sessionName: "s", mode: "strict" });
    // Partial loss — no rescue should fire; downstream wait stays dropped.
    expect(kept.map((a) => a.action)).toEqual(["navigate"]);
    expect(dropped.map((d) => d.action.action)).toEqual(["click", "wait"]);
    expect(rescuedSteps ?? []).toEqual([]);
  });
});

describe("validateActions — an element the page has not rendered yet", () => {
  // A recording pauses for a snapshot between opening a page and typing into
  // it; the replay does not, so it reaches the field sooner than the recording
  // ever did. One shot at a fill made that a dead route.
  test("keeps trying a fill until the element appears", () => {
    mockedSpawnAB
      .mockReturnValueOnce(FAIL)
      .mockReturnValueOnce(FAIL)
      .mockReturnValueOnce(OK);
    const actions: RecordedAction[] = [
      { action: "fill", locator: { by: "label", value: "Email" }, value: "a@example.test" },
    ];
    const { kept, dropped } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
    expect(mockedSpawnAB).toHaveBeenCalledTimes(3);
  });

  // Repeating a selector the daemon rejects for ten seconds turns one clear
  // error into a slow one, so only "no element" is worth waiting on.
  test("does not retry a failure that is not about a missing element", () => {
    mockedSpawnAB.mockReturnValue({ status: 1, stdout: "", stderr: "unknown subaction" });
    const actions: RecordedAction[] = [
      { action: "click", locator: { by: "css", value: "[data-x]" } },
    ];
    const { dropped } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(dropped).toHaveLength(1);
    expect(mockedSpawnAB).toHaveBeenCalledTimes(1);
  });

  // A page that never rendered the first element is wrong, not slow. Paying
  // the same budget for every action after it turns one broken route into
  // minutes of waiting on the record path.
  test("once one interaction has waited its whole budget, later ones get one attempt", () => {
    mockedSpawnAB.mockReturnValue(FAIL);
    const actions: RecordedAction[] = [
      { action: "click", locator: css("[data-a]"), stepId: "step-01" },
      { action: "click", locator: css("[data-b]"), stepId: "step-02" },
    ];
    validateActions(actions, { sessionName: SESSION, mode: "strict" });
    const attempts = (sel: string) => mockedSpawnAB.mock.calls.filter((c) => c[0]!.includes(sel)).length;
    expect(attempts("[data-a]")).toBeGreaterThan(10);
    // One in the pass and one in the rescue replay that follows it.
    expect(attempts("[data-b]")).toBe(2);
  });

  // Measured: the click that signs in starts a client-side redirect, and the
  // replay's next `open` is taken away by it. The recording never hit this,
  // because the model's snapshot sat between the two.
  test("a navigation another navigation took away is asked for once more", () => {
    const ABORTED = { status: 1, stdout: "", stderr: "Navigation failed: net::ERR_ABORTED" };
    let opens = 0;
    replyBy((argv) => {
      if (argv.includes("open")) return ++opens === 1 ? ABORTED : OK;
      return OK;
    });
    const actions: RecordedAction[] = [
      { action: "navigate", value: "https://example.test/policies", stepId: "step-01" },
    ];
    const { kept, dropped } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(dropped).toEqual([]);
    expect(kept.length).toBe(1);
    // The page was let to settle before the second attempt.
    const waited = mockedSpawnAB.mock.calls.some((c) => c[0]!.includes("--load"));
    expect(waited).toBe(true);
  });

  // Replaying a click is how a route creates a second record of whatever it
  // just created. A click can report the same error as a navigation.
  test("only a navigation is repeated; a click reporting the same error is not", () => {
    let clicks = 0;
    replyBy((argv) => {
      if (argv.includes("click")) clicks++;
      return { status: 1, stdout: "", stderr: "Navigation failed: net::ERR_ABORTED" };
    });
    validateActions([{ action: "click", locator: css("#submit"), stepId: "step-01" }], {
      sessionName: SESSION,
      mode: "strict",
    });
    // One in the pass and one in the rescue replay that follows it.
    expect(clicks).toBe(2);
  });

  test("a navigation that keeps being taken away is not retried forever", () => {
    let opens = 0;
    replyBy((argv) => {
      if (argv.includes("open")) {
        opens++;
        return { status: 1, stdout: "", stderr: "Navigation failed: net::ERR_ABORTED" };
      }
      return OK;
    });
    validateActions([{ action: "navigate", value: "https://example.test/x", stepId: "step-01" }], {
      sessionName: SESSION,
      mode: "strict",
    });
    // Two in the pass and two in the rescue replay that follows it.
    expect(opens).toBe(4);
  });

  test("says how long it waited, so a reader can tell absent from mis-addressed", () => {
    mockedSpawnAB.mockReturnValue(FAIL);
    const actions: RecordedAction[] = [
      { action: "click", locator: { by: "css", value: "[data-x]" } },
    ];
    const { dropped } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(dropped[0]!.reason).toMatch(/waited \d+ms/);
  });
});

// A route that creates something names it after the run. Skip those actions
// and the form goes in empty, so the assertion that reads the name back can
// never pass — a live route read as dead.
// `is` exits 0 whether the answer is true or false, so reading the exit code
// would pass every state assert — the trap `get count` sets with its zero.
describe("validateActions (a state assert asks the page, and reads the answer)", () => {
  const unchecked = (): RecordedAction[] => [
    { action: "assert", assert: "element_unchecked", locator: css("#opt"), stepId: "step-01" },
  ];

  test("the page agreeing keeps the action", () => {
    replyBy((argv) => (argv.includes("is") ? { status: 0, stdout: "false", stderr: "" } : OK));
    const { dropped } = validateActions(unchecked(), { sessionName: SESSION, mode: "strict" });
    expect(dropped).toEqual([]);
  });

  test("the page disagreeing drops it, and says which way", () => {
    replyBy((argv) => (argv.includes("is") ? { status: 0, stdout: "true", stderr: "" } : OK));
    const { dropped } = validateActions(unchecked(), { sessionName: SESSION, mode: "strict" });
    expect(dropped[0]!.reason).toContain("expected checked=false, page says true");
  });
});

describe("validateActions — a route carrying this run's unique value", () => {
  const route = (): RecordedAction[] => [
    { action: "fill", locator: css("#title"), value: "ccqa-${CCQA_RUN_ID}", stepId: "step-01" },
    {
      action: "assert",
      assert: "text_visible",
      value: "ccqa-${CCQA_RUN_ID}",
      stepId: "step-02",
    },
  ];

  test("the fill and the assertion that reads it back see one and the same value", () => {
    replyBy(() => OK);
    const actions = route();
    const { dropped } = validateActions(actions, {
      sessionName: SESSION,
      mode: "strict",
      envOverrides: { CCQA_RUN_ID: "replay-42" },
    });
    expect(dropped).toEqual([]);

    const filled = mockedSpawnAB.mock.calls.find((c) => c[0]!.includes("fill"))![0];
    const waited = mockedSpawnAB.mock.calls.find((c) => c[0]!.includes("--text"))![0];
    expect(filled).toContain("ccqa-replay-42");
    expect(waited).toContain("ccqa-replay-42");

    // The reference belongs to the route; the value belongs to this replay.
    expect(actions[0]!.value).toBe("ccqa-${CCQA_RUN_ID}");
    expect(actions[1]!.value).toBe("ccqa-${CCQA_RUN_ID}");
  });
});

describe("validateActions (a css locator that is not css)", () => {
  const textAssert = (): RecordedAction => ({
    action: "assert",
    assert: "element_visible",
    locator: { by: "css", value: "text=Add ${WHAT}" },
    stepId: "step-01",
  });

  // Measured against agent-browser 0.34: on a page whose a11y tree showed the
  // button, `get count "button"` answered 12 while `get count "text=…"`,
  // `role=…` and `:has-text(…)` all answered 0 — not an error, a zero, which
  // reads as absence. `wait --text` found it.
  test("a text= value is asked as a text wait, and the route keeps that form", () => {
    process.env["WHAT"] = "content";
    replyBy((argv) => (argv.includes("count") ? COUNT_ABSENT : OK));
    const actions = [textAssert()];
    const { kept, dropped, promoted } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(dropped).toEqual([]);
    expect(kept.length).toBe(1);
    // The string is kept as recorded — the resolved value belongs to this
    // replay, never to the route.
    expect(actions[0]!.locator).toEqual({ by: "text", value: "Add ${WHAT}" });
    expect(promoted?.[0]).toContain("text=Add ${WHAT}");
    // Never counted: `get count` would have answered 0 for it.
    expect(mockedSpawnAB.mock.calls.some((c) => c[0]!.includes("count"))).toBe(false);
    // ...and the wait it was asked with saw the resolved value.
    const waits = mockedSpawnAB.mock.calls.filter((c) => c[0]!.includes("--text"));
    expect(waits[0]![0]).toContain("Add content");
  });

  const roleAssert = (): RecordedAction => ({
    action: "assert",
    assert: "element_visible",
    locator: { by: "css", value: 'role=button[name="Add content"]' },
    stepId: "step-01",
  });

  // Asked by name, and left in the route exactly as recorded: `locatorToSelector`
  // renders a role locator as the bare role, so saving one would have codegen
  // emit `abAssertVisible("button")` — an assertion any page with a button
  // passes.
  test("a role= value is asked by role and name, and is not written into the route", () => {
    replyBy(() => OK);
    const actions = [roleAssert()];
    validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(actions[0]!.locator).toEqual({ by: "css", value: 'role=button[name="Add content"]' });
    const found = mockedSpawnAB.mock.calls.find((c) => c[0]!.includes("find"))![0];
    expect(found).toEqual([
      "--session", SESSION, "find", "role", "button", "text", "--name", "Add content", "--exact",
    ]);
  });

  test("a role the page does not have is a failure, not a pass", () => {
    replyBy((argv) => (argv.includes("find") ? FAIL : OK));
    const { dropped } = validateActions([roleAssert()], { sessionName: SESSION, mode: "strict" });
    expect(dropped.length).toBe(1);
  });

  // A fallback that made everything pass would be worse than none.
  test("text the page really does not have is still a failure", () => {
    replyBy((argv) => (argv.includes("--text") ? FAIL : OK));
    const { dropped } = validateActions([textAssert()], { sessionName: SESSION, mode: "strict" });
    expect(dropped.length).toBe(1);
  });

  // Not countable and not convertible: saying "absent" would be inventing an
  // answer `get count`'s zero never gave.
  test("notation this cannot convert is unverifiable rather than absent", () => {
    replyBy((argv) => (argv.includes("count") ? COUNT_ABSENT : OK));
    const actions: RecordedAction[] = [{
      action: "assert",
      assert: "element_visible",
      locator: { by: "css", value: 'internal:label="Email"i' },
      stepId: "step-01",
    }];
    const { kept, dropped } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(dropped).toEqual([]);
    expect(kept.length).toBe(1);
  });

  // `click "text=…"` replays exactly as written; the `find text` a text locator
  // would send it through measurably does not find the element.
  test("an interaction's text= locator is left exactly as recorded", () => {
    replyBy(() => OK);
    const actions: RecordedAction[] = [
      { action: "click", locator: { by: "css", value: "text=Next" }, stepId: "step-01" },
    ];
    validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(actions[0]!.locator).toEqual({ by: "css", value: "text=Next" });
    expect(mockedSpawnAB.mock.calls.some((c) => c[0]!.includes("find"))).toBe(false);
  });

  // Measured: the DOM has `combobox "Category *"` named by an associated
  // `<label>`, so `[aria-label='Category *']` counts 0 while the element is
  // plainly there. The attribute being absent is not evidence the element is.
  test("an attribute selector that counts nothing is asked of the accessibility tree", () => {
    const SNAPSHOT = { status: 0, stdout: '- combobox "Category *"\n- button "Save"', stderr: "" };
    replyBy((argv) => {
      if (argv.includes("count")) return COUNT_ABSENT;
      if (argv.includes("snapshot")) return SNAPSHOT;
      return OK;
    });
    const actions: RecordedAction[] = [{
      action: "assert",
      assert: "element_visible",
      locator: css("[aria-label='Category *']"),
      stepId: "step-02",
    }];
    const { kept, dropped, promoted } = validateActions(actions, { sessionName: SESSION, mode: "strict" });
    expect(dropped).toEqual([]);
    expect(kept.length).toBe(1);
    expect(actions[0]!.locator).toEqual({ by: "role", value: "combobox", name: "Category *", exact: true });
    expect(promoted?.[0]).toContain("role=combobox");
  });

  test("a name the tree does not carry is still a failure", () => {
    replyBy((argv) => {
      if (argv.includes("count")) return COUNT_ABSENT;
      if (argv.includes("snapshot")) return { status: 0, stdout: '- button "Save"', stderr: "" };
      return OK;
    });
    const { dropped } = validateActions(
      [{ action: "assert", assert: "element_visible", locator: css("[aria-label='Gone']"), stepId: "s" }],
      { sessionName: SESSION, mode: "strict" },
    );
    expect(dropped.length).toBe(1);
  });

  test("plain css is still counted", () => {
    replyBy((argv) => (argv.includes("count") ? COUNT_PRESENT : OK));
    validateActions(
      [{ action: "assert", assert: "element_visible", locator: css("[data-x]"), stepId: "step-01" }],
      { sessionName: SESSION, mode: "strict" },
    );
    expect(mockedSpawnAB.mock.calls.some((c) => c[0]!.includes("count"))).toBe(true);
    expect(mockedSpawnAB.mock.calls.some((c) => c[0]!.includes("--text"))).toBe(false);
  });
});

describe("validateActions (label → role fallback)", () => {
  const labelFill = (): RecordedAction => ({
    action: "fill",
    locator: { by: "label", value: "Email" },
    value: "user@example.com",
  });

  test("a failing label fill retries by role + accessible name, and the promoted locator is kept in place", () => {
    // The label locator never resolves, even under retry; the role fallback succeeds.
    replyBy((argv) => (argv.includes("label") ? FAIL : OK));
    const { kept, dropped, promoted } = validateActions([labelFill()], { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(kept[0]!.locator).toEqual({ by: "role", value: "textbox", name: "Email", exact: true });
    expect(promoted).toEqual([`label=Email → role=textbox name="Email"`]);
    // The fallback is the last call made — everything before it is the
    // exhausted label-locator retry loop.
    const calls = mockedSpawnAB.mock.calls.map((c) => c[0]);
    expect(calls.at(-1)).toEqual([
      "--session", "s", "find", "role", "textbox", "fill", "user@example.com", "--name", "Email", "--exact",
    ]);
  });

  test("a label click has no unambiguous role, so it gets no fallback and stays a failure", () => {
    const action: RecordedAction = { action: "click", locator: { by: "label", value: "Email" } };
    // The click never resolves, even under retry, and click has no listed
    // fallback role — so every attempt is this same argv, never a role retry.
    replyBy(() => FAIL);
    const { kept, dropped, promoted } = validateActions([action], { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(promoted).toEqual([]);
    const calls = mockedSpawnAB.mock.calls.map((c) => c[0]);
    expect(calls.every((argv) => argv.includes("label"))).toBe(true); // no fallback attempt spawned
  });

  test("when both the original and the fallback fail, the action fails as before and `promoted` stays empty", () => {
    mockedSpawnAB
      .mockReturnValueOnce(FAIL) // original
      .mockReturnValueOnce(FAIL); // fallback also fails
    const { kept, dropped, promoted } = validateActions([labelFill()], { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toContain("selector not found");
    expect(promoted).toEqual([]);
    // Locator is left untouched when the fallback doesn't pan out.
    expect(dropped[0]!.action.locator).toEqual({ by: "label", value: "Email" });
  });

  test("a successful first attempt never spawns the fallback", () => {
    mockedSpawnAB.mockReturnValueOnce(OK);
    const { kept, promoted } = validateActions([labelFill()], { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.locator).toEqual({ by: "label", value: "Email" });
    expect(promoted).toEqual([]);
    expect(mockedSpawnAB).toHaveBeenCalledTimes(1);
  });
});

describe("isCascadeReason", () => {
  test("true for the exact cascade reason string the validator records", () => {
    expect(isCascadeReason("skipped after a preceding action failed")).toBe(true);
  });

  test("false for an ordinary agent-browser error string, and for undefined", () => {
    expect(isCascadeReason("selector not found")).toBe(false);
    expect(isCascadeReason(undefined)).toBe(false);
  });
});

describe("validateActions (lenient mode)", () => {
  test("default mode is lenient — failures move to `unstable`, dropped stays empty", () => {
    const actions: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
      { action: "click", locator: css("[aria-label='Submit']"), stepId: "step-01" },
      { action: "wait", locator: { by: "text", value: "Done" }, stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // navigate
      .mockReturnValueOnce(FAIL) // click → fails
      .mockReturnValueOnce(FAIL) // rescue: click
      .mockReturnValueOnce(FAIL) // rescue: wait
      ;
    // Omit `mode` to verify the default.
    const { kept, unstable, dropped } = validateActions(actions, { sessionName: "s" });
    expect(kept.map((a) => a.action)).toEqual(["navigate"]);
    expect(unstable.map((a) => a.action)).toEqual(["click", "wait"]);
    expect(dropped).toEqual([]);
  });

  test("lenient tags failing actions with replayUnstable + replayReason", () => {
    const actions: RecordedAction[] = [
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(FAIL)
      .mockReturnValueOnce(FAIL); // rescue
    const { kept, unstable } = validateActions(actions, { sessionName: "s", mode: "lenient" });
    expect(kept).toEqual([]);
    expect(unstable).toHaveLength(1);
    expect(unstable[0]!.replayUnstable).toBe(true);
    expect(unstable[0]!.replayReason).toMatch(/selector not found/);
  });

  test("lenient also honours step rescue — a rescued action lands in kept (not unstable)", () => {
    const actions: RecordedAction[] = [
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-01" },
      { action: "wait", locator: { by: "text", value: "Saved" }, stepId: "step-01" },
    ];
    // click fails on the first pass and again on rescue; wait always passes.
    replyBy((argv) => (argv.includes("[aria-label='X']") ? FAIL : OK));
    const { kept, unstable, rescuedSteps } = validateActions(actions, { sessionName: "s", mode: "lenient" });
    expect(kept.map((a) => a.action)).toEqual(["wait"]);
    expect(unstable.map((a) => a.action)).toEqual(["click"]);
    expect(rescuedSteps).toEqual(["step-01"]);
  });

  test("lenient: a fully-passing run yields empty unstable + empty dropped", () => {
    const actions: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
      { action: "click", locator: css("[aria-label='OK']"), stepId: "step-01" },
    ];
    mockedSpawnAB.mockReturnValue(OK);
    const { kept, unstable, dropped } = validateActions(actions, { sessionName: "s", mode: "lenient" });
    expect(kept).toHaveLength(2);
    expect(unstable).toEqual([]);
    expect(dropped).toEqual([]);
  });
});
