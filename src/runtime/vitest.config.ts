import { defineConfig } from "vitest/config";

// Default vitest config used by `ccqa run`. Passed via `--config` so the host
// project's vitest.config.ts is not picked up. ccqa specs are Node-side E2E
// tests driving agent-browser; host configs (setupFiles, jsdom/happy-dom
// environment, @ aliases, etc.) don't apply and often break the run.
//
// Consumers can override by placing .ccqa/vitest.config.ts in their project;
// `ccqa run` prefers that file when present.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
  },
});
