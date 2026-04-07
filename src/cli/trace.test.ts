import { describe, test, expect } from "bun:test";
import { parseAbAction, parseStatusLine, parseRouteStep } from "./trace.ts";

describe("parseAbAction", () => {
  test("returns null for non-AB_ACTION lines", () => {
    expect(parseAbAction("some text")).toBeNull();
    expect(parseAbAction("")).toBeNull();
    expect(parseAbAction("ROUTE_STEP|step-01|title")).toBeNull();
  });

  test("returns null for unknown commands", () => {
    expect(parseAbAction("AB_ACTION|unknown|arg")).toBeNull();
    expect(parseAbAction("AB_ACTION|navigate|http://example.com")).toBeNull();
  });

  test("parses open", () => {
    expect(parseAbAction("AB_ACTION|open|http://localhost:3000")).toEqual({
      command: "open",
      value: "http://localhost:3000",
    });
  });

  test("parses press", () => {
    expect(parseAbAction("AB_ACTION|press|Enter")).toEqual({
      command: "press",
      value: "Enter",
    });
  });

  test("parses scroll", () => {
    expect(parseAbAction("AB_ACTION|scroll|down|300")).toEqual({
      command: "scroll",
      direction: "down",
      pixels: "300",
    });
  });

  test("parses snapshot", () => {
    expect(parseAbAction("AB_ACTION|snapshot|Login page loaded")).toEqual({
      command: "snapshot",
      observation: "Login page loaded",
    });
  });

  test("parses click", () => {
    expect(parseAbAction("AB_ACTION|click|[aria-label='Login']|Login")).toEqual({
      command: "click",
      selector: "[aria-label='Login']",
      label: "Login",
    });
  });

  test("parses dblclick", () => {
    expect(parseAbAction("AB_ACTION|dblclick|[aria-label='Item']|Item")).toEqual({
      command: "dblclick",
      selector: "[aria-label='Item']",
      label: "Item",
    });
  });

  test("parses check", () => {
    expect(parseAbAction("AB_ACTION|check|[aria-label='Agree']|Agree")).toEqual({
      command: "check",
      selector: "[aria-label='Agree']",
      label: "Agree",
    });
  });

  test("parses uncheck", () => {
    expect(parseAbAction("AB_ACTION|uncheck|[aria-label='Agree']|Agree")).toEqual({
      command: "uncheck",
      selector: "[aria-label='Agree']",
      label: "Agree",
    });
  });

  test("parses hover", () => {
    expect(parseAbAction("AB_ACTION|hover|[aria-label='Menu']|Menu")).toEqual({
      command: "hover",
      selector: "[aria-label='Menu']",
      label: "Menu",
    });
  });

  test("parses wait with selector", () => {
    expect(parseAbAction("AB_ACTION|wait|[aria-label='Loading']|Loading")).toEqual({
      command: "wait",
      selector: "[aria-label='Loading']",
      label: "Loading",
    });
  });

  test("parses wait --text as text= selector", () => {
    expect(parseAbAction("AB_ACTION|wait|--text|Done")).toEqual({
      command: "wait",
      selector: "text=Done",
      label: undefined,
    });
  });

  test("parses fill", () => {
    expect(parseAbAction("AB_ACTION|fill|[aria-label='Email']|user@example.com|Email")).toEqual({
      command: "fill",
      selector: "[aria-label='Email']",
      value: "user@example.com",
      label: "Email",
    });
  });

  test("parses type", () => {
    expect(parseAbAction("AB_ACTION|type|[aria-label='Search']|query text|Search")).toEqual({
      command: "type",
      selector: "[aria-label='Search']",
      value: "query text",
      label: "Search",
    });
  });

  test("parses select", () => {
    expect(parseAbAction("AB_ACTION|select|[aria-label='Color']|red|Color")).toEqual({
      command: "select",
      selector: "[aria-label='Color']",
      value: "red",
      label: "Color",
    });
  });

  test("parses drag", () => {
    expect(parseAbAction("AB_ACTION|drag|[aria-label='Source']|[aria-label='Target']|Source")).toEqual({
      command: "drag",
      selector: "[aria-label='Source']",
      target: "[aria-label='Target']",
      label: "Source",
    });
  });
});

describe("parseStatusLine", () => {
  test("parses STEP_START", () => {
    expect(parseStatusLine("STEP_START|step-01|Login")).toEqual({
      type: "STEP_START",
      stepId: "step-01",
      detail: "Login",
    });
  });

  test("parses STEP_DONE", () => {
    expect(parseStatusLine("STEP_DONE|step-01|Verified redirect")).toEqual({
      type: "STEP_DONE",
      stepId: "step-01",
      detail: "Verified redirect",
    });
  });

  test("parses ASSERTION_FAILED", () => {
    expect(parseStatusLine("ASSERTION_FAILED|step-03|app-bug: button not disabled")).toEqual({
      type: "ASSERTION_FAILED",
      stepId: "step-03",
      detail: "app-bug: button not disabled",
    });
  });

  test("parses STEP_SKIPPED", () => {
    expect(parseStatusLine("STEP_SKIPPED|step-02|previous step failed")).toEqual({
      type: "STEP_SKIPPED",
      stepId: "step-02",
      detail: "previous step failed",
    });
  });

  test("parses RUN_COMPLETED passed", () => {
    expect(parseStatusLine("RUN_COMPLETED|passed|All steps done")).toEqual({
      type: "RUN_COMPLETED",
      stepId: "passed",
      detail: "All steps done",
    });
  });

  test("returns null for non-matching lines", () => {
    expect(parseStatusLine("some random text")).toBeNull();
    expect(parseStatusLine("")).toBeNull();
    expect(parseStatusLine("ROUTE_STEP|step-01|title|ACTION:did|OBS:saw|STATUS:PASSED")).toBeNull();
  });

  test("returns first matching line from multi-line text", () => {
    const text = "some preamble\nSTEP_START|step-01|Title\nmore text";
    expect(parseStatusLine(text)).toEqual({
      type: "STEP_START",
      stepId: "step-01",
      detail: "Title",
    });
  });
});

describe("parseRouteStep", () => {
  test("parses a complete ROUTE_STEP line", () => {
    const line = "ROUTE_STEP|step-01|Login|ACTION:filled form and pressed Enter|OBSERVATION:redirected to /dashboard|STATUS:PASSED";
    expect(parseRouteStep(line)).toEqual({
      title: "Login",
      action: "filled form and pressed Enter",
      observation: "redirected to /dashboard",
      status: "PASSED",
    });
  });

  test("parses FAILED status", () => {
    const line = "ROUTE_STEP|step-02|Check|ACTION:clicked button|OBSERVATION:nothing happened|STATUS:FAILED";
    expect(parseRouteStep(line)?.status).toBe("FAILED");
  });

  test("parses SKIPPED status", () => {
    const line = "ROUTE_STEP|step-03|Skip|ACTION:skipped|OBSERVATION:n/a|STATUS:SKIPPED";
    expect(parseRouteStep(line)?.status).toBe("SKIPPED");
  });

  test("returns null when fewer than 6 parts", () => {
    expect(parseRouteStep("ROUTE_STEP|step-01|title|ACTION:did")).toBeNull();
    expect(parseRouteStep("")).toBeNull();
  });

  test("defaults to FAILED for unrecognized status", () => {
    const line = "ROUTE_STEP|step-01|Title|ACTION:did|OBSERVATION:saw|STATUS:UNKNOWN";
    expect(parseRouteStep(line)?.status).toBe("FAILED");
  });

  test("strips ACTION: and OBSERVATION: prefixes", () => {
    const line = "ROUTE_STEP|step-01|Title|ACTION:my action|OBSERVATION:my observation|STATUS:PASSED";
    const result = parseRouteStep(line);
    expect(result?.action).toBe("my action");
    expect(result?.observation).toBe("my observation");
  });
});

