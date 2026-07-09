import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../diagnose/snapshot.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagnose/snapshot.ts")>();
  return { ...actual, closeSession: vi.fn(async () => {}) };
});
const { closeSession } = await import("../diagnose/snapshot.ts");
const { createRunTeardown } = await import("./run-teardown.ts");

describe("createRunTeardown", () => {
  beforeEach(() => {
    vi.mocked(closeSession).mockClear();
  });

  test("run() flushes finalizers then reaps every tracked session", async () => {
    const teardown = createRunTeardown();
    const order: string[] = [];
    teardown.onFinalize(() => {
      order.push("finalize");
    });
    teardown.trackSession("s1");
    teardown.trackSession("s2");

    await teardown.run();

    expect(order).toEqual(["finalize"]);
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
  });

  test("an untracked session is not reaped", async () => {
    const teardown = createRunTeardown();
    teardown.trackSession("s1");
    teardown.untrackSession("s1");

    await teardown.run();

    expect(closeSession).not.toHaveBeenCalled();
  });

  test("a throwing finalizer does not skip the remaining finalizers or the reap", async () => {
    const teardown = createRunTeardown();
    const ran: string[] = [];
    teardown.onFinalize(() => {
      throw new Error("flush failed");
    });
    teardown.onFinalize(() => {
      ran.push("second");
    });
    teardown.trackSession("s1");

    await expect(teardown.run()).resolves.toBeUndefined();

    expect(ran).toEqual(["second"]);
    expect(closeSession).toHaveBeenCalledWith("s1");
  });

  test("run() is idempotent — a second call does nothing (double Ctrl-C guard)", async () => {
    const teardown = createRunTeardown();
    const finalize = vi.fn();
    teardown.onFinalize(finalize);
    teardown.trackSession("s1");

    await teardown.run();
    await teardown.run();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
