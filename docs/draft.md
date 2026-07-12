# Draft — co-author spec.yaml with Claude

Writing a `spec.yaml` from scratch means digging into your codebase to find the right aria-labels, URLs, and button text. `ccqa draft` puts Claude in the loop: you describe what you want to test in plain language, Claude reads the relevant code, and you refine the spec interactively.

```bash
ccqa draft
```

The first run asks for your intent, proposes a `feature/spec` name, and writes a draft. Each subsequent invocation lets you give a refinement instruction — empty input means "just re-check the current spec against the code." Press `y` at the final "Are you done with this draft?" prompt to end the session.

```
ccqa draft

What do you want to test? > Create a new task and mark it complete
Proposing a feature/spec name based on your intent...
  proposed: tasks/create-and-complete
Use this name? [y/N/edit] > y

Reading codebase and drafting spec...
  ✓ 5 Read, 3 Grep, 2 Glob  (4.2s)

── Review  (1 warning, 3 passed) ───────────────────────────────────

  WARNINGS (1)
    Assertability  step-05
      Status may still show "pending" right after the click
      └ TaskRow.tsx polls every 5s; the status flips later.

  PASSED (3)
    Block references, Step granularity, Unimplemented checks

────────────────────────────────────────────────────────────────────

--- proposed changes ---
+ title: Create a task and mark it complete
+ steps:
+ ...

Apply this patch? [y/N] y
  saved: .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml

How would you like to refine? (empty = re-validate) >
```

You can also edit `spec.yaml` directly in your editor between turns — `ccqa draft` re-reads the file each iteration.

## What gets reviewed

Every turn Claude grades the spec on four axes and reports issues:

| Check | What it verifies |
|---|---|
| **Assertability** | Each step's `expected` references concrete, observable signals (visible text, URL pattern, element state) that actually exist in the code. Flags timestamps, exact counts, and session-specific values that won't be stable across runs. |
| **Block references** | Every `include` step resolves to an existing block under `.ccqa/blocks/<name>/spec.yaml`, every `params` key matches a declared param of that block, and every required param is provided. See [Blocks](./spec.md#blocks--reusable-step-templates). |
| **Step granularity** | Steps aren't too coarse (multiple actions in one) or too fine (snapshot-only filler), and the order is logical. |
| **Unimplemented checks** | Anything the spec describes that Claude couldn't find in the codebase — a hint that you may be specifying behavior that doesn't exist yet. |

Findings with severity `WARN` or `ERROR` are shown in full; `OK` checks collapse to a one-line summary.

## Flags

```
ccqa draft [feature/spec]               # arg is optional; Claude proposes a name if omitted
  --instruction <text>                  # single-shot, non-interactive
  --apply                               # auto-apply patches without [y/N] confirmation
```
