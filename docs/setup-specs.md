# Setup Specs — Reusable shared procedures

Setup specs let you define reusable procedures (login, data preparation, etc.) that run before your test steps. Define once, use across multiple test specs.

## 1. Write a setup spec

```markdown
<!-- .ccqa/setups/login/setup-spec.md -->
---
title: "Login"
placeholders:
  loginUrl:
    dummy: "http://localhost:3000/login"
    description: "Login page URL"
  email:
    dummy: "user@example.com"
    description: "Email address"
  password:
    dummy: "secret"
    description: "Password"
---

## Steps

### Step 1: Open login page
- **Instruction**: Navigate to {{loginUrl}}
- **Expected**: Login form is displayed

### Step 2: Enter credentials and log in
- **Instruction**: Enter email {{email}} and password {{password}}, then submit
- **Expected**: Login succeeds
```

The `placeholders` section defines variables with `dummy` values. During `trace-setup`, the dummy values are used for actual browser operation. During `generate-setup`, they are reverse-replaced with `{{key}}` placeholders.

## 2. Trace the setup

```bash
ccqa trace-setup login
```

## 3. Generate and validate the setup

```bash
ccqa generate-setup login
```

This generates `test.dummy.spec.ts` with dummy values, runs vitest to validate, and applies auto-fix. On success, it reverse-replaces dummy values with placeholders and saves `test.spec.ts`.

If auto-fix fails, edit `test.dummy.spec.ts` manually and re-run:

```bash
ccqa generate-setup login --from-dummy
```

## 4. Reference from test specs

```markdown
---
title: Create a task
baseUrl: http://localhost:3000
setups:
  - name: login
    params:
      loginUrl: "http://localhost:3000/login"
      email: "admin@example.com"
      password: "AdminPass123"
---

## Steps
### Step 1: Create a new task
...
```

When you run `ccqa trace` or `ccqa generate`, the setup's test body is loaded, placeholders are replaced with `params` values, and it runs before your test steps — sharing the same browser session.
