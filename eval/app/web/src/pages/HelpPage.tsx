import { Link } from "react-router-dom";

export function HelpPage() {
  return (
    <div className="help-page">
      <h1>How it works</h1>
      <p>
        Taskboard keeps each team's work in projects. A project holds tasks;
        a task can carry notes and is either open or done.
      </p>
      <ul>
        <li>Create a project from the Projects page.</li>
        <li>Add tasks inside a project and tick them off as you finish.</li>
        <li>Use the filter to focus on open or completed work.</li>
        <li>Change your display name any time under Settings.</li>
      </ul>
      <p>
        <Link to="/">Back to the app</Link>
      </p>
    </div>
  );
}
