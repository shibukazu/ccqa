// Input validation for the JSON API. Each check returns the usable value, or
// null when the input is not usable; the route decides the response.

export function validTitle(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  return title === "" ? null : title;
}

export function validDone(body) {
  return typeof body.done === "boolean" ? body.done : null;
}
