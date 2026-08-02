# Task app (eval target)

A deliberately small task-list app the ccqa evaluation harness audits. Sign
in, list tasks, add a task, complete a task, filter the list. No build step:

```sh
node server.mjs
```

The `.ccqa/` tree next to this file holds the specs the harness evaluates
against. Mutations in `eval/cases/` edit this app to seed known drift, so any
change here must keep the baseline consistent with those specs and with the
`search` strings the cases rely on.
