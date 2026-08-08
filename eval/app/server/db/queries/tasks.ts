import type { TaskUpdateInput } from "../../../shared/tasks";
import type { Task } from "../../../shared/types";
import type { DB } from "../index";

interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  notes: string;
  done: number;
  created_at: string;
}

const COLUMNS = "id, project_id, title, notes, done, created_at";

export function listTasksByProject(db: DB, projectId: number): Task[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM tasks WHERE project_id = ? ORDER BY created_at, id`)
    .all(projectId) as TaskRow[];
  return rows.map(toTask);
}

export function getTask(db: DB, id: number): Task | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined;
  return row ? toTask(row) : undefined;
}

export function createTask(db: DB, projectId: number, title: string, notes = ""): Task {
  const result = db
    .prepare("INSERT INTO tasks (project_id, title, notes) VALUES (?, ?, ?)")
    .run(projectId, title, notes);
  const created = getTask(db, Number(result.lastInsertRowid));
  if (!created) throw new Error("task vanished after insert");
  return created;
}

export function updateTask(db: DB, id: number, patch: TaskUpdateInput): Task | undefined {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    values.push(patch.notes);
  }
  if (patch.done !== undefined) {
    sets.push("done = ?");
    values.push(patch.done ? 1 : 0);
  }
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return getTask(db, id);
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    notes: row.notes,
    done: row.done === 1,
    createdAt: row.created_at,
  };
}
