import { afterEach, describe, expect, test, vi } from "vitest";
import { Command } from "commander";
import type { HubClient } from "../hub-client/index.ts";
import { HubApiError } from "../hub-client/index.ts";
import { HubConnectionError } from "./hub-conn.ts";
import {
  addLanguageOption,
  addProfileOption,
  applyProfileFromOption,
  DEFAULT_LANGUAGE,
  languageDirective,
  resolveProfileEnv,
  useJapanesePrompts,
} from "./options.ts";
import * as log from "./logger.ts";

vi.mock("./hub-conn.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hub-conn.ts")>();
  return { ...actual, requireHubClient: vi.fn() };
});
const { requireHubClient } = await import("./hub-conn.ts");

/** Minimal fake — only `listVariables` is exercised by these tests. */
function fakeHubClient(listVariables: HubClient["listVariables"]): HubClient {
  return { listVariables } as unknown as HubClient;
}

describe("languageDirective", () => {
  test("returns empty for 'auto' so prompts stay material-following", () => {
    expect(languageDirective("auto")).toBe("");
  });

  test("returns empty for undefined / empty (treated as auto)", () => {
    expect(languageDirective(undefined)).toBe("");
    expect(languageDirective("")).toBe("");
    expect(languageDirective("  ")).toBe("");
  });

  test("pins output to an explicit BCP-47 tag", () => {
    const out = languageDirective("ja");
    expect(out).toContain("**ja**");
    expect(out).toMatch(/Write every human-readable field/);
  });

  test("trims surrounding whitespace on the tag", () => {
    expect(languageDirective("  en ")).toContain("**en**");
  });
});

describe("useJapanesePrompts", () => {
  test("true only for an explicit Japanese tag", () => {
    expect(useJapanesePrompts("ja")).toBe(true);
    expect(useJapanesePrompts("ja-JP")).toBe(true);
    expect(useJapanesePrompts("JA")).toBe(true);
    expect(useJapanesePrompts("  ja ")).toBe(true);
  });

  test("false for auto / en / undefined so English prompts stay the default", () => {
    expect(useJapanesePrompts("auto")).toBe(false);
    expect(useJapanesePrompts("en")).toBe(false);
    expect(useJapanesePrompts(undefined)).toBe(false);
    expect(useJapanesePrompts("")).toBe(false);
    // not a word-boundary match (avoids false positives like "japanese-ish")
    expect(useJapanesePrompts("java")).toBe(false);
  });
});

describe("addLanguageOption", () => {
  test("adds a --language flag defaulting to auto", () => {
    const cmd = addLanguageOption(new Command("demo").exitOverride());
    cmd.action(() => {});
    cmd.parse([], { from: "user" });
    expect(cmd.opts().language).toBe(DEFAULT_LANGUAGE);
  });

  test("parses an explicit --language value", () => {
    const cmd = addLanguageOption(new Command("demo").exitOverride());
    cmd.action(() => {});
    cmd.parse(["--language", "ja"], { from: "user" });
    expect(cmd.opts().language).toBe("ja");
  });
});

describe("addProfileOption", () => {
  test("leaves profile undefined when the flag is absent (load is then a no-op)", () => {
    const cmd = addProfileOption(new Command("demo").exitOverride());
    cmd.action(() => {});
    cmd.parse([], { from: "user" });
    expect(cmd.opts().profile).toBeUndefined();
  });

  test("parses an explicit --profile value", () => {
    const cmd = addProfileOption(new Command("demo").exitOverride());
    cmd.action(() => {});
    cmd.parse(["--profile", "stg"], { from: "user" });
    expect(cmd.opts().profile).toBe("stg");
  });
});

describe("resolveProfileEnv / applyProfileFromOption (hub-backed profile)", () => {
  afterEach(() => {
    delete process.env.FOO;
    vi.restoreAllMocks();
  });

  test("fetches the named profile's variables from the hub and applies them", async () => {
    vi.mocked(requireHubClient).mockReturnValue(
      fakeHubClient(async () => [{ name: "FOO", sensitive: false, updatedAt: "now", value: "bar" }]),
    );

    await resolveProfileEnv({ profile: "stg", project: "demo", cwd: "/repo", hubUrl: "http://hub", hubToken: "t" });

    expect(process.env.FOO).toBe("bar");
  });

  test("warns when the hub returns no variables for the profile", async () => {
    vi.mocked(requireHubClient).mockReturnValue(fakeHubClient(async () => []));
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await resolveProfileEnv({ profile: "stg", project: "demo", cwd: "/repo", hubUrl: "http://hub", hubToken: "t" });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('profile "stg"'));
  });

  test("applyProfileFromOption exits(2) when hub connection info is missing", async () => {
    vi.mocked(requireHubClient).mockImplementation(() => {
      throw new HubConnectionError("hub URL and token are required");
    });
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(
      applyProfileFromOption({ profile: "stg", project: "demo", cwd: "/repo" }),
    ).rejects.toThrow("process.exit called");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("hub URL and token are required"));
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  test("applyProfileFromOption exits(2) on a hub API error and reports status/code", async () => {
    vi.mocked(requireHubClient).mockReturnValue(
      fakeHubClient(async () => {
        throw new HubApiError(404, "not_found", "profile not found");
      }),
    );
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(
      applyProfileFromOption({ profile: "stg", project: "demo", cwd: "/repo", hubUrl: "http://hub", hubToken: "t" }),
    ).rejects.toThrow("process.exit called");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("404"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not_found"));
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
