// Filter bar (All / Active / Completed). The whole feature lives here: the
// buttons are rendered into #filter-bar, the pressed one carries
// aria-pressed="true", and the list re-renders through the callback.

const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
];

let filter = "all";

export function currentFilter() {
  return filter;
}

export function initFilter(onChange) {
  const bar = document.getElementById("filter-bar");
  for (const { id, label } of FILTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(id === filter));
    button.addEventListener("click", () => {
      filter = id;
      for (const other of bar.querySelectorAll("button")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      onChange();
    });
    bar.appendChild(button);
  }
}
