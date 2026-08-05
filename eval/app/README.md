# Taskboard

A small team task tracker: sign in, browse projects, add tasks, tick them
off, keep notes, tweak your settings.

## Running it

```sh
pnpm install
pnpm dev
```

The app comes up on <http://localhost:5173> (override with `PORT`). One
process serves everything: Express hosts the API and hands the rest to Vite
in middleware mode, so the React frontend hot-reloads in the same process.

On first boot the server creates its SQLite database under `data/`, applies
the migrations in `server/db/migrations/`, and seeds a demo account with a
couple of projects:

- **Email**: `user@example.com`
- **Password**: `password123`

Delete `data/` to start over from the seed.

## Layout

- `server/` — Express app: `routes/` per resource, `middleware/auth.ts` for
  the session check, `db/` for the SQLite handle, migrations, and typed
  queries.
- `web/` — Vite + React frontend: `src/pages/` per route, `src/components/`
  for shared pieces, `src/api/` as the typed client for the server routes.
- `shared/` — zod schemas and API types imported by both sides, so the
  server and the forms validate with the same rules.

Browser test cases for the main flows live under `.ccqa/`.
