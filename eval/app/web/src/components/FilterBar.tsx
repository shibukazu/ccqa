export type TaskFilter = "all" | "open" | "completed";

const FILTERS: Array<{ value: TaskFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
];

interface FilterBarProps {
  value: TaskFilter;
  onChange: (value: TaskFilter) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  return (
    <div className="filter-bar" role="group" aria-label="Filter tasks">
      {FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          className="filter-bar__option"
          aria-pressed={filter.value === value}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}
