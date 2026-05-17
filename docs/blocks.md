# Blocks — reusable step templates

A **block** is a named sequence of step *declarations* (`instruction` / `expected` pairs) that any spec can pull in via `include`. Use blocks to share login flows, common setup, or any sequence you repeat across specs.

In v0.4 a block is a pure **spec template**. There is no per-block recording or test artifact — when a spec includes a block, the block's steps are inlined into the spec's own step list at trace time, and the spec drives the full run (block steps + spec steps) from scratch. This keeps each spec test self-contained and avoids the "the block recording was right for spec A but wrong for spec B" failure mode.

## 1. Write a block

```yaml
# .ccqa/blocks/login/spec.yaml
title: ID provider login
params:
  - name: loginUrl
    required: true
  - name: email
    required: true
  - name: password
    required: true
    secret: true

steps:
  - instruction: open ${loginUrl}
    expected: email input is visible

  - instruction: |
      Fill [placeholder='email'] with ${email}.
      Fill [type='password'] with ${password}.
      Click the login button.
    expected: redirected to the post-login page
```

**Rules:**

- A block's `steps` must be action steps only — nested blocks (`include` inside a block) are not supported.
- `params` are string-typed. Reference them in step strings with `${name}`.
- `required` defaults to `true`. Use `required: false` to make a param optional.
- `secret: true` flags a value as sensitive. The codegen step renders it as a `process.env.<NAME>` template literal so the value never lands in `test.spec.ts`.

## 2. Use the block from a spec

```yaml
# .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml
title: Create a task and mark it complete
relatedPaths:
  - src/features/tasks/**

steps:
  - include: login
    params:
      loginUrl: ${APP_LOGIN_URL}
      email: ${APP_EMAIL}
      password: ${APP_PASSWORD}

  - instruction: open ${APP_URL}/tasks
    expected: task list is visible
```

The block's `${paramName}` references are substituted with the values the include site provided (so the Claude trace prompt sees `open ${APP_LOGIN_URL}` for the first step, `Fill [type='password'] with ${APP_PASSWORD}` for the second). Unresolved refs flow through unchanged so the test-time `process.env` lookup can fill them in.

## 3. Trace and generate the spec

```bash
ccqa trace tasks/create-and-complete       # records actions for ALL steps (login + spec)
ccqa generate tasks/create-and-complete    # emits a single test.spec.ts for the spec
```

The generated test is one flat function — block content is inlined and tagged with `// step: step-XX [<block name>]` so you can still see which step came from which block:

```ts
import { ab, ... } from "ccqa/test-helpers";

test("Create a task and mark it complete", () => {
  // step: step-01 [login]
  ab("open", `${process.env.APP_LOGIN_URL ?? ""}`);
  ab("fill", "[placeholder='email']", `${process.env.APP_EMAIL ?? ""}`);
  ab("fill", "[type='password']", `${process.env.APP_PASSWORD ?? ""}`);
  ab("click", "[aria-label='Login']");

  // step: step-02 [spec]
  ab("open", `${process.env.APP_URL ?? ""}/tasks`);
  // ...
});
```

## Editing a block

1. Update `.ccqa/blocks/<name>/spec.yaml`.
2. Re-run `ccqa trace <feature>/<spec> && ccqa generate <feature>/<spec>` for every spec that includes the block.

The trade-off vs the recorded-block model is explicit: a block change costs N traces (one per including spec) instead of 1, but each trace runs end-to-end so a block step that was always going to fail under spec B is caught immediately, not at spec B's runtime.

## Migration note (from earlier v0.4 builds)

Earlier v0.4 builds wrote one of two artifacts under each block dir:

- `.ccqa/blocks/<name>/test.spec.ts` — function-export form
- `.ccqa/blocks/<name>/actions.json` and/or `route.md` — recorded form

Both are now dead. `ccqa trace` and `ccqa generate` emit a hint when they detect any of them; delete them manually. The `ccqa trace-block` and `ccqa generate-block` commands have been removed.
