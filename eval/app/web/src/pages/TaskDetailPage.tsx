import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { Task } from "../../../shared/types";
import { getTask, updateTask } from "../api/tasks";
import { Button } from "../components/Button";
import { CheckboxField } from "../components/CheckboxField";

export function TaskDetailPage() {
  const { taskId } = useParams();
  const id = Number(taskId);
  const [task, setTask] = useState<Task | null>(null);
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getTask(id)
      .then((task) => {
        setTask(task);
        setNotes(task.notes);
        setDone(task.done);
      })
      .catch(() => setTask(null));
  }, [id]);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const updated = await updateTask(id, { notes, done });
    setTask(updated);
    setSaved(true);
  };

  if (!task) return null;

  return (
    <section>
      <h1>{task.title}</h1>
      <p className="page-subtitle">
        <Link to={`/projects/${task.projectId}`}>Back to project</Link>
      </p>
      <form onSubmit={handleSave}>
        <div className="field">
          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            rows={5}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              setSaved(false);
            }}
          />
        </div>
        <CheckboxField
          label="Done"
          checked={done}
          onChange={(event) => {
            setDone(event.target.checked);
            setSaved(false);
          }}
        />
        <Button type="submit">Save</Button>
        {saved ? <span className="status-message"> Changes saved</span> : null}
      </form>
    </section>
  );
}
