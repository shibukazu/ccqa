# Assertions

During `trace`, Claude verifies each step with at least two independent signals and emits structured assertions. These become typed helper calls in the generated script:

| Assert | What it checks |
|--------|---------------|
| `abAssertTextVisible(text)` | Text appears on page (waits up to 30s) |
| `abAssertUrl(pattern)` | Current URL contains pattern |
| `abAssertEnabled(selector)` | Button/input is enabled |
| `abAssertDisabled(selector)` | Button/input is disabled |
| `abAssertVisible(selector)` | Element is visible |
| `abAssertNotVisible(selector)` | Element is hidden |
| `abAssertChecked(selector)` | Checkbox is checked |
| `abAssertUnchecked(selector)` | Checkbox is unchecked |

Assertions are stability-aware: Claude skips timestamps, session IDs, and exact counts that vary between runs.

## What gets generated

`ab()` is a thin wrapper around [agent-browser](https://github.com/vercel-labs/agent-browser) — a headless browser CLI. Each call spawns `agent-browser <command>` as a subprocess and throws if it exits non-zero. No browser driver setup, no async/await, no `.waitFor()`.

```typescript
// .ccqa/features/tasks/test-cases/create-and-complete/test.spec.ts
import { test } from "vitest";
import { ab, abWait, abAssertUrl, abAssertTextVisible, abAssertEnabled } from "ccqa/test-helpers";

process.env.AGENT_BROWSER_SESSION = `ccqa-run-${Date.now()}`;

test("setup: login", () => {
  ab("cookies", "clear");
  ab("open", "http://localhost:3000/login");
  ab("fill", "[placeholder='Email']", "admin@example.com");
  ab("fill", "[type='password']", "AdminPass123");
  ab("press", "Enter");
}, 3 * 60 * 1000);

test("Create a task", () => {
  ab("open", "http://localhost:3000");

  // Create a new task
  ab("click", "[aria-label='New Task']");
  ab("fill", "[placeholder='Task title']", "Fix login bug");
  ab("select", "[aria-label='Priority']", "High");
  ab("click", "[aria-label='Save']");
  abAssertTextVisible("Fix login bug");
  abAssertTextVisible("Open");
}, 5 * 60 * 1000);
```

Setup and test share the same `AGENT_BROWSER_SESSION` — login state carries over. Each run starts with `cookies clear` to ensure a clean session.
