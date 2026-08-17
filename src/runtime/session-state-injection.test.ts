import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkLiveSessionHealth,
  loadStateIntoSession,
  recoverLiveSession,
  verifySessionRestores,
} from "./session-state.ts";
import { spawnAB } from "./spawn-ab.ts";

vi.mock("./spawn-ab.ts", () => ({ spawnAB: vi.fn() }));

const mockedSpawnAB = vi.mocked(spawnAB);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", wedged: false });

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
    mockedSpawnAB.mockReturnValue({ status: 1, stdout: "", stderr: "boot failed", wedged: false });

    const res = loadStateIntoSession("sess", "/tmp/s.json");

    expect(res).toEqual({ ok: false, error: "boot failed", wedged: false });
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
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "nav failed", wedged: false }) // open verifyUrl
      .mockReturnValue(ok()); // close (and any trailing calls)

    const res = verifySessionRestores("/tmp/s.json", "https://app.example/home");

    expect(res).toEqual({ restored: false, reason: "nav failed" });
    expect(mockedSpawnAB.mock.calls.at(-1)![0]).toContain("close");
  });
});

describe("checkLiveSessionHealth", () => {
  it("is healthy on any real page, reading the URL without navigating", () => {
    mockedSpawnAB.mockReturnValueOnce(ok(JSON.stringify("https://app.example/home/inbox")));
    expect(checkLiveSessionHealth("sess")).toEqual({ healthy: true });
    expect(mockedSpawnAB.mock.calls[0]![0]).toEqual(["--session", "sess", "eval", "location.href"]);
  });

  it("stays healthy on a different origin — a spec may roam mid-flow", () => {
    // A false 'unhealthy' here would wipe auth the spec acquired at runtime.
    mockedSpawnAB.mockReturnValueOnce(ok(JSON.stringify("https://admin.other/tickets")));
    expect(checkLiveSessionHealth("sess")).toEqual({ healthy: true });
  });

  it("reports a cut-off probe as unresponsive — the remedy is to kill the daemon", () => {
    mockedSpawnAB.mockReturnValueOnce({ status: null, stdout: "", stderr: "timed out", wedged: true });
    expect(checkLiveSessionHealth("sess")).toEqual({
      healthy: false,
      kind: "unresponsive",
      reason: "timed out",
    });
  });

  it("keeps an answered error responsive — killing a daemon that replied helps nothing", () => {
    mockedSpawnAB.mockReturnValueOnce({ status: 1, stdout: "", stderr: "no session", wedged: false });
    expect(checkLiveSessionHealth("sess")).toEqual({
      healthy: false,
      kind: "errored",
      reason: "no session",
    });
  });

  it("reports a blank page as responsive — the remedy is to put the state back", () => {
    mockedSpawnAB.mockReturnValueOnce(ok(JSON.stringify("about:blank")));
    expect(checkLiveSessionHealth("sess")).toEqual({
      healthy: false,
      kind: "blank",
      reason: expect.stringContaining("about:blank"),
    });
  });
});

describe("recoverLiveSession", () => {
  it("re-injects the state (open blank + state load) then re-opens the verify URL", () => {
    mockedSpawnAB.mockReturnValue(ok());
    const res = recoverLiveSession("sess", "/tmp/s.json", "https://app.example/home");
    expect(res.ok).toBe(true);
    expect(mockedSpawnAB.mock.calls[0]![0]).toEqual(["--session", "sess", "open", "about:blank"]);
    expect(mockedSpawnAB.mock.calls[1]![0]).toEqual(["--session", "sess", "state", "load", "/tmp/s.json"]);
    expect(mockedSpawnAB.mock.calls[2]![0]).toEqual(["--session", "sess", "open", "https://app.example/home"]);
  });

  it("surfaces the injection error and skips the re-open when re-injection fails", () => {
    mockedSpawnAB.mockReturnValueOnce({ status: 1, stdout: "", stderr: "boot failed", wedged: false });
    const res = recoverLiveSession("sess", "/tmp/s.json", "https://app.example/home");
    expect(res).toEqual({ ok: false, error: "boot failed", wedged: false });
    expect(mockedSpawnAB).toHaveBeenCalledTimes(1); // never reached the re-open
  });

  it("still brings the browser back when the session has no saved state", () => {
    mockedSpawnAB.mockReturnValue(ok());
    expect(recoverLiveSession("sess", null, null).ok).toBe(true);
    expect(mockedSpawnAB.mock.calls).toEqual([[["--session", "sess", "open", "about:blank"]]]);
  });
});
