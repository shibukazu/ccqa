# veriq

**Your Claude subscription already includes a QA engineer.**

veriq turns Claude Code into a browser test recorder. Write a spec in Markdown, run `veriq trace`, and Claude drives your app via [agent-browser](https://github.com/vercel-labs/agent-browser) — a lightweight headless browser CLI that runs anywhere without a browser driver or Playwright setup. Because the agent controls the browser through a simple CLI interface, it can handle login flows, intermediate screens, and dynamic UI the same way a human would. Every action is recorded as structured data and compiled into a deterministic test script you can run in CI. No extra API key. Just `claude`.

## How it works

```mermaid
flowchart LR
    A["Write spec\n(test-spec.md)"] --> B["veriq trace\n(Claude drives browser)"]
    B --> C["veriq generate\n(LLM → test script)"]
    C --> D["veriq run\n(deterministic replay)"]
```

`trace` has Claude execute your spec via [agent-browser](https://github.com/vercel-labs/agent-browser) — a Rust-based headless browser CLI from Vercel Labs. No Playwright, no browser driver setup; it runs anywhere `agent-browser` is installed. Every click, fill, and assertion is recorded as structured data. `generate` compiles that data into a vitest-compatible script. `run` replays it deterministically — no LLM involved.

## Install

```bash
bunx veriq trace tasks/create-and-complete
```

Or install globally:

```bash
bun add -g veriq
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [agent-browser](https://github.com/vercel-labs/agent-browser) installed globally:

```bash
npm install -g @anthropic-ai/claude-code
bun add -g agent-browser
```

## Usage

**1. Write a spec**

```markdown
<!-- .veriq/features/tasks/test-cases/create-and-complete/test-spec.md -->
---
title: Create a task and mark it complete
baseUrl: http://localhost:3000
prerequisites: A user account exists with email user@example.com / password secret
---

## Steps

### step-01: Log in
- instruction: Fill in email and password, submit the form
- expected: Redirected to /dashboard, user avatar visible in the header

### step-02: Create a new task
- instruction: Click "New Task", fill in the title "Fix login bug", set priority to High, save
- expected: Task appears in the task list with status "Open"

### step-03: Mark the task as complete
- instruction: Open the task "Fix login bug", click "Mark as complete"
- expected: Task status changes to "Done", task moves to the completed section
```

**2. Trace — Claude drives the browser and records every action**

```bash
veriq trace tasks/create-and-complete
```

```
▶ trace  tasks/create-and-complete
  spec    Create a task and mark it complete
  url     http://localhost:3000
  steps   3

Running agent-browser session...
  ● step-01  Log in
  ● step-02  Create a new task
  ● step-03  Mark the task as complete

  trace   .veriq/features/tasks/test-cases/create-and-complete/actions.json
  actions 24
  status  PASSED
```

**3. Generate — convert recorded actions into a replayable test**

```bash
veriq generate tasks/create-and-complete
```

```
▶ generate  tasks/create-and-complete
  trace     .veriq/features/tasks/test-cases/create-and-complete/actions.json
  actions   24
  cleaned   18

  saved     .veriq/features/tasks/test-cases/create-and-complete/test.spec.ts
```

**4. Run — replay deterministically, no LLM involved**

```bash
veriq run tasks/create-and-complete
```

## What gets generated

`ab()` is a thin wrapper around [agent-browser](https://github.com/vercel-labs/agent-browser) — a headless browser CLI. Each call spawns `agent-browser <command>` as a subprocess and throws if it exits non-zero. No browser driver setup, no async/await, no `.waitFor()`.

```typescript
// .veriq/features/tasks/test-cases/create-and-complete/test.spec.ts
import { test } from "vitest";
import { ab, abWait, abAssertUrl, abAssertTextVisible, abAssertEnabled } from "/path/to/test-helpers.ts";

test("full flow", () => {
  ab("cookies", "clear");
  ab("open", "http://localhost:3000");

  // step-01: Log in
  ab("fill", "[placeholder='Email']", "user@example.com"); // → agent-browser fill ...
  ab("fill", "[type='password']", "secret");
  ab("press", "Enter");
  abAssertUrl("/dashboard");                               // → agent-browser get url
  abAssertTextVisible("Welcome back");                     // → agent-browser wait --text ...

  // step-02: Create a new task
  ab("click", "[aria-label='New Task']");
  ab("fill", "[placeholder='Task title']", "Fix login bug");
  ab("select", "[aria-label='Priority']", "High");
  ab("click", "[aria-label='Save']");
  abAssertTextVisible("Fix login bug");
  abAssertTextVisible("Open");

  // step-03: Mark the task as complete
  ab("click", "text=Fix login bug");
  ab("click", "[aria-label='Mark as complete']");
  abAssertTextVisible("Done");
  abAssertEnabled("[aria-label='Reopen task']");
}, 5 * 60 * 1000);
```

agent-browser handles all the timing; the test script is just a list of sequential calls.

## Assertions

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

## Auto-fix

If the generated script fails (timing issues, page not ready), `generate` automatically inserts `sleep` before the failing line and retries. Control how many attempts with `--max-retries`:

```bash
veriq generate auth/login --max-retries 5
```

## Commands

```
veriq trace <feature/spec>     Run agent-browser and record actions
veriq generate <feature/spec>  Generate test script from recorded actions
veriq run [feature/spec]       Execute generated test scripts
```

## Why not write Playwright tests by hand?

| | veriq | Hand-written Playwright |
|---|---|---|
| Write selectors | Claude picks them from ARIA snapshots | You inspect the DOM |
| Handle timing | Recorded wait commands, auto-fix sleep | `waitFor`, `expect().toBeVisible()` |
| Assertions | Auto-generated from verified signals | Written manually |
| Update after UI change | Re-run `trace` | Find and update every affected locator |
| Runs in CI | Yes (deterministic replay, no LLM) | Yes |

## License

MIT
