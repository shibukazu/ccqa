import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolves the absolute path to the bundled vitest config that `ccqa run`
// hands to vitest via --config. Emitted as .mjs by tsdown, so production
// builds find dist/runtime/vitest.config.mjs directly. Dev mode (running
// the CLI from source via `node --experimental-strip-types ./bin/ccqa.ts`)
// has no .mjs next to the .ts source, so we probe .mjs first and fall
// back to .ts when running from source.
export function bundledVitestConfigPath(): string {
  const mjsPath = fileURLToPath(
    new URL("./vitest.config.mjs", import.meta.url),
  );
  try {
    accessSync(mjsPath);
    return mjsPath;
  } catch {
    return fileURLToPath(new URL("./vitest.config.ts", import.meta.url));
  }
}
