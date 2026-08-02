# Task app

A small task-list app: sign in, see your tasks, add one, mark one done,
filter the list. No build step:

```sh
node server.mjs
```

`server.mjs` serves the static UI from `public/` and a JSON API. State lives
in memory and resets on restart. Browser test cases for the main flows live
under `.ccqa/`.
