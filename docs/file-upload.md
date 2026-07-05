# File uploads

`<input type="file">` triggers the OS file-picker dialog when clicked, and the
dialog is not part of the page DOM — neither agent-browser nor any
Playwright-style automation can drive it directly. ccqa handles this the same
way Playwright does: set the input's files via the browser API rather than
clicking the input.

The plumbing is built in. You write the upload step in plain English in your
spec.yaml; `ccqa record` records it as a structured `upload` action and
`ccqa generate` emits `abUpload(...)` into `test.spec.ts`.

## Fixture layout

Put test files under `.ccqa/fixtures/` and reference them through the
`CCQA_FIXTURES_DIR` environment variable. Setting one env var keeps spec
strings the same on every machine: dev laptops, CI, and a reviewer
re-running a failure locally all resolve fixtures to the same place.

```
.ccqa/
  fixtures/
    sample.pdf
    profile-avatar.png
  features/
    profile/
      test-cases/
        upload-avatar/
          spec.yaml
```

Set the env var alongside your other ccqa env vars (a `.env` file, your
shell rc, or the CI secrets store):

```bash
export CCQA_FIXTURES_DIR="$(pwd)/.ccqa/fixtures"
```

## Spec example

```yaml
# .ccqa/features/profile/test-cases/upload-avatar/spec.yaml
title: Upload a profile avatar
mode: deterministic

steps:
  - instruction: |
      Open ${APP_URL}/profile/settings. Fill in email / password and sign in.
    expected: Settings page loaded; the "Avatar" file input is visible.

  - instruction: |
      Upload ${CCQA_FIXTURES_DIR}/profile-avatar.png via the avatar file
      input (the input has aria-label "Profile avatar").
    expected: The uploaded image preview appears next to the file input.

  - instruction: Click "Save".
    expected: Toast shows "Profile updated"; reloading keeps the new avatar.
```

The phrasing tells Claude *which* element is the file input (by aria-label,
test id, or a state-independent attribute) and *which* fixture to attach.
Claude will use `agent-browser upload "<selector>" "<path>"` rather than
clicking the input.

## Multi-file inputs

`<input type="file" multiple>` accepts more than one file. Write the step
with several paths separated by spaces — Claude records one `upload` action
with all of them:

```yaml
- instruction: |
    Upload ${CCQA_FIXTURES_DIR}/page-1.pdf and
    ${CCQA_FIXTURES_DIR}/page-2.pdf via the "Attach files" input.
  expected: Both file names appear in the attachment list.
```

This generates a single `abUpload("[aria-label='Attach files']", "…/page-1.pdf", "…/page-2.pdf")`
call.

## What the generated test looks like

```typescript
import { abUpload, abAssertTextVisible } from "ccqa/test-helpers";

abUpload(
  "[aria-label='Profile avatar']",
  `${process.env.CCQA_FIXTURES_DIR ?? ""}/profile-avatar.png`,
);
abAssertTextVisible("Profile updated");
```

`abUpload` resolves each path against the test's current working directory,
verifies the file exists on disk, and only then hands the paths to
`agent-browser upload`. A missing fixture surfaces as a clear ccqa error
instead of an opaque `agent-browser` exit code.

## Things to avoid

- **Do not `click` the file input.** That opens the OS picker, which
  agent-browser cannot drive. Use `upload` instead. The trace prompt is
  written to remind Claude of this, but the same rule applies if you ever
  hand-edit a spec.
- **Do not bake absolute paths into specs.** A spec that says
  `/Users/alice/Downloads/sample.pdf` will not work in CI. Use
  `${CCQA_FIXTURES_DIR}` (or another env var) so the resolution stays
  portable.
- **Live (`mode: live`) specs use the same convention.** Claude is told to
  use `agent-browser upload` and to reach for `${CCQA_FIXTURES_DIR}` in the
  run-nd system prompt.
