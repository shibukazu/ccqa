import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolves the absolute path to the bundled vitest config `ccqa run` hands
// to vitest via --config.
//
// Path shape differs by execution mode:
//   * Dev (source): import.meta.url = .../src/runtime/bundled-config.ts
//     → ./vitest.config.ts sits next to this module.
//   * Built: bin/ccqa.ts is bundled into a single dist/bin/ccqa.mjs, so
//     import.meta.url = .../dist/bin/ccqa.mjs regardless of which source
//     module you "conceptually" came from. The vitest config is a separate
//     emitted entry at dist/runtime/vitest.config.mjs, i.e. one level up
//     and into runtime/.
//
// We probe the built location first and fall back to the source location
// when dev-running from .ts.
const CANDIDATES = [
  "../runtime/vitest.config.mjs", // bundled: dist/bin/ -> dist/runtime/
  "./vitest.config.mjs",          // emitted next to this module (defensive)
  "./vitest.config.ts",           // dev: src/runtime/
] as const;

export function bundledVitestConfigPath(): string {
  for (const rel of CANDIDATES) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  // Nothing found — return the dev path so the eventual vitest error points
  // at a real source file instead of a phantom .mjs.
  return fileURLToPath(new URL("./vitest.config.ts", import.meta.url));
}
