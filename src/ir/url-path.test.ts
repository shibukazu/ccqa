import { afterEach, describe, expect, test } from "vitest";
import { parseAbActionLine } from "./from-agent-browser.ts";
import { collapseUrlPath } from "./url-path.ts";
import { scrubEnvValues } from "../runtime/env-scrub.ts";
import { actionToAbArgs } from "../runtime/replay-validate.ts";

/** What a recorded `open` becomes once the route is scrubbed back to refs. */
function recordThenScrub(browserUrl: string, base: string): string {
  const action = parseAbActionLine(`AB_ACTION|open|${browserUrl}`);
  return scrubEnvValues((action as { value: string }).value, [[base, "${BASE}"]]);
}

const ORIGINAL = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
  for (const [k, v] of Object.entries(ORIGINAL)) process.env[k] = v;
});

describe("collapseUrlPath", () => {
  test("collapses the path, and leaves the scheme, the query and an unchanged URL alone", () => {
    expect(collapseUrlPath("https://h//todos")).toBe("https://h/todos");
    expect(collapseUrlPath("file:///repo/index.html")).toBe("file:///repo/index.html");
    expect(collapseUrlPath("https://h/x?next=https://y")).toBe("https://h/x?next=https://y");
    expect(collapseUrlPath("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

// Measured: the model writes `open "${BASE}/todos"`, the shell expands a base
// that already ends in one, and the browser is handed `//todos` — which the
// product answers differently, so the list never renders and every assertion
// after it reads zero.
describe("a base URL that already ends in a slash", () => {
  test("records as ${BASE}todos, and replays against the URL the product has", () => {
    expect(recordThenScrub("https://h//todos", "https://h/")).toBe("${BASE}todos");

    process.env["BASE"] = "https://h/";
    expect(actionToAbArgs({ action: "navigate", value: "${BASE}todos" }, "s1")).toEqual([
      "--session", "s1", "open", "https://h/todos",
    ]);
  });

  // The route this case was recorded from is already in someone's ir.json, and
  // re-recording to fix it is the expensive thing this avoids.
  test("a route recorded before this still resolves to one slash", () => {
    process.env["BASE"] = "https://h/";
    expect(actionToAbArgs({ action: "navigate", value: "${BASE}/todos" }, "s1")).toEqual([
      "--session", "s1", "open", "https://h/todos",
    ]);
  });
});

describe("a base URL with no trailing slash", () => {
  test("keeps the slash the path needs, on both sides", () => {
    expect(recordThenScrub("https://h/todos", "https://h")).toBe("${BASE}/todos");

    process.env["BASE"] = "https://h";
    expect(actionToAbArgs({ action: "navigate", value: "${BASE}/todos" }, "s1")).toEqual([
      "--session", "s1", "open", "https://h/todos",
    ]);
  });
});
