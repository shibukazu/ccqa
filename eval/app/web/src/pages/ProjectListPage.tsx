import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ProjectCreateSchema } from "../../../shared/projects";
import type { Project } from "../../../shared/types";
import { createProject, listProjects } from "../api/projects";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";

export function ProjectListPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = ProjectCreateSchema.safeParse({ name });
    if (!parsed.success) {
      setError("Project name is required");
      return;
    }
    const project = await createProject(parsed.data);
    setProjects((current) =>
      [...current, project].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setName("");
    setError(null);
    setCreating(false);
  };

  return (
    <section>
      <h1>Projects</h1>
      <p className="page-subtitle">Everything your team is tracking.</p>
      <ul className="project-list">
        {projects.map((project) => (
          <li key={project.id}>
            <Link to={`/projects/${project.id}`}>{project.name}</Link>
            <span className="project-list__meta">
              {project.openCount} open · {project.doneCount} done
            </span>
          </li>
        ))}
      </ul>
      {creating ? (
        <form onSubmit={handleCreate}>
          <TextField
            id="project-name"
            label="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error ?? undefined}
            autoFocus
          />
          <Button type="submit">Create project</Button>
        </form>
      ) : (
        <Button onClick={() => setCreating(true)}>New project</Button>
      )}
    </section>
  );
}
