import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../hub-client/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hub-client/index.ts")>();
  return { ...actual, createHubClient: vi.fn(actual.createHubClient) };
});
const { createHubClient } = await import("../hub-client/index.ts");
const { parseHubHeaders, resolveHubClient, resolveHubTransport } = await import("./hub-conn.ts");
const { rememberHubConfig } = await import("../config/hub-config.ts");

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

describe("resolveHubTransport — the project's own `hub:` block", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    rememberHubConfig(undefined);
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL)) delete process.env[k];
    for (const [k, v] of Object.entries(ORIGINAL)) process.env[k] = v;
  });

  test("supplies the URL, with the token still coming from the environment", () => {
    delete process.env["CCQA_HUB_URL"];
    process.env["CCQA_HUB_TOKEN"] = "t";
    rememberHubConfig({ url: "https://hub.example.test", headers: {} });
    expect(resolveHubTransport({})?.baseUrl).toBe("https://hub.example.test");
  });

  // A credential named in a checked-in file is a credential leaked.
  test("no token in the environment means no connection, whatever the config says", () => {
    delete process.env["CCQA_HUB_TOKEN"];
    rememberHubConfig({ url: "https://hub.example.test", headers: {} });
    expect(resolveHubTransport({})).toBeNull();
  });

  test("an invocation outranks the file", () => {
    process.env["CCQA_HUB_TOKEN"] = "t";
    process.env["CCQA_HUB_URL"] = "https://from-env.example.test";
    rememberHubConfig({ url: "https://from-config.example.test", headers: {} });
    expect(resolveHubTransport({})?.baseUrl).toBe("https://from-env.example.test");
    expect(resolveHubTransport({ hubUrl: "https://from-flag.example.test" })?.baseUrl).toBe(
      "https://from-flag.example.test",
    );
  });

  // Sending `${VAR}` to a gateway earns an opaque 403; saying which variable
  // is missing earns a fix.
  test("an unset variable in a header is an error, not a header reading ${VAR}", () => {
    process.env["CCQA_HUB_TOKEN"] = "t";
    delete process.env["GATEWAY_SECRET"];
    rememberHubConfig({ url: "https://hub.example.test", headers: { "x-gate": "${GATEWAY_SECRET}" } });
    expect(() => resolveHubTransport({})).toThrow(/GATEWAY_SECRET/);
  });

  test("a header value names the variable that holds it, and is resolved when the connection is made", () => {
    process.env["CCQA_HUB_TOKEN"] = "t";
    process.env["GATEWAY_SECRET"] = "opened";
    rememberHubConfig({ url: "https://hub.example.test", headers: { "x-gate": "${GATEWAY_SECRET}" } });
    expect(resolveHubTransport({})?.headers).toEqual({ "x-gate": "opened" });
  });
});
