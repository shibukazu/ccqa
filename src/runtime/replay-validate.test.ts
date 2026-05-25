import { describe, expect, test, afterEach, vi } from "vitest";
import { actionToAbArgs, validateActions } from "./replay-validate.ts";
import { spawnAB } from "./spawn-ab.ts";
import type { TraceAction } from "../types.ts";

vi.mock("./spawn-ab.ts", () => ({
  spawnAB: vi.fn(),
  sleepSync: vi.fn(),
}));

const mockedSpawnAB = vi.mocked(spawnAB);

const SESSION = "test-session";
const ORIGINAL_ENV = { ...process.env };

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

describe("actionToAbArgs", () => {
  test("cookies_clear → cookies clear", () => {
    expect(actionToAbArgs({ command: "cookies_clear" }, SESSION)).toEqual([
      "--session", SESSION, "cookies", "clear",
    ]);
  });

  test("open resolves env refs and strips wrapping quotes", () => {
    process.env["APP_URL"] = "https://example.com";
    expect(actionToAbArgs({ command: "open", value: "\"${APP_URL}/x\"" }, SESSION)).toEqual([
      "--session", SESSION, "open", "https://example.com/x",
    ]);
  });

  test("fill/type both emit `fill` with selector + value", () => {
    expect(actionToAbArgs({ command: "fill", selector: "[name='q']", value: "hi" }, SESSION)).toEqual([
      "--session", SESSION, "fill", "[name='q']", "hi",
    ]);
    expect(actionToAbArgs({ command: "type", selector: "[name='q']", value: "hi" }, SESSION)).toEqual([
      "--session", SESSION, "fill", "[name='q']", "hi",
    ]);
  });

  test("wait routes text= prefix through --text but uses a get-count poll for CSS selectors", () => {
    expect(actionToAbArgs({ command: "wait", selector: "text=Loading" }, SESSION)).toEqual([
      "--session", SESSION, "wait", "--text", "Loading", "--timeout", "5000",
    ]);
    // CSS selector waits become a poll-present check because agent-browser's
    // `wait <selector>` ignores --timeout and blocks the daemon.
    expect(actionToAbArgs({ command: "wait", selector: "[aria-label='X']" }, SESSION)).toEqual({
      kind: "poll-present", selector: "[aria-label='X']", timeoutMs: 5000,
    });
  });

  test("flag-form waits (--load / --fn / --url) are unverifiable and return null", () => {
    // These land in `selector` with the flag text (parseAbAction puts the
    // flag in selector and its arg in label). They are readiness/observation
    // conditions, not element-existence checks, so validation must skip them
    // rather than poll `get count "--load"` (which always returns 0).
    expect(actionToAbArgs({ command: "wait", selector: "--load" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "wait", selector: "--fn" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "wait", selector: "--url" }, SESSION)).toBeNull();
  });

  test("numeric wait (sleep duration) is unverifiable and returns null", () => {
    expect(actionToAbArgs({ command: "wait", selector: "3" }, SESSION)).toBeNull();
  });

  test("snapshot is skipped (no side effect to verify)", () => {
    expect(actionToAbArgs({ command: "snapshot", observation: "page loaded" }, SESSION)).toBeNull();
  });

  test("assert text_visible verifies via `wait --text`", () => {
    const action: TraceAction = { command: "assert", assertType: "text_visible", value: "Done" };
    expect(actionToAbArgs(action, SESSION)).toEqual([
      "--session", SESSION, "wait", "--text", "Done", "--timeout", "10000",
    ]);
  });

  test("assert element_visible verifies via a get-count poll on the selector", () => {
    const action: TraceAction = { command: "assert", assertType: "element_visible", selector: "[aria-label='OK']" };
    expect(actionToAbArgs(action, SESSION)).toEqual({
      kind: "poll-present", selector: "[aria-label='OK']", timeoutMs: 10000,
    });
  });

  test("text_not_visible and element_not_visible asserts are skipped (vacuously true on a fresh session)", () => {
    expect(actionToAbArgs({ command: "assert", assertType: "text_not_visible", value: "Loading" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "assert", assertType: "element_not_visible", selector: "[aria-label='X']" }, SESSION)).toBeNull();
  });

  test("element_enabled/checked variants skip text= / [aria-label=] selectors that `is enabled` doesn't support reliably", () => {
    expect(actionToAbArgs({ command: "assert", assertType: "element_enabled", selector: "text=Submit" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "assert", assertType: "element_enabled", selector: "[aria-label='Submit']" }, SESSION)).toBeNull();
    // CSS selectors get a get-count existence poll (not a state check).
    expect(actionToAbArgs({ command: "assert", assertType: "element_enabled", selector: ".btn-submit" }, SESSION)).toEqual({
      kind: "poll-present", selector: ".btn-submit", timeoutMs: 10000,
    });
  });

  test("url_contains is skipped (URL probe, not a DOM check)", () => {
    expect(actionToAbArgs({ command: "assert", assertType: "url_contains", value: "/dashboard" }, SESSION)).toBeNull();
  });

  test("wait with an empty selector is unverifiable (not a forced failure)", () => {
    // Without this guard, the empty selector would be passed positionally to
    // `agent-browser wait ""` and the failure would cascade-drop subsequent
    // passive actions. Treat it as a no-op instead.
    expect(actionToAbArgs({ command: "wait", selector: "" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "wait" }, SESSION)).toBeNull();
  });

  test("find_click text → `find text <v> click`", () => {
    expect(
      actionToAbArgs(
        { command: "find_click", findLocator: "text", findValue: "Sign In" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "text", "Sign In", "click"]);
  });

  test("find_click text + --exact appends the flag in order", () => {
    expect(
      actionToAbArgs(
        { command: "find_click", findLocator: "text", findValue: "OK", findExact: true },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "text", "OK", "click", "--exact"]);
  });

  test("find_click role + --name", () => {
    expect(
      actionToAbArgs(
        { command: "find_click", findLocator: "role", findValue: "button", findName: "Submit" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "role", "button", "click", "--name", "Submit"]);
  });

  test("find_click last + inner CSS selector", () => {
    expect(
      actionToAbArgs(
        { command: "find_click", findLocator: "last", findValue: "[aria-label='Reply']" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "last", "[aria-label='Reply']", "click"]);
  });

  test("find_click nth puts index before the inner selector", () => {
    expect(
      actionToAbArgs(
        { command: "find_click", findLocator: "nth", findValue: "button.reply", findIndex: 2 },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "nth", "2", "button.reply", "click"]);
  });

  test("find_fill carries the input value after the action", () => {
    expect(
      actionToAbArgs(
        { command: "find_fill", findLocator: "label", findValue: "Email", value: "user@example.com" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "label", "Email", "fill", "user@example.com"]);
  });

  test("never emits --name on non-role locators even if findName slipped through", () => {
    // Defensive: agent-browser rejects --name on text/label/etc. Even if a
    // stray findName slips into actions.json, the replay path must drop it.
    expect(
      actionToAbArgs(
        { command: "find_click", findLocator: "text", findValue: "Sign In", findName: "ignored" },
        SESSION,
      ),
    ).toEqual(["--session", SESSION, "find", "text", "Sign In", "click"]);
  });

  test("treats a malformed find_click (no locator/value) as unverifiable", () => {
    expect(actionToAbArgs({ command: "find_click" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "find_click", findLocator: "text" }, SESSION)).toBeNull();
  });
});

describe("validateActions", () => {
  const actions: TraceAction[] = [
    { command: "open", value: "/" },
    { command: "click", selector: "[aria-label='Submit']" },
    { command: "wait", selector: "text=Done" },
    { command: "assert", assertType: "text_visible", value: "Done" },
    { command: "click", selector: "[aria-label='Next']" },
    { command: "snapshot", observation: "next page" },
  ];

  test("keeps every action when each agent-browser call succeeds", () => {
    mockedSpawnAB.mockReturnValue(OK);
    const { kept, dropped } = validateActions(actions, { sessionName: "s", mode: "strict" });
    expect(kept).toHaveLength(actions.length);
    expect(dropped).toHaveLength(0);
  });

  test("a failing click cascade-drops the dependent wait + assert until the next side-effecting command", () => {
    // open OK, click FAIL → wait+assert dropped as collateral → next click OK → snapshot kept.
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click [Submit]
      .mockReturnValueOnce(OK);  // click [Next]
    const { kept, dropped } = validateActions(actions, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open", "click", "snapshot"]);
    expect(kept[1]!.selector).toBe("[aria-label='Next']");
    expect(dropped.map((d) => d.action.command)).toEqual(["click", "wait", "assert"]);
    // First drop is the real failure; the next two are collateral.
    expect(dropped[0]!.reason).toContain("selector not found");
    expect(dropped[1]!.reason).toMatch(/skipped after/);
    expect(dropped[2]!.reason).toMatch(/skipped after/);
  });

  test("snapshot is always kept in isolation (no args to spawn), but dropped as collateral after a failure", () => {
    const inOrder: TraceAction[] = [
      { command: "snapshot", observation: "home" },              // always kept
      { command: "click", selector: "[aria-label='X']" },         // FAIL
      { command: "snapshot", observation: "after click" },        // collateral drop
      { command: "click", selector: "[aria-label='Y']" },         // OK; resets cascade
      { command: "snapshot", observation: "after Y" },            // kept
    ];
    mockedSpawnAB
      .mockReturnValueOnce(FAIL) // click X
      .mockReturnValueOnce(OK);  // click Y
    const { kept, dropped } = validateActions(inOrder, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["snapshot", "click", "snapshot"]);
    expect(kept[1]!.selector).toBe("[aria-label='Y']");
    expect(dropped.map((d) => d.action.command)).toEqual(["click", "snapshot"]);
  });

  test("a failure on the last action does not crash and reports the one drop", () => {
    const tail: TraceAction[] = [
      { command: "open", value: "/" },
      { command: "click", selector: "[aria-label='X']" },
    ];
    mockedSpawnAB.mockReturnValueOnce(OK).mockReturnValueOnce(FAIL);
    const { kept, dropped } = validateActions(tail, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.action.command).toBe("click");
  });

  test("a CSS-selector wait is validated by polling `get count` (never the blocking `wait <selector>`)", () => {
    const seq: TraceAction[] = [
      { command: "open", value: "/" },
      { command: "wait", selector: "[aria-label='Saved']" },
    ];
    // open → OK; the wait becomes a poll-present → `get count` returns "1".
    mockedSpawnAB
      .mockReturnValueOnce(OK)            // open
      .mockReturnValueOnce(COUNT_PRESENT); // get count → 1
    const { kept, dropped } = validateActions(seq, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open", "wait"]);
    expect(dropped).toHaveLength(0);
    // Crucially, the spawn args were a `get count`, not a `wait <selector>`.
    const calls = mockedSpawnAB.mock.calls.map((c) => c[0]);
    expect(calls.some((a) => a.includes("get") && a.includes("count"))).toBe(true);
    expect(calls.some((a) => a[a.indexOf("--session") + 2] === "wait" && a.includes("[aria-label='Saved']"))).toBe(false);
  });

  test("a CSS-selector wait that never appears is dropped after the poll times out", () => {
    const seq: TraceAction[] = [
      { command: "open", value: "/" },
      { command: "wait", selector: "[aria-label='NeverShows']" },
    ];
    // open OK; poll always returns "0" → eventually times out and drops.
    mockedSpawnAB.mockReturnValueOnce(OK).mockReturnValue(COUNT_ABSENT);
    const { kept, dropped } = validateActions(seq, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(dropped.map((d) => d.action.command)).toEqual(["wait"]);
    expect(dropped[0]!.reason).toMatch(/not present/);
  });

  test("step boundary lifts the cascade — next step's wait/assert are retried", () => {
    // step-01 click fails. step-02's wait is independent and should be tried.
    const stepped: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
      { command: "click", selector: "[aria-label='X']", stepId: "step-01" },
      { command: "wait", selector: "text=Loading", stepId: "step-01" }, // collateral
      { command: "wait", selector: "text=Welcome", stepId: "step-02" }, // independent
      { command: "assert", assertType: "text_visible", value: "Welcome", stepId: "step-02" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click (step-01) → cascade armed
      // (step-01 wait is skipped without spawnAB call)
      .mockReturnValueOnce(OK)   // step-02 wait
      .mockReturnValueOnce(OK);  // step-02 assert
    const { kept, dropped } = validateActions(stepped, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open", "wait", "assert"]);
    expect(kept[1]!.stepId).toBe("step-02");
    expect(dropped.map((d) => d.action.command)).toEqual(["click", "wait"]);
    expect(dropped[1]!.action.stepId).toBe("step-01");
  });

  test("a passive failure (assert/wait/snapshot) does NOT cascade — the next passive is still tried", () => {
    // Two independent asserts in the same step: the first fails, the second
    // should still get tried because asserts don't mutate page state.
    const sameStep: TraceAction[] = [
      { command: "assert", assertType: "text_visible", value: "Foo", stepId: "step-01" },
      { command: "assert", assertType: "text_visible", value: "Bar", stepId: "step-01" },
      { command: "snapshot", observation: "after", stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(FAIL) // assert Foo
      .mockReturnValueOnce(OK);  // assert Bar (snapshot has no args to spawn)
    const { kept, dropped } = validateActions(sameStep, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["assert", "snapshot"]);
    expect(kept[0]!.value).toBe("Bar");
    expect(dropped.map((d) => d.action.value)).toEqual(["Foo"]);
  });

  test("hard timeout triggers exactly one retry; pass on retry is treated as success", () => {
    const timeout = { status: null, stdout: "", stderr: "\n[ccqa] agent-browser killed after hard timeout" };
    mockedSpawnAB
      .mockReturnValueOnce(OK)       // open
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
    const timeout = { status: null, stdout: "", stderr: "\n[ccqa] agent-browser killed after hard timeout" };
    const tail: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
      { command: "click", selector: "[aria-label='X']", stepId: "step-01" },
      { command: "wait", selector: "text=Done", stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)
      .mockReturnValueOnce(timeout) // 1st
      .mockReturnValueOnce(timeout) // retry
      ;
    const { kept, dropped } = validateActions(tail, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(dropped.map((d) => d.action.command)).toEqual(["click", "wait"]);
    expect(dropped[0]!.reason).toMatch(/killed after hard timeout/);
  });

  test("rescue: a step that lost everything has its surviving-on-retry actions promoted back", () => {
    // step-08 click fails (cascade armed) → wait dropped as collateral →
    // step-08 has zero kept actions → rescue replays both, second one passes.
    const recoverable: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-07" },
      { command: "click", selector: "[aria-label='X']", stepId: "step-08" },
      { command: "wait", selector: "text=Saved", stepId: "step-08" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click → cascade
      // wait collateral — not spawned
      .mockReturnValueOnce(FAIL) // rescue: click again, still fails
      .mockReturnValueOnce(OK);  // rescue: wait passes
    const { kept, dropped, rescuedSteps } = validateActions(recoverable, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open", "wait"]);
    expect(kept[1]!.stepId).toBe("step-08");
    expect(dropped.map((d) => d.action.command)).toEqual(["click"]);
    expect(rescuedSteps).toEqual(["step-08"]);
  });

  test("rescue: a step where every retry also fails stays lost", () => {
    const unrecoverable: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-07" },
      { command: "click", selector: "[aria-label='X']", stepId: "step-08" },
      { command: "wait", selector: "text=Saved", stepId: "step-08" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click
      .mockReturnValueOnce(FAIL) // rescue: click
      .mockReturnValueOnce(FAIL); // rescue: wait
    const { kept, dropped, rescuedSteps } = validateActions(unrecoverable, { sessionName: "s", mode: "strict" });
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(dropped.map((d) => d.action.command)).toEqual(["click", "wait"]);
    expect(rescuedSteps ?? []).toEqual([]);
  });

  test("rescue: does NOT touch steps that already kept at least one action", () => {
    const partiallyKept: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-07" },
      { command: "click", selector: "[aria-label='OK']", stepId: "step-07" },
      { command: "wait", selector: "text=Foo", stepId: "step-07" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click
      // wait collateral — not spawned, but step-07 already has `open` kept
      ;
    const { kept, dropped, rescuedSteps } = validateActions(partiallyKept, { sessionName: "s", mode: "strict" });
    // Partial loss — no rescue should fire; downstream wait stays dropped.
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(dropped.map((d) => d.action.command)).toEqual(["click", "wait"]);
    expect(rescuedSteps ?? []).toEqual([]);
  });
});

describe("validateActions (lenient mode)", () => {
  test("default mode is lenient — failures move to `unstable`, dropped stays empty", () => {
    const actions: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
      { command: "click", selector: "[aria-label='Submit']", stepId: "step-01" },
      { command: "wait", selector: "text=Done", stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click → fails
      .mockReturnValueOnce(FAIL) // rescue: click
      .mockReturnValueOnce(FAIL) // rescue: wait
      ;
    // Omit `mode` to verify the default.
    const { kept, unstable, dropped } = validateActions(actions, { sessionName: "s" });
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(unstable.map((a) => a.command)).toEqual(["click", "wait"]);
    expect(dropped).toEqual([]);
  });

  test("lenient tags failing actions with replayUnstable + replayReason", () => {
    const actions: TraceAction[] = [
      { command: "click", selector: "[aria-label='X']", stepId: "step-01" },
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
    const actions: TraceAction[] = [
      { command: "click", selector: "[aria-label='X']", stepId: "step-01" },
      { command: "wait", selector: "text=Saved", stepId: "step-01" },
    ];
    mockedSpawnAB
      .mockReturnValueOnce(FAIL) // 1st-pass click → cascade armed
      .mockReturnValueOnce(FAIL) // rescue: click fails again
      .mockReturnValueOnce(OK);  // rescue: wait passes
    const { kept, unstable, rescuedSteps } = validateActions(actions, { sessionName: "s", mode: "lenient" });
    expect(kept.map((a) => a.command)).toEqual(["wait"]);
    expect(unstable.map((a) => a.command)).toEqual(["click"]);
    expect(rescuedSteps).toEqual(["step-01"]);
  });

  test("lenient: a fully-passing run yields empty unstable + empty dropped", () => {
    const actions: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
      { command: "click", selector: "[aria-label='OK']", stepId: "step-01" },
    ];
    mockedSpawnAB.mockReturnValue(OK);
    const { kept, unstable, dropped } = validateActions(actions, { sessionName: "s", mode: "lenient" });
    expect(kept).toHaveLength(2);
    expect(unstable).toEqual([]);
    expect(dropped).toEqual([]);
  });
});
