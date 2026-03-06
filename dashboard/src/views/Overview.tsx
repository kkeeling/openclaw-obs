import { useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import MetricCard from "../components/MetricCard";
import { useStats } from "../hooks/useApi";

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function Overview() {
  const sevenDaysAgo = useMemo(() => Date.now() - 7 * 24 * 60 * 60 * 1000, []);
  const { data: stats, loading } = useStats(sevenDaysAgo);

  const errorRate = stats && stats.trace_count > 0
    ? ((stats.error_count / stats.trace_count) * 100).toFixed(1)
    : "0";

  const isEmpty = stats && stats.trace_count === 0;

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <h1 className="text-lg font-semibold">Overview</h1>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <MetricCard
          label="7-Day Cost"
          value={stats ? formatCost(stats.total_cost) : "-"}
          subtext="Last 7 days"
          loading={loading}
        />
        <MetricCard
          label="Trace Count"
          value={stats ? String(stats.trace_count) : "-"}
          loading={loading}
        />
        <MetricCard
          label="Error Rate"
          value={stats ? `${errorRate}%` : "-"}
          subtext={stats ? `${stats.error_count} errors` : undefined}
          loading={loading}
        />
        <MetricCard
          label="Avg Duration"
          value={stats ? formatDuration(stats.avg_duration_ms) : "-"}
          loading={loading}
        />
      </div>

      {isEmpty ? (
        <div className="text-center py-16 text-gray-400 dark:text-gray-600">
          <p className="text-lg mb-1">Not enough data for charts</p>
          <p className="text-sm">Start some sessions to see analytics here.</p>
        </div>
      ) : (
        <>
          {/* Charts Grid */}
          <div className="grid grid-cols-2 gap-4">
            {/* Cost Over Time */}
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <h2 className="text-sm font-medium mb-3 text-gray-600 dark:text-gray-400">Cost Over Time</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={stats?.cost_by_day || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, background: "var(--tw-bg-opacity, #fff)", border: "1px solid #e5e7eb" }}
                    formatter={(value: number) => [formatCost(value), "Cost"]}
                  />
                  <Line type="monotone" dataKey="cost" stroke="#228BE6" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Cost By Agent */}
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <h2 className="text-sm font-medium mb-3 text-gray-600 dark:text-gray-400">Cost By Agent</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={stats?.cost_by_agent || []} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                  <YAxis type="category" dataKey="agent_name" tick={{ fontSize: 11 }} width={100} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value: number) => [formatCost(value), "Cost"]}
                  />
                  <Bar dataKey="cost" fill="#228BE6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Token Usage */}
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <h2 className="text-sm font-medium mb-3 text-gray-600 dark:text-gray-400">Token Usage</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={stats?.cost_by_day || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatTokens(v)} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value: number, name: string) => [
                      formatTokens(value),
                      name === "tokens_in" ? "Input" : "Output",
                    ]}
                  />
                  <Legend formatter={(v) => (v === "tokens_in" ? "Input" : "Output")} />
                  <Line type="monotone" dataKey="tokens_in" stroke="#228BE6" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="tokens_out" stroke="#2B8A3E" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Error Rate */}
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <h2 className="text-sm font-medium mb-3 text-gray-600 dark:text-gray-400">Error Rate</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={(stats?.cost_by_day || []).map((d) => ({
                    ...d,
                    error_rate: d.trace_count > 0 ? (d.error_count / d.trace_count) * 100 : 0,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value: number) => [`${value.toFixed(1)}%`, "Error Rate"]}
                  />
                  <ReferenceLine y={10} stroke="#E8590C" strokeDasharray="5 5" label={{ value: "10%", fontSize: 10 }} />
                  <Line type="monotone" dataKey="error_rate" stroke="#E03131" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Model Breakdown Table */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
            <h2 className="text-sm font-medium px-4 py-3 border-b border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400">
              Model Breakdown
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-200 dark:border-gray-800">
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 font-medium text-right">Calls</th>
                  <th className="px-4 py-2 font-medium text-right">Tokens In</th>
                  <th className="px-4 py-2 font-medium text-right">Tokens Out</th>
                  <th className="px-4 py-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.model_breakdown || []).map((m) => (
                  <tr
                    key={m.model}
                    className="border-b border-gray-100 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors duration-100"
                  >
                    <td className="px-4 py-2 font-mono">{m.model}</td>
                    <td className="px-4 py-2 text-right font-mono">{m.call_count.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-mono">{formatTokens(m.total_tokens_in)}</td>
                    <td className="px-4 py-2 text-right font-mono">{formatTokens(m.total_tokens_out)}</td>
                    <td className="px-4 py-2 text-right font-mono">{formatCost(m.total_cost)}</td>
                  </tr>
                ))}
                {(stats?.model_breakdown || []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                      No model data available
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
