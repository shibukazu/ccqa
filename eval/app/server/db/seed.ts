import { hashPassword } from "../lib/passwords";
import type { DB } from "./index";

export const SEED_USER = {
  email: "user@example.com",
  password: "password123",
  displayName: "Demo User",
};

/**
 * Give a fresh database something to look at: one account, two projects,
 * a handful of tasks. Skipped entirely once a user exists, so restarts
 * never duplicate data.
 */
export function seedIfEmpty(db: DB): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (count.n > 0) return;

  const insertUser = db.prepare(
    "INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)",
  );
  const insertProject = db.prepare("INSERT INTO projects (name) VALUES (?)");
  const insertTask = db.prepare(
    "INSERT INTO tasks (project_id, title, done) VALUES (?, ?, ?)",
  );

  db.transaction(() => {
    insertUser.run(SEED_USER.email, hashPassword(SEED_USER.password), SEED_USER.displayName);

    const redesign = Number(insertProject.run("Website redesign").lastInsertRowid);
    insertTask.run(redesign, "Draft the new homepage copy", 1);
    insertTask.run(redesign, "Collect homepage feedback", 0);
    insertTask.run(redesign, "Update the pricing page", 0);

    const onboarding = Number(insertProject.run("Team onboarding").lastInsertRowid);
    insertTask.run(onboarding, "Write the setup guide", 0);
    insertTask.run(onboarding, "Record a walkthrough video", 0);
  })();
}
