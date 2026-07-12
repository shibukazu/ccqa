# E2E test guidelines (fixture)

- Always drive screens through the page objects under `e2e/pages/`.
- Reuse the step helpers under `e2e/steps/` for multi-screen flows.
- Import shared fixtures and constants from `@example/e2e-kit` — never
  redefine them locally.
