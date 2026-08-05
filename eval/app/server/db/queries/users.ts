import type { SessionUser, UserSettings } from "../../../shared/types";
import type { DB } from "../index";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  display_name: string;
  email_updates: number;
}

const COLUMNS = "id, email, password_hash, display_name, email_updates";

export function findUserByEmail(db: DB, email: string): UserRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`).get(email) as
    | UserRow
    | undefined;
}

export function findUserById(db: DB, id: number): UserRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function updateUserSettings(db: DB, id: number, settings: UserSettings): void {
  db.prepare("UPDATE users SET display_name = ?, email_updates = ? WHERE id = ?").run(
    settings.displayName,
    settings.emailUpdates ? 1 : 0,
    id,
  );
}

export function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export function toUserSettings(row: UserRow): UserSettings {
  return { displayName: row.display_name, emailUpdates: row.email_updates === 1 };
}
