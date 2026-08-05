import { Router } from "express";
import { TaskCreateSchema, TaskUpdateSchema } from "../../shared/tasks";
import type { DB } from "../db/index";
import { getProject } from "../db/queries/projects";
import { createTask, getTask, listTasksByProject, updateTask } from "../db/queries/tasks";
import { requireAuth } from "../middleware/auth";

export function tasksRouter(db: DB): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", (req, res) => {
    const projectId = Number(req.query.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }
    res.json({ tasks: listTasksByProject(db, projectId) });
  });

  router.post("/", (req, res) => {
    const parsed = TaskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Task title is required" });
      return;
    }
    if (!getProject(db, parsed.data.projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const task = createTask(db, parsed.data.projectId, parsed.data.title, parsed.data.notes);
    res.status(201).json({ task });
  });

  router.get("/:id", (req, res) => {
    const task = getTask(db, Number(req.params.id));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ task });
  });

  router.patch("/:id", (req, res) => {
    const parsed = TaskUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Nothing valid to update" });
      return;
    }
    const task = updateTask(db, Number(req.params.id), parsed.data);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ task });
  });

  return router;
}
