import type { Project } from "../../../shared/types";
import type { DB } from "../index";

interface ProjectRow {
  id: number;
  name: string;
  open_count: number;
  done_count: number;
}

const SELECT_WITH_COUNTS = `
  SELECT
    p.id,
    p.name,
    COALESCE(SUM(CASE WHEN t.done = 0 THEN 1 ELSE 0 END), 0) AS open_count,
    COALESCE(SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END), 0) AS done_count
  FROM projects p
  LEFT JOIN tasks t ON t.project_id = p.id
`;

export function listProjects(db: DB): Project[] {
  const rows = db
    .prepare(`${SELECT_WITH_COUNTS} GROUP BY p.id ORDER BY p.name`)
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(db: DB, id: number): Project | undefined {
  const row = db.prepare(`${SELECT_WITH_COUNTS} WHERE p.id = ? GROUP BY p.id`).get(id) as
    | ProjectRow
    | undefined;
  return row ? toProject(row) : undefined;
}

export function createProject(db: DB, name: string): Project {
  const result = db.prepare("INSERT INTO projects (name) VALUES (?)").run(name);
  return { id: Number(result.lastInsertRowid), name, openCount: 0, doneCount: 0 };
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, openCount: row.open_count, doneCount: row.done_count };
}
