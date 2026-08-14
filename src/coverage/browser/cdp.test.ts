import { describe, expect, it } from "vitest";

import { browserWebSocketUrl, CdpError } from "./cdp.ts";

describe("browserWebSocketUrl", () => {
  it("passes a browser-level ws URL through untouched", async () => {
    const url = "ws://127.0.0.1:9222/devtools/browser/abc-def";
    await expect(browserWebSocketUrl(url)).resolves.toBe(url);
  });

  it("rejects something that is not an endpoint at all", async () => {
    await expect(browserWebSocketUrl("not a url at all \n")).rejects.toThrow(CdpError);
  });

  it("re-resolves a page-level ws URL through the host, not as-is", async () => {
    // A page session is not enough to see every tab; the helper must go back
    // to /json/version. The host here answers nothing, so the observable is
    // the error naming the endpoint rather than a silent pass-through.
    await expect(
      browserWebSocketUrl("ws://127.0.0.1:1/devtools/page/abc"),
    ).rejects.toThrow(/127\.0\.0\.1:1/);
  });
});
