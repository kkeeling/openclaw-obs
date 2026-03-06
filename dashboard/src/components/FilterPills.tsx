import type { TraceFilters } from "../hooks/useApi";

interface FilterPillsProps {
  filters: TraceFilters;
  onChange: (filters: TraceFilters) => void;
}

const STATUS_OPTIONS = ["", "running", "success", "error"];

export default function FilterPills({ filters, onChange }: FilterPillsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status */}
      <select
        value={filters.status || ""}
        onChange={(e) => onChange({ ...filters, status: e.target.value || undefined })}
        className="h-8 px-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value="">All Status</option>
        {STATUS_OPTIONS.filter(Boolean).map((s) => (
          <option key={s} value={s}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </option>
        ))}
      </select>

      {/* Agent */}
      <input
        type="text"
        placeholder="Agent..."
        value={filters.agent || ""}
        onChange={(e) => onChange({ ...filters, agent: e.target.value || undefined })}
        className="h-8 w-32 px-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
      />

      {/* Model */}
      <input
        type="text"
        placeholder="Model..."
        value={filters.model || ""}
        onChange={(e) => onChange({ ...filters, model: e.target.value || undefined })}
        className="h-8 w-32 px-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
      />

      {/* Search */}
      <input
        type="text"
        placeholder="Search session ID... (/)"
        value={filters.search || ""}
        onChange={(e) => onChange({ ...filters, search: e.target.value || undefined })}
        className="h-8 w-48 px-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        id="trace-search"
      />

      {/* Cost threshold */}
      <input
        type="number"
        placeholder="Min cost $"
        step="0.01"
        min="0"
        value={filters.minCost ?? ""}
        onChange={(e) =>
          onChange({
            ...filters,
            minCost: e.target.value ? parseFloat(e.target.value) : undefined,
          })
        }
        className="h-8 w-28 px-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
      />

      {/* Clear */}
      {(filters.status || filters.agent || filters.model || filters.search || filters.minCost) && (
        <button
          onClick={() => onChange({})}
          className="h-8 px-3 rounded bg-gray-200 dark:bg-gray-800 text-sm hover:bg-gray-300 dark:hover:bg-gray-700 transition-colors duration-100"
        >
          Clear
        </button>
      )}
    </div>
  );
}
