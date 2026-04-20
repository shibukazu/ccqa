import { defineConfig } from "vitest/config";

// Project-root vitest config for this repo's own test suite (unit + E2E).
// NOTE: this is NOT the bundled runtime config (that one lives in
// src/runtime/vitest.config.ts and is passed to user-facing `ccqa run`
// via --config).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
