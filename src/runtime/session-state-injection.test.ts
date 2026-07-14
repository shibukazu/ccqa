import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadStateIntoSession, verifySessionRestores } from "./session-state.ts";
import { spawnAB } from "./spawn-ab.ts";

vi.mock("./spawn-ab.ts", () => ({ spawnAB: vi.fn() }));

const mockedSpawnAB = vi.mocked(spawnAB);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

beforeEach(() => mockedSpawnAB.mockReset());

describe("loadStateIntoSession", () => {
  it("boots the daemon with a no-nav open, then loads the state (order matters)", () => {
    mockedSpawnAB.mockReturnValue(ok());

    const res = loadStateIntoSession("sess", "/tmp/s.json");

    expect(res.ok).toBe(true);
    // The boot must be a plain open (no --state) so state attaches to the
    // session rather than racing a navigation; state load comes second.
    expect(mockedSpawnAB.mock.calls[0]![0]).toEqual(["--session", "sess", "open", "about:blank"]);
    expect(mockedSpawnAB.mock.calls[1]![0]).toEqual(["--session", "sess", "state", "load", "/tmp/s.json"]);
  });

  it("reports the error and skips state load when the daemon fails to boot", () => {
    mockedSpawnAB.mockReturnValue({ status: 1, stdout: "", stderr: "boot failed" });

    const res = loadStateIntoSession("sess", "/tmp/s.json");

    expect(res).toEqual({ ok: false, error: "boot failed" });
    expect(mockedSpawnAB).toHaveBeenCalledTimes(1); // never reached `state load`
  });
});

describe("verifySessionRestores", () => {
  it("treats a redirect off the target URL as 'not restored'", () => {
    // open(blank) → state load → open(url) → wait → wait → eval location.href → close
    mockedSpawnAB
      .mockReturnValueOnce(ok()) // open about:blank
      .mockReturnValueOnce(ok()) // state load
      .mockReturnValueOnce(ok()) // open verifyUrl
      .mockReturnValueOnce(ok()) // wait networkidle
      .mockReturnValueOnce(ok()) // wait 3000
      .mockReturnValueOnce(ok(JSON.stringify("https://app.example/signin"))) // eval → redirected
      .mockReturnValueOnce(ok()); // close

    const res = verifySessionRestores("/tmp/s.json", "https://app.example/home");

    expect(res.restored).toBe(false);
    // Always closes the throwaway session.
    expect(mockedSpawnAB.mock.calls.at(-1)![0]).toContain("close");
  });

  it("passes when the final URL stayed at the target after restore", () => {
    mockedSpawnAB
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(ok(JSON.stringify("https://app.example/home/inbox"))) // stayed (deeper path)
      .mockReturnValueOnce(ok());

    const res = verifySessionRestores("/tmp/s.json", "https://app.example/home");

    expect(res.restored).toBe(true);
  });

  it("fails closed (not restored) and still closes the session when navigation errors", () => {
    mockedSpawnAB
      .mockReturnValueOnce(ok()) // open about:blank
      .mockReturnValueOnce(ok()) // state load
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "nav failed" }) // open verifyUrl
      .mockReturnValue(ok()); // close (and any trailing calls)

    const res = verifySessionRestores("/tmp/s.json", "https://app.example/home");

    expect(res).toEqual({ restored: false, reason: "nav failed" });
    expect(mockedSpawnAB.mock.calls.at(-1)![0]).toContain("close");
  });
});
