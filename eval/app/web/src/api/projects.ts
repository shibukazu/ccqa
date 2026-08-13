import type { ProjectCreateInput } from "../../../shared/projects";
import type { Project } from "../../../shared/types";
import { request } from "./http";

export async function listProjects(): Promise<Project[]> {
  const { projects } = await request<{ projects: Project[] }>("/api/projects");
  return projects;
}

export async function createProject(input: ProjectCreateInput): Promise<Project> {
  const { project } = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return project;
}

export async function getProject(id: number): Promise<Project> {
  const { project } = await request<{ project: Project }>(`/api/projects/${id}`);
  return project;
}
