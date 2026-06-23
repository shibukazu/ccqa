import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// User override config: touches a sentinel file at the path supplied via
// CCQA_TEST_SENTINEL. The test asserts the file exists after `ccqa run`,
// which proves this config was used instead of the bundled one.
//
// Plain object export (no defineConfig) avoids pulling vitest/config through
// the loader when the fixture's symlinked node_modules resolves CJS/ESM
// in an order that triggers ERR_REQUIRE_ESM on std-env.
export default {
  test: {
    environment: "node",
    globalSetup: [resolve(__dirname, "global-setup.ts")],
  },
};
