import type { TaskCreateInput, TaskUpdateInput } from "../../../shared/tasks";
import type { Task } from "../../../shared/types";
import { request } from "./http";

export async function listTasks(projectId: number): Promise<Task[]> {
  const { tasks } = await request<{ tasks: Task[] }>(`/api/tasks?projectId=${projectId}`);
  return tasks;
}

export async function createTask(input: TaskCreateInput): Promise<Task> {
  const { task } = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return task;
}

export async function getTask(id: number): Promise<Task> {
  const { task } = await request<{ task: Task }>(`/api/tasks/${id}`);
  return task;
}

export async function updateTask(id: number, patch: TaskUpdateInput): Promise<Task> {
  const { task } = await request<{ task: Task }>(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return task;
}
