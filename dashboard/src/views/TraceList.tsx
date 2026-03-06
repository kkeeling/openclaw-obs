import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { FixedSizeList as List } from "react-window";
import FilterPills from "../components/FilterPills";
import { useTraces, type TraceRow, type TraceFilters } from "../hooks/useApi";

const COST_ALERT_USD = 5;

function StatusDot({ status }: { status: string }) {
  const color =
    status === "success"
      ? "bg-status-success"
      : status === "error"
        ? "bg-status-error"
        : status === "running"
          ? "bg-status-running"
          : "bg-gray-400";
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${color}`}
      title={status}
    />
  );
}

function formatDuration(startMs: number, endMs: number | null): string {
  if (!endMs) return "running";
  const ms = endMs - startMs;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}


function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

// Extended trace row that includes span aggregates (computed client-side from the list)
// The API just returns trace rows; we use the trace data as-is.
// For the trace list, cost/tokens come from metadata or we show what we have.
// Since the API doesn't include span aggregates in list view, we display trace-level data.

const columns: ColumnDef<TraceRow>[] = [
  {
    id: "status",
    header: "",
    size: 40,
    accessorFn: (row) => row.status,
    cell: ({ row }) => <StatusDot status={row.original.status} />,
    enableSorting: true,
  },
  {
    id: "session_id",
    header: "Session ID",
    size: 180,
    accessorFn: (row) => row.session_id,
    cell: ({ row }) => (
      <span className="font-mono text-xs truncate block max-w-[170px]" title={row.original.session_id}>
        {row.original.session_id.slice(0, 12)}...
      </span>
    ),
  },
  {
    id: "agent_name",
    header: "Agent",
    size: 120,
    accessorFn: (row) => row.agent_name,
    cell: ({ row }) => (
      <span className="truncate block max-w-[110px]">{row.original.agent_name}</span>
    ),
  },
  {
    id: "duration",
    header: "Duration",
    size: 100,
    accessorFn: (row) => (row.ended_at ? row.ended_at - row.started_at : Infinity),
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {formatDuration(row.original.started_at, row.original.ended_at)}
      </span>
    ),
  },
  {
    id: "started_at",
    header: "Started",
    size: 120,
    accessorFn: (row) => row.started_at,
    cell: ({ row }) => (
      <span className="text-xs text-gray-500">{timeAgo(row.original.started_at)}</span>
    ),
  },
];

const ROW_HEIGHT = 40;

export default function TraceList() {
  const [filters, setFilters] = useState<TraceFilters>({});
  const [sorting, setSorting] = useState<SortingState>([
    { id: "started_at", desc: true },
  ]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<List>(null);

  const { data: traces, loading } = useTraces(filters);

  const table = useReactTable({
    data: traces || [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;

  const openTrace = useCallback(
    (id: string) => navigate(`/traces/${id}`),
    [navigate],
  );

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT") return;

      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("trace-search")?.focus();
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, rows.length - 1));
      }
      if (e.key === "k") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter" && rows[selectedIdx]) {
        e.preventDefault();
        openTrace(rows[selectedIdx].original.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selectedIdx, openTrace]);

  // Scroll selected row into view
  useEffect(() => {
    listRef.current?.scrollToItem(selectedIdx, "smart");
  }, [selectedIdx]);

  const [containerHeight, setContainerHeight] = useState(600);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const headerGroups = table.getHeaderGroups();
  const columnSizing = useMemo(
    () =>
      headerGroups[0]?.headers.map((h) => h.getSize()).join("px ") + "px",
    [headerGroups],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 pb-3 space-y-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Traces</h1>
          <span className="text-sm text-gray-500">
            {traces ? `${traces.length} traces` : "Loading..."}
          </span>
        </div>
        <FilterPills filters={filters} onChange={setFilters} />
      </div>

      {/* Table header */}
      <div
        className="grid text-xs text-gray-500 uppercase tracking-wide font-medium border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 px-4 shrink-0"
        style={{ gridTemplateColumns: columnSizing }}
      >
        {headerGroups[0]?.headers.map((header) => (
          <div
            key={header.id}
            className="py-2 cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-300 transition-colors duration-100"
            onClick={header.column.getToggleSortingHandler()}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
            {{ asc: " \u2191", desc: " \u2193" }[header.column.getIsSorted() as string] ?? ""}
          </div>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0" ref={containerRef}>
        {loading && !traces ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 text-gray-400 dark:text-gray-600">
            <p className="text-lg mb-1">No traces recorded yet</p>
            <p className="text-sm">Traces will appear here once sessions run.</p>
          </div>
        ) : (
          <List
            ref={listRef}
            height={containerHeight}
            itemCount={rows.length}
            itemSize={ROW_HEIGHT}
            width="100%"
            overscanCount={10}
          >
            {({ index, style }) => {
              const row = rows[index];
              const isSelected = index === selectedIdx;
              // Parse metadata for cost if available
              let cost: number | null = null;
              if (row.original.metadata) {
                try {
                  const meta = JSON.parse(row.original.metadata);
                  cost = meta.total_cost ?? null;
                } catch { /* ignore */ }
              }
              const isExpensive = cost != null && cost >= COST_ALERT_USD;

              return (
                <div
                  style={{ ...style, display: "grid", gridTemplateColumns: columnSizing, alignItems: "center", paddingLeft: "1rem", paddingRight: "1rem" }}
                  className={`text-sm cursor-pointer border-b border-gray-100 dark:border-gray-800/50 transition-colors duration-100 ${
                    isSelected
                      ? "bg-accent/5 dark:bg-accent/10"
                      : "hover:bg-gray-50 dark:hover:bg-gray-900/50"
                  } ${isExpensive ? "bg-orange-50 dark:bg-orange-950/20" : ""}`}
                  onClick={() => {
                    setSelectedIdx(index);
                    openTrace(row.original.id);
                  }}
                  role="row"
                  tabIndex={-1}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} className="truncate">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            }}
          </List>
        )}
      </div>
    </div>
  );
}
