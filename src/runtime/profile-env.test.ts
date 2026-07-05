import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyProfileEnv,
  defaultEnvPath,
  loadDefaultEnv,
  parseDotenv,
} from "./profile-env.ts";

describe("parseDotenv", () => {
  test("parses simple key=value lines", () => {
    expect(parseDotenv("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  test("skips blank lines and # comments", () => {
    const body = [
      "# a comment",
      "",
      "  ",
      "A=1",
      "# B=2 should be ignored",
    ].join("\n");
    expect(parseDotenv(body)).toEqual({ A: "1" });
  });

  test("strips a leading `export `", () => {
    expect(parseDotenv("export TOKEN=abc")).toEqual({ TOKEN: "abc" });
  });

  test("splits on the first = so values may contain =", () => {
    expect(parseDotenv("URL=https://x.com/?a=1&b=2")).toEqual({
      URL: "https://x.com/?a=1&b=2",
    });
  });

  test("unquotes a fully double- or single-quoted value", () => {
    expect(parseDotenv('A="hello world"')).toEqual({ A: "hello world" });
    expect(parseDotenv("B='hi there'")).toEqual({ B: "hi there" });
  });

  test("keeps inner quotes when the value is not fully wrapped", () => {
    expect(parseDotenv('A=say "hi"')).toEqual({ A: 'say "hi"' });
  });

  test("handles CRLF line endings", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  test("trims surrounding whitespace on key and value", () => {
    expect(parseDotenv("  A  =  v  ")).toEqual({ A: "v" });
  });

  test("ignores lines without an =", () => {
    expect(parseDotenv("NOT_A_PAIR\nA=1")).toEqual({ A: "1" });
  });

  test("drops an inline ` #` comment on an unquoted value", () => {
    expect(parseDotenv("TOKEN=abc # staging token")).toEqual({ TOKEN: "abc" });
  });

  test("keeps a `#` glued to the value (URL fragment) literal", () => {
    expect(parseDotenv("URL=https://x.com/#frag")).toEqual({
      URL: "https://x.com/#frag",
    });
  });

  test("drops trailing content after a closing quote (a real comment)", () => {
    expect(parseDotenv('PASSWORD="p@ss" # prod')).toEqual({ PASSWORD: "p@ss" });
  });

  test("keeps the whole value when a leading quote doesn't wrap it", () => {
    // `"a" and "b"` / `"x"y` start with a quote but aren't quoted values —
    // don't truncate at the first inner quote.
    expect(parseDotenv('PW="a" and "b"')).toEqual({ PW: '"a" and "b"' });
    expect(parseDotenv('PW="x"y')).toEqual({ PW: '"x"y' });
  });

  test("treats `#` inside quotes as literal", () => {
    expect(parseDotenv('A="a#b"')).toEqual({ A: "a#b" });
  });

  test("a bare value containing both a `\"` and a ` #` is truncated at the comment", () => {
    // Not a quoted value (doesn't start/end as a single quoted span), so this
    // takes the unquoted parse path, where ` #` still starts a comment —
    // relevant because callers serializing a value containing `"` must emit
    // it bare, and can't rely on `#` being preserved literally there.
    expect(parseDotenv('PW=p@ss"word #1')).toEqual({ PW: 'p@ss"word' });
  });

  test("strips `export` followed by a tab or multiple spaces", () => {
    expect(parseDotenv("export\tFOO=bar")).toEqual({ FOO: "bar" });
    expect(parseDotenv("export   BAZ=qux")).toEqual({ BAZ: "qux" });
  });

  test("empty value yields empty string", () => {
    expect(parseDotenv("EMPTY=")).toEqual({ EMPTY: "" });
  });

  test("an unterminated quote keeps the raw text", () => {
    expect(parseDotenv('A="oops')).toEqual({ A: '"oops' });
  });

  test("empty or all-comment content yields no vars", () => {
    expect(parseDotenv("")).toEqual({});
    expect(parseDotenv("# only\n# comments")).toEqual({});
  });
});

describe("applyProfileEnv", () => {
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

  test("assigns vars into process.env and returns applied names", () => {
    const applied = applyProfileEnv({ CCQA_FOO_X: "1", CCQA_FOO_Y: "2" });
    expect(process.env["CCQA_FOO_X"]).toBe("1");
    expect(process.env["CCQA_FOO_Y"]).toBe("2");
    expect(applied.sort()).toEqual(["CCQA_FOO_X", "CCQA_FOO_Y"]);
  });

  test("override=true (default): profile wins over an existing value", () => {
    process.env["CCQA_FOO_X"] = "shell";
    applyProfileEnv({ CCQA_FOO_X: "profile" });
    expect(process.env["CCQA_FOO_X"]).toBe("profile");
  });

  test("override=false: existing value is preserved, var not reported applied", () => {
    process.env["CCQA_FOO_X"] = "shell";
    const applied = applyProfileEnv(
      { CCQA_FOO_X: "profile", CCQA_FOO_Z: "new" },
      { override: false },
    );
    expect(process.env["CCQA_FOO_X"]).toBe("shell");
    expect(process.env["CCQA_FOO_Z"]).toBe("new");
    expect(applied).toEqual(["CCQA_FOO_Z"]);
  });

  test("override=false: an existing EMPTY-string value still counts as set", () => {
    process.env["CCQA_FOO_X"] = "";
    const applied = applyProfileEnv({ CCQA_FOO_X: "profile" }, { override: false });
    expect(process.env["CCQA_FOO_X"]).toBe("");
    expect(applied).toEqual([]);
  });

  test("empty input applies nothing", () => {
    expect(applyProfileEnv({})).toEqual([]);
  });

  test("returns names only, never values (so callers can log safely)", () => {
    const applied = applyProfileEnv({ CCQA_SECRET: "s3cr3t" });
    expect(applied).toEqual(["CCQA_SECRET"]);
    expect(applied).not.toContain("s3cr3t");
  });
});

describe("loadDefaultEnv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-default-env-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns null when <cwd>/.env is absent (not an error)", async () => {
    expect(await loadDefaultEnv(dir)).toBeNull();
  });

  test("reads and parses <cwd>/.env when present", async () => {
    await writeFile(join(dir, ".env"), "APP_BASE_URL=https://x.com\n", "utf8");
    expect(await loadDefaultEnv(dir)).toEqual({ APP_BASE_URL: "https://x.com" });
  });

  test("a non-ENOENT read error (.env is a directory) propagates", async () => {
    await mkdir(join(dir, ".env"));
    const err = await loadDefaultEnv(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });

  test("defaultEnvPath points at <cwd>/.env", () => {
    expect(defaultEnvPath("/repo")).toBe("/repo/.env");
  });
});
