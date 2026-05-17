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

  test("wait routes text= prefix through --text and otherwise uses positional selector", () => {
    expect(actionToAbArgs({ command: "wait", selector: "text=Loading" }, SESSION)).toEqual([
      "--session", SESSION, "wait", "--text", "Loading", "--timeout", "5000",
    ]);
    expect(actionToAbArgs({ command: "wait", selector: "[aria-label='X']" }, SESSION)).toEqual([
      "--session", SESSION, "wait", "[aria-label='X']", "--timeout", "5000",
    ]);
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

  test("assert element_visible verifies via positional `wait` on the selector", () => {
    const action: TraceAction = { command: "assert", assertType: "element_visible", selector: "[aria-label='OK']" };
    expect(actionToAbArgs(action, SESSION)).toEqual([
      "--session", SESSION, "wait", "[aria-label='OK']", "--timeout", "10000",
    ]);
  });

  test("text_not_visible and element_not_visible asserts are skipped (vacuously true on a fresh session)", () => {
    expect(actionToAbArgs({ command: "assert", assertType: "text_not_visible", value: "Loading" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "assert", assertType: "element_not_visible", selector: "[aria-label='X']" }, SESSION)).toBeNull();
  });

  test("element_enabled/checked variants skip text= / [aria-label=] selectors that `is enabled` doesn't support reliably", () => {
    expect(actionToAbArgs({ command: "assert", assertType: "element_enabled", selector: "text=Submit" }, SESSION)).toBeNull();
    expect(actionToAbArgs({ command: "assert", assertType: "element_enabled", selector: "[aria-label='Submit']" }, SESSION)).toBeNull();
    // CSS selectors get a positional wait (existence check, not state check).
    expect(actionToAbArgs({ command: "assert", assertType: "element_enabled", selector: ".btn-submit" }, SESSION)).toEqual([
      "--session", SESSION, "wait", ".btn-submit", "--timeout", "10000",
    ]);
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
    const { kept, dropped } = validateActions(actions, { sessionName: "s" });
    expect(kept).toHaveLength(actions.length);
    expect(dropped).toHaveLength(0);
  });

  test("a failing click cascade-drops the dependent wait + assert until the next side-effecting command", () => {
    // open OK, click FAIL → wait+assert dropped as collateral → next click OK → snapshot kept.
    mockedSpawnAB
      .mockReturnValueOnce(OK)   // open
      .mockReturnValueOnce(FAIL) // click [Submit]
      .mockReturnValueOnce(OK);  // click [Next]
    const { kept, dropped } = validateActions(actions, { sessionName: "s" });
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
    const { kept, dropped } = validateActions(inOrder, { sessionName: "s" });
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
    const { kept, dropped } = validateActions(tail, { sessionName: "s" });
    expect(kept.map((a) => a.command)).toEqual(["open"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.action.command).toBe("click");
  });
});
