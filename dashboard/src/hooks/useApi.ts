import { useState, useEffect, useCallback, useRef } from "react";

export interface TraceRow {
  id: string;
  session_id: string;
  agent_name: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  metadata: string | null;
}

export interface SpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  input_json: string | null;
  output_json: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  model: string | null;
  error: string | null;
  metadata: string | null;
}

export interface TraceDetail extends TraceRow {
  spans: SpanRow[];
}

export interface Stats {
  trace_count: number;
  error_count: number;
  avg_duration_ms: number;
  total_cost: number;
  cost_by_agent: Array<{ agent_name: string; cost: number }>;
  cost_by_day: Array<{
    day: string;
    cost: number;
    tokens_in: number;
    tokens_out: number;
    trace_count: number;
    error_count: number;
  }>;
  model_breakdown: Array<{
    model: string;
    call_count: number;
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost: number;
  }>;
}

export interface HealthInfo {
  db_size_bytes: number;
  trace_count: number;
  oldest_trace: number | null;
  newest_trace: number | null;
  retention_days: number;
}

export interface TraceFilters {
  status?: string;
  agent?: string;
  model?: string;
  since?: number;
  until?: number;
  minCost?: number;
  search?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): { data: T | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    doFetch();
    const id = setInterval(doFetch, intervalMs);
    return () => clearInterval(id);
  }, [doFetch, intervalMs]);

  return { data, loading, error, refresh: doFetch };
}

export function useTraces(filters: TraceFilters) {
  const fetcher = useCallback(() => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.agent) params.set("agent", filters.agent);
    if (filters.model) params.set("model", filters.model);
    if (filters.since) params.set("since", String(filters.since));
    if (filters.until) params.set("until", String(filters.until));
    if (filters.minCost) params.set("minCost", String(filters.minCost));
    if (filters.search) params.set("search", filters.search);
    params.set("limit", "500");
    const qs = params.toString();
    return fetchJson<TraceRow[]>(`/api/traces${qs ? `?${qs}` : ""}`);
  }, [filters.status, filters.agent, filters.model, filters.since, filters.until, filters.minCost, filters.search]);

  return usePolling(fetcher, 5000);
}

export function useTraceDetail(id: string) {
  const fetcher = useCallback(() => fetchJson<TraceDetail>(`/api/traces/${id}`), [id]);
  return usePolling(fetcher, 5000);
}

export function useStats(since?: number, until?: number) {
  const fetcher = useCallback(() => {
    const params = new URLSearchParams();
    if (since) params.set("since", String(since));
    if (until) params.set("until", String(until));
    const qs = params.toString();
    return fetchJson<Stats>(`/api/stats${qs ? `?${qs}` : ""}`);
  }, [since, until]);

  return usePolling(fetcher, 30000);
}

export function useHealth() {
  return usePolling(() => fetchJson<HealthInfo>("/api/health"), 30000);
}

export async function prune(): Promise<{ deleted: number; db_size_bytes: number }> {
  return fetchJson("/api/prune", { method: "POST" });
}
