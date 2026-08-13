import { Link } from "react-router-dom";
import type { Task } from "../../../shared/types";

interface TaskRowProps {
  task: Task;
  onToggle: (task: Task) => void;
}

export function TaskRow({ task, onToggle }: TaskRowProps) {
  return (
    <li className={task.done ? "task-row task-row--done" : "task-row"}>
      <input
        type="checkbox"
        checked={task.done}
        onChange={() => onToggle(task)}
        aria-label={`Mark "${task.title}" done`}
      />
      <Link to={`/tasks/${task.id}`} className="task-row__title">
        {task.title}
      </Link>
    </li>
  );
}
