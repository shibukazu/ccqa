import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../hub-client/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hub-client/index.ts")>();
  return { ...actual, createHubClient: vi.fn(actual.createHubClient) };
});
const { createHubClient } = await import("../hub-client/index.ts");
const { parseHubHeaders, resolveHubClient } = await import("./hub-conn.ts");

describe("parseHubHeaders", () => {
  test("parses a single 'key:value' entry", () => {
    expect(parseHubHeaders(["x-foo:bar"])).toEqual({ "x-foo": "bar" });
  });

  test("splits only on the first colon (value may itself contain ':')", () => {
    expect(parseHubHeaders(["x-foo:http://example.com"])).toEqual({ "x-foo": "http://example.com" });
  });

  test("merges multiple entries", () => {
    expect(parseHubHeaders(["x-foo:bar", "x-baz:qux"])).toEqual({ "x-foo": "bar", "x-baz": "qux" });
  });

  test("throws on an entry with no colon", () => {
    expect(() => parseHubHeaders(["x-foo"])).toThrow(/invalid --hub-header/);
  });
});

describe("resolveHubClient custom headers", () => {
  afterEach(() => {
    delete process.env.CCQA_HUB_HEADER;
    vi.mocked(createHubClient).mockClear();
  });

  test("passes parsed --hub-header entries through to createHubClient", () => {
    resolveHubClient({ hubUrl: "http://hub", hubToken: "t", hubHeader: ["x-foo:bar"] });

    expect(createHubClient).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { "x-foo": "bar" } }),
    );
  });

  test("falls back to CCQA_HUB_HEADER when --hub-header is absent", () => {
    process.env.CCQA_HUB_HEADER = "x-foo:bar";

    resolveHubClient({ hubUrl: "http://hub", hubToken: "t" });

    expect(createHubClient).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { "x-foo": "bar" } }),
    );
  });

  test("--hub-header takes precedence over CCQA_HUB_HEADER", () => {
    process.env.CCQA_HUB_HEADER = "x-env:should-not-win";

    resolveHubClient({ hubUrl: "http://hub", hubToken: "t", hubHeader: ["x-flag:should-win"] });

    expect(createHubClient).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { "x-flag": "should-win" } }),
    );
  });

  test("omits headers entirely when neither --hub-header nor CCQA_HUB_HEADER is set", () => {
    resolveHubClient({ hubUrl: "http://hub", hubToken: "t" });

    const call = vi.mocked(createHubClient).mock.calls[0]![0];
    expect(call.headers).toBeUndefined();
  });
});
