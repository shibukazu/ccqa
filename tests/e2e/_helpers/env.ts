// Environment composition helpers for E2E tests.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

// Forces ccqa's Claude-auth probe to fail so a `ccqa run` (which now always
// runs failure analysis) deterministically *skips* it instead of making a real
// Claude call: empty ANTHROPIC_API_KEY and a HOME without
// ~/.claude/.credentials.json. Pair with stubSecurityBinary on darwin dev
// machines so a real Keychain login can't leak in. The report is still written
// — only the analysis is skipped.
export function noAuthEnv(home: string): Record<string, string> {
  return { ...noColorEnv(), ANTHROPIC_API_KEY: "", HOME: home };
}

// Writes a `security` stub that always exits 1 into a dir, returned so callers
// can PATH-prepend it — this stops macOS Keychain from satisfying the auth
// probe during tests. No-op effect off darwin, but harmless to prepend.
export async function stubSecurityBinary(dir: string): Promise<string> {
  const binDir = join(dir, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, "security");
  await writeFile(stub, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(stub, 0o755);
  return binDir;
}
