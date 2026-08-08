import { Router } from "express";
import { ProjectCreateSchema } from "../../shared/projects";
import type { DB } from "../db/index";
import { createProject, getProject, listProjects } from "../db/queries/projects";
import { parseId } from "../lib/ids";
import { requireAuth } from "../middleware/auth";

export function projectsRouter(db: DB): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", (_req, res) => {
    res.json({ projects: listProjects(db) });
  });

  router.post("/", (req, res) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Project name is required" });
      return;
    }
    res.status(201).json({ project: createProject(db, parsed.data.name) });
  });

  router.get("/:id", (req, res) => {
    const id = parseId(req.params.id);
    const project = id === undefined ? undefined : getProject(db, id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ project });
  });

  return router;
}
