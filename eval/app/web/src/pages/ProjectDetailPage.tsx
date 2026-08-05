import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { TaskCreateSchema } from "../../../shared/tasks";
import type { Project, Task } from "../../../shared/types";
import { getProject } from "../api/projects";
import { createTask, listTasks, updateTask } from "../api/tasks";
import { Button } from "../components/Button";
import { FilterBar, type TaskFilter } from "../components/FilterBar";
import { TaskRow } from "../components/TaskRow";

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [title, setTitle] = useState("");

  useEffect(() => {
    getProject(id).then(setProject).catch(() => setProject(null));
    listTasks(id).then(setTasks).catch(() => setTasks([]));
  }, [id]);

  const visibleTasks = useMemo(() => {
    if (filter === "open") return tasks.filter((task) => !task.done);
    if (filter === "completed") return tasks.filter((task) => task.done);
    return tasks;
  }, [tasks, filter]);

  const doneCount = tasks.filter((task) => task.done).length;

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = TaskCreateSchema.safeParse({ projectId: id, title });
    if (!parsed.success) return;
    const task = await createTask(parsed.data);
    setTasks((current) => [...current, task]);
    setTitle("");
  };

  const handleToggle = async (task: Task) => {
    const updated = await updateTask(task.id, { done: !task.done });
    setTasks((current) => current.map((t) => (t.id === updated.id ? updated : t)));
  };

  if (!project) return null;

  return (
    <section>
      <h1>{project.name}</h1>
      <p className="page-subtitle">
        {doneCount} of {tasks.length} done
      </p>
      <form className="add-task-form" onSubmit={handleAdd}>
        <input
          aria-label="New task title"
          placeholder="Add a task"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit">Add task</Button>
      </form>
      <FilterBar value={filter} onChange={setFilter} />
      <ul className="task-list">
        {visibleTasks.map((task) => (
          <TaskRow key={task.id} task={task} onToggle={handleToggle} />
        ))}
      </ul>
      {visibleTasks.length === 0 ? (
        <p className="status-message">No tasks match this filter.</p>
      ) : null}
    </section>
  );
}
