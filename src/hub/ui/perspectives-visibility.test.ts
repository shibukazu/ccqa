import { describe, expect, test } from "vitest";
import { renderHubUi } from "./index.ts";

const HTML = renderHubUi();

/**
 * Two decisions the page makes before rendering: which cases it is answering
 * about, and where a result link goes. Each is written self-contained between
 * its markers so it can be run here without a browser — the same lift
 * rerun-view.test.ts uses.
 */
function lift<T>(name: string, exports: string[]): T {
  const script = HTML.slice(HTML.indexOf("<script>") + "<script>".length, HTML.lastIndexOf("</script>"));
  const start = script.indexOf(`// --- pure: ${name}`);
  const end = script.indexOf(`// --- end pure: ${name}`);
  expect(start, `the pure ${name} region is missing`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const returned = exports.map((e) => `${e}: ${e}`).join(", ");
  return new Function(`${script.slice(start, end)}\nreturn { ${returned} };`)() as T;
}

function pure(): {
  perspHidden: (spec: { disabled?: boolean }, showDisabled: boolean) => boolean;
  runCaseHref: (runId: string, caseKey: string | null) => string;
  parseRunHash: (hash: string) => { runId: string; caseKey: string | null } | null;
} {
  return {
    ...lift<{ perspHidden: never }>("perspectives visibility", ["perspHidden"]),
    ...lift<{ runCaseHref: never; parseRunHash: never }>("run hash", ["runCaseHref", "parseRunHash"]),
  } as ReturnType<typeof pure>;
}

describe("perspHidden", () => {
  // A spec with no `disabled` key at all is the common case — the flag is
  // optional, and reading its absence as "hidden" would empty the page.
  test("hides only what was explicitly disabled", () => {
    const { perspHidden } = pure();
    expect(perspHidden({ disabled: true }, false)).toBe(true);
    expect(perspHidden({ disabled: true }, true)).toBe(false);
    expect(perspHidden({}, false)).toBe(false);
  });
});

describe("run links carrying a case", () => {
  test("a case round-trips through the hash it is linked by", () => {
    const { runCaseHref, parseRunHash } = pure();
    const href = runCaseHref("2026-08-30T00-58-04Z-daf4", "demo/admin-analytics");
    expect(parseRunHash(href)).toEqual({
      runId: "2026-08-30T00-58-04Z-daf4",
      caseKey: "demo/admin-analytics",
    });
  });

  test("a link with no case still opens the run", () => {
    const { runCaseHref, parseRunHash } = pure();
    expect(parseRunHash(runCaseHref("run-1", null))).toEqual({ runId: "run-1", caseKey: null });
  });

  // The route has to keep answering for links printed before it learned about
  // cases — `ccqa hub push` has been printing them all along.
  test("reads a plain run hash", () => {
    expect(pure().parseRunHash("#/runs/run-1")).toEqual({ runId: "run-1", caseKey: null });
  });

  test("declines a hash that names no run", () => {
    const { parseRunHash } = pure();
    expect(parseRunHash("#/perspectives")).toBeNull();
    expect(parseRunHash("#/jobs/abc")).toBeNull();
  });

  // A truncated paste leaves a half-written %XX. Thrown, that reads as "you
  // are disconnected" and shows the login gate for a link that names a run.
  test("still names the run when the hash was cut mid-escape", () => {
    const { parseRunHash } = pure();
    expect(parseRunHash("#/runs/100%")).toEqual({ runId: "100%", caseKey: null });
    expect(parseRunHash("#/runs/run-1?case=50%")).toEqual({ runId: "run-1", caseKey: "50%" });
  });
});

describe("the disabled toggle", () => {
  // Ships off: the page opens on what the project verifies.
  test("is not checked in the served markup", () => {
    const tag = HTML.match(/<input[^>]*id="persp-show-disabled"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).not.toMatch(/\bchecked\b/);
  });
});
