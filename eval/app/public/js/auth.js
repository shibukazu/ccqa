import { apiLogin } from "./api.js";

// Sign-in form: on success the login view is swapped for the tasks view and
// the session note names the signed-in account.

export function initAuth(onSignedIn) {
  const form = document.getElementById("login-form");
  const error = document.getElementById("login-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    try {
      await apiLogin(email, password);
    } catch {
      error.hidden = false;
      return;
    }
    error.hidden = true;
    document.getElementById("login-view").hidden = true;
    document.getElementById("tasks-view").hidden = false;
    document.getElementById("session-note").textContent = `Signed in as ${email}`;
    onSignedIn();
  });
}
