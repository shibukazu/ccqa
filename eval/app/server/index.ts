import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import { openDatabase, runMigrations } from "./db/index";
import { seedIfEmpty } from "./db/seed";
import { authRouter } from "./routes/auth";
import { projectsRouter } from "./routes/projects";
import { settingsRouter } from "./routes/settings";
import { tasksRouter } from "./routes/tasks";
import { attachFrontend } from "./vite";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const db = openDatabase(path.join(here, "..", "data", "app.db"));
  runMigrations(db, path.join(here, "db", "migrations"));
  seedIfEmpty(db);

  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: "taskboard.sid",
      secret: process.env.SESSION_SECRET ?? "dev-only-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    }),
  );

  app.use("/api/auth", authRouter(db));
  app.use("/api/projects", projectsRouter(db));
  app.use("/api/tasks", tasksRouter(db));
  app.use("/api/settings", settingsRouter(db));

  await attachFrontend(app);

  const port = Number(process.env.PORT ?? 5173);
  app.listen(port, () => {
    console.log(`taskboard listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
