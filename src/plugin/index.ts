import { randomUUID } from "node:crypto";
import {
  upsertTrace,
  insertSpan,
  updateSpan,
  updateTrace,
  pruneOldTraces,
  pruneBySize,
  closeDb,
} from "./db.js";
import { EventBuffer, type BufferedEvent } from "./buffer.js";

// Type stubs for the OpenClaw plugin SDK (avoid hard dependency)
interface PluginApi {
  on(hook: string, handler: (ctx: Record<string, unknown>, event: Record<string, unknown>) => void): void;
  registerService(service: {
    id: string;
    start: (ctx: Record<string, unknown>) => void | Promise<void>;
    stop: (ctx: Record<string, unknown>) => void | Promise<void>;
  }): void;
}

type DiagnosticListener = (event: Record<string, unknown>) => void;

// Track active traces/spans for correlation
const sessionTraceMap = new Map<string, { traceId: string; lastActivity: number }>(); // sessionId -> {traceId, lastActivity}
const toolSpanMap = new Map<string, string>(); // unique callKey -> spanId (uses callId or generated UUID to avoid collisions)
let pruneInterval: ReturnType<typeof setInterval> | null = null;

// Max age for sessionTraceMap entries before eviction (2 hours)
const SESSION_MAP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function evictStaleSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of sessionTraceMap) {
    if (now - entry.lastActivity > SESSION_MAP_MAX_AGE_MS) {
      sessionTraceMap.delete(sessionId);
    }
  }
  // Also clean any orphaned toolSpanMap entries older than the session threshold
  // (toolSpanMap entries reference sessions that may have been evicted)
}

function flushBatch(events: BufferedEvent[]): void {
  for (const event of events) {
    try {
      switch (event.type) {
        case "trace":
          upsertTrace(event.data as Parameters<typeof upsertTrace>[0]);
          break;
        case "span":
          insertSpan(event.data as Parameters<typeof insertSpan>[0]);
          break;
        case "trace_update":
          updateTrace(
            event.data.id as string,
            event.data.updates as Parameters<typeof updateTrace>[1],
          );
          break;
        case "span_update":
          updateSpan(
            event.data.id as string,
            event.data.updates as Parameters<typeof updateSpan>[1],
          );
          break;
      }
    } catch (err) {
      console.error("[openclaw-obs] Write error:", err);
    }
  }
}

const buffer = new EventBuffer(flushBatch);

function inferSpanKind(toolName: string): string {
  if (toolName.startsWith("subagents/") || toolName === "sessions_spawn") {
    return "subagent";
  }
  return "tool";
}

function getOrCreateTrace(
  sessionId: string,
  agentName?: string,
): string {
  const entry = sessionTraceMap.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
    return entry.traceId;
  }
  const traceId = randomUUID();
  sessionTraceMap.set(sessionId, { traceId, lastActivity: Date.now() });
  buffer.push({
    type: "trace",
    data: {
      id: traceId,
      session_id: sessionId,
      agent_name: agentName || "unknown",
      started_at: Date.now(),
      ended_at: null,
      status: "running",
    },
  });
  return traceId;
}

function registerHooks(api: PluginApi): void {
  api.on("session_start", (ctx, event) => {
    const sessionId = (event.sessionId as string) || (ctx.sessionId as string);
    if (!sessionId) return;
    const agentName = (ctx.agentId as string) || "unknown";
    getOrCreateTrace(sessionId, agentName);
  });

  api.on("session_end", (ctx, event) => {
    const sessionId = (event.sessionId as string) || (ctx.sessionId as string);
    if (!sessionId) return;
    const entry = sessionTraceMap.get(sessionId);
    if (!entry) return;
    const traceId = entry.traceId;

    buffer.push({
      type: "trace_update",
      data: {
        id: traceId,
        updates: {
          ended_at: Date.now(),
          status: "success",
        },
      },
    });
    sessionTraceMap.delete(sessionId);
  });

  api.on("before_agent_start", (ctx, _event) => {
    const sessionId = (ctx.sessionKey as string) || (ctx.sessionId as string);
    if (!sessionId) return;
    const agentName = (ctx.agentId as string) || "unknown";
    getOrCreateTrace(sessionId, agentName);
  });

  api.on("agent_end", (ctx, event) => {
    const sessionId = (ctx.sessionKey as string) || (ctx.sessionId as string);
    if (!sessionId) return;
    const entry = sessionTraceMap.get(sessionId);
    if (!entry) return;
    const traceId = entry.traceId;

    const success = event.success as boolean;
    buffer.push({
      type: "trace_update",
      data: {
        id: traceId,
        updates: {
          ended_at: Date.now(),
          status: success ? "success" : "error",
          ...(event.error ? {} : {}),
        },
      },
    });
  });

  api.on("before_tool_call", (ctx, event) => {
    const sessionId = (ctx.sessionKey as string) || (ctx.sessionId as string);
    const toolName = (event.toolName as string) || (ctx.toolName as string) || "unknown";
    if (!sessionId) return;

    const traceId = getOrCreateTrace(sessionId);
    const spanId = randomUUID();
    // Use callId from event if available; otherwise generate a unique key
    // This prevents collisions when the same tool is called in parallel
    const callId = (event.callId as string) || (event.id as string) || spanId;
    const mapKey = `${toolName}:${sessionId}:${callId}`;
    toolSpanMap.set(mapKey, spanId);

    buffer.push({
      type: "span",
      data: {
        id: spanId,
        trace_id: traceId,
        parent_span_id: null,
        kind: inferSpanKind(toolName),
        name: toolName,
        started_at: Date.now(),
        ended_at: null,
        input_json: safeStringify(event.params),
        output_json: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        model: null,
        error: null,
        metadata: null,
      },
    });
  });

  api.on("after_tool_call", (ctx, event) => {
    const sessionId = (ctx.sessionKey as string) || (ctx.sessionId as string);
    const toolName = (event.toolName as string) || (ctx.toolName as string) || "unknown";
    if (!sessionId) return;

    // Match using the same callId-based key from before_tool_call
    const callId = (event.callId as string) || (event.id as string) || "";
    const mapKey = `${toolName}:${sessionId}:${callId}`;
    const spanId = toolSpanMap.get(mapKey);
    if (!spanId) return;
    toolSpanMap.delete(mapKey);

    buffer.push({
      type: "span_update",
      data: {
        id: spanId,
        updates: {
          ended_at: Date.now(),
          output_json: safeStringify(event.result),
          error: (event.error as string) || null,
        },
      },
    });
  });
}

function handleDiagnosticEvent(event: Record<string, unknown>): void {
  if (event.type !== "model.usage") return;

  const sessionId = (event.sessionKey as string) || (event.sessionId as string);
  if (!sessionId) return;

  const traceId = getOrCreateTrace(sessionId);
  const usage = event.usage as Record<string, number> | undefined;
  const spanId = randomUUID();

  buffer.push({
    type: "span",
    data: {
      id: spanId,
      trace_id: traceId,
      parent_span_id: null,
      kind: "llm",
      name: (event.model as string) || "unknown",
      started_at: Date.now() - ((event.durationMs as number) || 0),
      ended_at: Date.now(),
      input_json: null,
      output_json: null,
      tokens_in: usage?.input ?? usage?.promptTokens ?? null,
      tokens_out: usage?.output ?? null,
      cost_usd: (event.costUsd as number) ?? null,
      model: (event.model as string) ?? null,
      error: null,
      metadata: safeStringify({
        provider: event.provider,
        channel: event.channel,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
        contextUsed: (event.context as Record<string, unknown>)?.used,
        contextLimit: (event.context as Record<string, unknown>)?.limit,
      }),
    },
  });
}

function safeStringify(val: unknown): string | null {
  if (val == null) return null;
  try {
    return JSON.stringify(val);
  } catch {
    return null;
  }
}

// Plugin export
export const plugin = {
  id: "openclaw-obs",
  name: "OpenClaw Observability",
  description: "Local observability plugin — captures LLM calls, tool invocations, and session metadata to SQLite",
  configSchema: {},
  register(api: PluginApi) {
    registerHooks(api);

    // Register diagnostic event listener
    // The plugin SDK provides onDiagnosticEvent at the module level
    // We'll try to import it dynamically to avoid hard dependency
    try {
      // Dynamic import will be resolved at runtime in the OpenClaw environment
      // @ts-expect-error -- openclaw/plugin-sdk only exists at runtime inside OpenClaw
      import("openclaw/plugin-sdk").then((sdk: { onDiagnosticEvent?: (listener: DiagnosticListener) => void }) => {
        if (typeof sdk.onDiagnosticEvent === "function") {
          sdk.onDiagnosticEvent(handleDiagnosticEvent);
        }
      }).catch(() => {
        console.error("[openclaw-obs] Could not load openclaw/plugin-sdk diagnostic events");
      });
    } catch {
      // Not in an OpenClaw environment
    }

    // Register the dashboard server as a service
    api.registerService({
      id: "openclaw-obs-dashboard",
      async start() {
        buffer.start();

        // Prune on startup
        try {
          pruneOldTraces();
          pruneBySize();
        } catch (err) {
          console.error("[openclaw-obs] Prune on startup failed:", err);
        }

        // Hourly prune (DB records + stale in-memory map entries)
        pruneInterval = setInterval(() => {
          try {
            pruneOldTraces();
            pruneBySize();
            evictStaleSessions();
          } catch (err) {
            console.error("[openclaw-obs] Scheduled prune failed:", err);
          }
        }, 60 * 60 * 1000);
        if (pruneInterval && typeof pruneInterval === "object" && "unref" in pruneInterval) {
          pruneInterval.unref();
        }
      },
      async stop() {
        buffer.stop();
        if (pruneInterval) {
          clearInterval(pruneInterval);
          pruneInterval = null;
        }
        closeDb();
      },
    });
  },
};

export default plugin;

// Also export the diagnostic handler for standalone use
export { handleDiagnosticEvent };
