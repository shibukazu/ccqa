import { closeSession } from "../diagnose/snapshot.ts";
import * as log from "./logger.ts";

/**
 * Tracks resources a `ccqa run` acquires so a SIGINT/SIGTERM (or the normal
 * end of the run) can release them deterministically. Node bypasses
 * `try/finally` on an unhandled signal, so the run command installs a handler
 * that calls {@link RunTeardown.run} before exiting.
 *
 * Phase C-1 tracks live agent-browser sessions (the orphan-leak fix). The
 * registry is intentionally a small mutable object rather than module state so
 * a single run owns exactly one instance and tests can drive it directly.
 * Later phases attach a report-finalize callback via {@link onFinalize} so an
 * interrupt also flushes the incremental report.
 */
export interface RunTeardown {
  /** Register a live agent-browser session name to reap on teardown. */
  trackSession(name: string): void;
  /** Deregister a session that already closed cleanly (best-effort). */
  untrackSession(name: string): void;
  /**
   * Close a tracked session now (best-effort) and stop tracking it. Close
   * first, then untrack — reversed, a signal between the two would skip the
   * close and the teardown would no longer know the session existed.
   */
  closeTracked(name: string): Promise<void>;
  /** Register a callback run once during teardown (e.g. flush the report). */
  onFinalize(fn: () => void | Promise<void>): void;
  /**
   * Run every finalize callback, then reap every tracked session. Runs once;
   * a later caller awaits the first run rather than returning early — both the
   * signal handler and the command's own `finally` land here, and the one that
   * returned early would `process.exit` through the other's flush.
   */
  run(): Promise<void>;
}

export function createRunTeardown(): RunTeardown {
  const sessions = new Set<string>();
  const finalizers: (() => void | Promise<void>)[] = [];
  let running: Promise<void> | null = null;

  const tearDown = async (): Promise<void> => {
    // Finalizers first (flush the report) so results are durable before we
    // spend time reaping browsers. Each is best-effort: one failing must not
    // skip the rest or the session reap.
    for (const fn of finalizers) {
      try {
        await fn();
      } catch (err) {
        // Can't recover on exit, but a finalizer failing here means the
        // interrupt-time report flush (the whole point of teardown) may have
        // been lost — say so rather than exiting silently.
        log.warn(`teardown finalizer failed (partial report may be incomplete): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // closeSession is itself best-effort and never throws.
    await Promise.all([...sessions].map((name) => closeSession(name)));
    sessions.clear();
  };

  return {
    trackSession(name) {
      sessions.add(name);
    },
    untrackSession(name) {
      sessions.delete(name);
    },
    async closeTracked(name) {
      await closeSession(name);
      sessions.delete(name);
    },
    onFinalize(fn) {
      finalizers.push(fn);
    },
    run() {
      running ??= tearDown();
      return running;
    },
  };
}

/**
 * Install SIGINT/SIGTERM handlers that run {@link RunTeardown.run} then exit
 * with the conventional signal code, and return a disposer that removes them.
 * A command must install at most one: a second handler that also exits would
 * race this one and could terminate mid-finalizer. A second signal while
 * tearing down hard-exits immediately rather than waiting.
 *
 * `onSignal` runs synchronously before the teardown starts, so a finalizer
 * can already see which signal is ending the process (e.g. `ccqa record`
 * seals its hub run with a "terminated by signal" note).
 */
export function installTeardownSignalHandlers(
  teardown: RunTeardown,
  onSignal?: (sig: "SIGINT" | "SIGTERM") => void,
): () => void {
  let handling = false;
  const handler = (sig: "SIGINT" | "SIGTERM") => {
    const code = sig === "SIGINT" ? 130 : 143;
    if (handling) {
      process.exit(code);
      return;
    }
    handling = true;
    onSignal?.(sig);
    void teardown.run().finally(() => process.exit(code));
  };
  const onInt = () => handler("SIGINT");
  const onTerm = () => handler("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}
