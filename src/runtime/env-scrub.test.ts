import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildSpecEnvScrub, scrubEnvValues } from "./env-scrub.ts";
import { BlockSpecSchema, TestSpecSchema, type TestSpec } from "../spec/yaml-schema.ts";
import { expandSpec } from "../spec/expand.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

function specOf(steps: TestSpec["steps"]): TestSpec {
  return TestSpecSchema.parse({ title: "demo", steps });
}

describe("buildSpecEnvScrub", () => {
  test("captures ${VAR} refs from action steps and resolves them against process.env", () => {
    process.env["APP_URL"] = "https://example.com";
    const spec = specOf([{ instruction: "open ${APP_URL}/", expected: "loaded" }]);
    const out = buildSpecEnvScrub(spec, expandSpec(spec, { blocks: new Map() }));
    expect(out.map).toEqual([["https://example.com", "${APP_URL}"]]);
    expect(out.unresolved).toEqual([]);
  });

  test("captures refs from `include` params, not only top-level steps", () => {
    process.env["APP_LOGIN_URL"] = "https://idp.example.com";
    process.env["LOGIN_EMAIL"] = "user@example.com";
    const login = BlockSpecSchema.parse({
      title: "login",
      params: [{ name: "loginUrl" }, { name: "email" }],
      steps: [{ instruction: "open ${loginUrl}", expected: "form" }],
    });
    const spec = specOf([
      { include: "login", params: { loginUrl: "${APP_LOGIN_URL}", email: "${LOGIN_EMAIL}" } },
      { instruction: "click", expected: "ok" },
    ]);
    const out = buildSpecEnvScrub(spec, expandSpec(spec, { blocks: new Map([["login", login]]) }));
    const placeholders = out.map.map(([, p]) => p).sort();
    expect(placeholders).toEqual(["${APP_LOGIN_URL}", "${LOGIN_EMAIL}"]);
  });

  test("captures env refs embedded INSIDE a block's own steps (not via params)", () => {
    // Regression: previously only `spec.steps` was walked, so a literal
    // `${APP_URL}` inside the block body was invisible to the scrub map
    // and got baked in at trace time.
    process.env["APP_URL"] = "https://example.com";
    const home = BlockSpecSchema.parse({
      title: "home",
      params: [],
      steps: [{ instruction: "open ${APP_URL}/", expected: "loaded" }],
    });
    const spec = specOf([{ include: "home" }]);
    const out = buildSpecEnvScrub(spec, expandSpec(spec, { blocks: new Map([["home", home]]) }));
    expect(out.map).toEqual([["https://example.com", "${APP_URL}"]]);
  });

  test("supports the bare `$VAR` form as well as `${VAR}`", () => {
    process.env["RUN_ID"] = "run-123";
    const spec = specOf([{ instruction: "wait $RUN_ID", expected: "ok" }]);
    const out = buildSpecEnvScrub(spec, expandSpec(spec, { blocks: new Map() }));
    expect(out.map).toEqual([["run-123", "${RUN_ID}"]]);
  });

  test("returns unresolved names for refs whose env value is unset or empty", () => {
    delete process.env["MISSING"];
    process.env["BLANK"] = "";
    const spec = specOf([{ instruction: "${MISSING} ${BLANK}", expected: "x" }]);
    const out = buildSpecEnvScrub(spec, expandSpec(spec, { blocks: new Map() }));
    expect(out.map).toEqual([]);
    expect(out.unresolved.sort()).toEqual(["BLANK", "MISSING"]);
  });

  test("sorts longer values first so a short value can't shadow a longer match", () => {
    process.env["SHORT"] = "abc";
    process.env["LONG"] = "abcdef";
    const spec = specOf([{ instruction: "${SHORT} ${LONG}", expected: "x" }]);
    const out = buildSpecEnvScrub(spec, expandSpec(spec, { blocks: new Map() }));
    expect(out.map[0]).toEqual(["abcdef", "${LONG}"]);
    expect(out.map[1]).toEqual(["abc", "${SHORT}"]);
  });
});

describe("scrubEnvValues", () => {
  test("replaces every occurrence of an env value with its ${VAR} placeholder", () => {
    const map: Array<[string, string]> = [["run-1779", "${CCQA_TEST_RUN_ID}"]];
    expect(scrubEnvValues("AB_ACTION|assert|text_visible|||run-1779", map))
      .toBe("AB_ACTION|assert|text_visible|||${CCQA_TEST_RUN_ID}");
  });

  test("is a no-op when the scrub map is empty", () => {
    expect(scrubEnvValues("hello", [])).toBe("hello");
  });

  test("scrubs a navigate URL back to ${VAR} exactly like a fill value", () => {
    // A navigate target must reverse-mask like any fill value, else the
    // recording pins to the environment it was captured against (`--profile`).
    const map: Array<[string, string]> = [["https://app.example.com", "${APP_BASE_URL}"]];
    expect(scrubEnvValues("AB_ACTION|open|https://app.example.com/policies", map))
      .toBe("AB_ACTION|open|${APP_BASE_URL}/policies");
  });

  test("preserves longer matches first (relies on the builder's sort guarantee)", () => {
    const map: Array<[string, string]> = [
      ["abcdef", "${LONG}"],
      ["abc", "${SHORT}"],
    ];
    expect(scrubEnvValues("abc abcdef", map)).toBe("${SHORT} ${LONG}");
  });
});
