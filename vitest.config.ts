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
    // Cap fork parallelism: E2E scenarios each spawn a `ccqa` child process
    // (and some, live-mode/hub runs, spawn vitest + agent-browser under
    // that), so a full-core worker count oversubscribes CPU/FDs and causes
    // spurious timeouts. Half the cores keeps the suite fast without the
    // contention flakes.
    maxWorkers: "50%",
  },
});
