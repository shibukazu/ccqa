# Draft — co-author test-spec.md with Claude

Writing a `test-spec.md` from scratch means digging into your codebase to find the right aria-labels, URLs, and button text. `ccqa draft` puts Claude in the loop: you describe what you want to test in plain language, Claude reads the relevant code, and you refine the spec interactively.

```bash
ccqa draft
```

The first run asks for your intent, proposes a `feature/spec` name, and writes a draft. Each subsequent invocation lets you give a refinement instruction — empty input means "just re-check the current spec against the code." Press `y` at the final "Are you done with this draft?" prompt to end the session.

```
ccqa draft

What do you want to test? > Select a category on the AI Maintenance page and run a check
Proposing a feature/spec name based on your intent...
  proposed: ai-maintenance/run-check-with-category
Use this name? [y/N/edit] > y

Reading codebase and drafting spec...
  ✓ 5 Read, 3 Grep, 2 Glob  (4.2s)

── Review  (1 warning, 3 passed) ───────────────────────────────────

  WARNINGS (1)
    Assertability  step-05
      Result row may still show "running" right after the click
      └ ContentQualityCheck.tsx polls every 5s; the status starts at
        IN_PROGRESS and only flips to SUCCEEDED later.

  PASSED (3)
    Setup references, Step granularity, Unimplemented checks

────────────────────────────────────────────────────────────────────

--- proposed changes ---
+ ---
+ title: "AI Maintenance — content quality check"
...

Apply this patch? [y/N] y
  saved: .ccqa/features/ai-maintenance/test-cases/run-check-with-category/test-spec.md

How would you like to refine? (empty = re-validate) >
```

You can also edit `test-spec.md` directly in your editor between turns — `ccqa draft` re-reads the file each iteration.

## What gets reviewed

Every turn Claude grades the spec on four axes and reports issues:

| Check | What it verifies |
|---|---|
| **Assertability** | Each step's **Expected** references concrete, observable signals (visible text, URL pattern, element state) that actually exist in the code. Flags timestamps, exact counts, and session-specific values that won't be stable across runs. |
| **Setup references** | Every `setups[].name` in the frontmatter resolves to an existing `.ccqa/setups/<name>/setup-spec.md`, and every `params` key matches that setup's `placeholders`. See [Setup Specs](./setup-specs.md). |
| **Step granularity** | Steps aren't too coarse (multiple actions in one) or too fine (snapshot-only filler), and the order is logical. |
| **Unimplemented checks** | Anything the spec describes that Claude couldn't find in the codebase — a hint that you may be specifying behavior that doesn't exist yet. |

Findings with severity `WARN` or `ERROR` are shown in full; `OK` checks collapse to a one-line summary.

## Flags

```
ccqa draft [feature/spec]               # arg is optional; Claude proposes a name if omitted
  --instruction <text>                  # single-shot, non-interactive
  --apply                               # auto-apply patches without [y/N] confirmation
```
