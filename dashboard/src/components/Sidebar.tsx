import { useState } from "react";
import { NavLink } from "react-router-dom";
import { prune } from "../hooks/useApi";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  darkMode: boolean;
  onToggleDark: () => void;
}

const navItems = [
  { to: "/", label: "Overview", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { to: "/traces", label: "Traces", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" },
];

function SvgIcon({ d }: { d: string }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

function PruneButton({ collapsed }: { collapsed: boolean }) {
  const [pruning, setPruning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handlePrune() {
    if (pruning) return;
    setPruning(true);
    setResult(null);
    try {
      const res = await prune();
      const sizeMb = (res.db_size_bytes / (1024 * 1024)).toFixed(1);
      setResult(`${res.deleted} pruned (${sizeMb}MB)`);
      setTimeout(() => setResult(null), 3000);
    } catch {
      setResult("Prune failed");
      setTimeout(() => setResult(null), 3000);
    } finally {
      setPruning(false);
    }
  }

  return (
    <button
      onClick={handlePrune}
      disabled={pruning}
      className="flex items-center gap-3 w-full px-2 py-1.5 rounded text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-100 disabled:opacity-50"
      title={result || "Prune old traces"}
    >
      <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      {!collapsed && <span>{pruning ? "Pruning..." : result || "Prune Data"}</span>}
    </button>
  );
}

export default function Sidebar({ collapsed, onToggle, darkMode, onToggleDark }: SidebarProps) {
  return (
    <aside
      className={`${
        collapsed ? "w-12" : "w-60"
      } h-screen flex flex-col border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 transition-[width] duration-150 shrink-0`}
    >
      {/* Header */}
      <div className="flex items-center h-12 px-3 border-b border-gray-200 dark:border-gray-800">
        {!collapsed && (
          <span className="font-semibold text-sm text-accent truncate">OpenClaw Obs</span>
        )}
        <button
          onClick={onToggle}
          className="ml-auto p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-100"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {collapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            )}
          </svg>
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 space-y-0.5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 mx-1 rounded text-sm transition-colors duration-100 ${
                isActive
                  ? "bg-accent/10 text-accent font-medium"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`
            }
          >
            <SvgIcon d={item.icon} />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-gray-200 dark:border-gray-800 p-2 space-y-1">
        <PruneButton collapsed={collapsed} />
        <button
          onClick={onToggleDark}
          className="flex items-center gap-3 w-full px-2 py-1.5 rounded text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-100"
          title="Toggle dark mode (d)"
        >
          <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            {darkMode ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            )}
          </svg>
          {!collapsed && <span>{darkMode ? "Light mode" : "Dark mode"}</span>}
        </button>
      </div>
    </aside>
  );
}
