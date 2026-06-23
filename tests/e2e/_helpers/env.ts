// Environment composition helpers for E2E tests.

// Strips ANSI color escape sequences so assertions against stdout/stderr can
// use plain string matching.
export function stripAnsi(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g,
    "",
  );
}

// Common env tweaks we want on every E2E invocation. Callers merge these
// into runCcqa(opts.env).
export function noColorEnv(): Record<string, string> {
  return {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
  };
}
