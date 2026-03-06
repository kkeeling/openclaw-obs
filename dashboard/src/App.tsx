import { useEffect, useState, useCallback } from "react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Overview from "./views/Overview";
import TraceList from "./views/TraceList";
import TraceDetail from "./views/TraceDetail";

export default function App() {
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("openclaw-obs-dark");
      if (stored !== null) return stored === "true";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("openclaw-obs-dark", String(darkMode));
  }, [darkMode]);

  const toggleDark = useCallback(() => setDarkMode((d) => !d), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.key === "d") {
        e.preventDefault();
        toggleDark();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (location.pathname.startsWith("/traces/")) {
          navigate("/traces");
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDark, navigate, location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        darkMode={darkMode}
        onToggleDark={toggleDark}
      />
      <main className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-950">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/traces" element={<TraceList />} />
          <Route path="/traces/:id" element={<TraceDetail />} />
        </Routes>
      </main>
    </div>
  );
}
