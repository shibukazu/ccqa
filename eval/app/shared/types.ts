/** API response shapes shared between the Express routes and the web client. */

export interface SessionUser {
  id: number;
  email: string;
  displayName: string;
}

export interface Project {
  id: number;
  name: string;
  openCount: number;
  doneCount: number;
}

export interface Task {
  id: number;
  projectId: number;
  title: string;
  notes: string;
  done: boolean;
  createdAt: string;
}

export interface UserSettings {
  displayName: string;
  emailUpdates: boolean;
}
