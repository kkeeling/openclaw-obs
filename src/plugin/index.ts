import { randomUUID } from "node:crypto";
import {
  upsertTrace,
  insertSpan,
  updateSpan,
  updateTrace,
  updateLatestLlmSpanCost,
  insertMessage,
  pruneOldTraces,
  pruneBySize,
  closeDb,
} from "./db.js";
import { EventBuffer, type BufferedEvent } from "./buffer.js";
import { estimateCost } from "./pricing.js";

// Type stubs for the OpenClaw plugin SDK (avoid hard dependency)
interface PluginApi {
  on(hook: string, handler: (...args: unknown[]) => void): void;
  registerService(service: {
    id: string;
    start: (ctx: Record<string, unknown>) => void | Promise<void>;
    stop: (ctx: Record<string, unknown>) => void | Promise<void>;
  }): void;
}

type DiagnosticListener = (event: Record<string, unknown>) => void;

// Track active traces/spans for correlation
const sessionTraceMap = new Map<string, { traceId: string; lastActivity: number }>(); // sessionKey -> {traceId, lastActivity}
const toolSpanMap = new Map<string, string>(); // unique callKey -> spanId
const messageSequence = new Map<string, number>(); // traceId -> next sequence number
const uuidToSessionKey = new Map<string, string>(); // UUID sessionId -> full sessionKey (for diagnostic event correlation)
const recentLlmSpanTraces = new Map<string, number>(); // traceId -> timestamp of last llm_output span (dedup with diagnostic events)
let pruneInterval: ReturnType<typeof setInterval> | null = null;

// Max age for sessionTraceMap entries before eviction (2 hours)
const SESSION_MAP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function nextSeq(traceId: string): number {
  const seq = messageSequence.get(traceId) ?? 0;
  messageSequence.set(traceId, seq + 1);
  return seq;
}

// UUID v4 pattern for extracting UUIDs from session keys
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Register a mapping from any UUID found in a session key to the full session key.
 * This allows diagnostic events (which only have UUID sessionId) to be correlated
 * with the proper named session.
 */
function registerSessionKeyMapping(sessionKey: string): void {
  const match = sessionKey.match(UUID_PATTERN);
  if (match) {
    uuidToSessionKey.set(match[0], sessionKey);
  }
}

/**
 * Extract agent name from a session key like "agent:dev:main" or "agent:grace:cron:UUID"
 */
function agentNameFromSessionKey(sessionKey: string): string | null {
  if (sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    if (parts.length >= 2) return parts[1];
  }
  return null;
}

function evictStaleSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of sessionTraceMap) {
    if (now - entry.lastActivity > SESSION_MAP_MAX_AGE_MS) {
      sessionTraceMap.delete(sessionId);
      messageSequence.delete(entry.traceId);
    }
  }
  // Also evict stale UUID mappings (keep in sync)
  for (const [uuid, sessionKey] of uuidToSessionKey) {
    if (!sessionTraceMap.has(sessionKey)) {
      uuidToSessionKey.delete(uuid);
    }
  }
  // Evict stale dedup entries (older than 30s)
  for (const [traceId, ts] of recentLlmSpanTraces) {
    if (now - ts > 30_000) {
      recentLlmSpanTraces.delete(traceId);
    }
  }
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
        case "message":
          insertMessage(event.data as unknown as Parameters<typeof insertMessage>[0]);
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

/**
 * Resolve agent name from context. The OpenClaw plugin SDK provides agentId
 * on various context objects. We try multiple fields for compatibility.
 */
function resolveAgentName(ctx: Record<string, unknown>): string {
  return (ctx.agentId as string) || "unknown";
}

/**
 * Resolve session key from context. Prefer sessionKey (stable across resets)
 * over sessionId (ephemeral UUID).
 */
function resolveSessionKey(ctx: Record<string, unknown>, event?: Record<string, unknown>): string | null {
  return (ctx.sessionKey as string)
    || (event?.sessionKey as string)
    || (ctx.sessionId as string)
    || (event?.sessionId as string)
    || null;
}

function getOrCreateTrace(
  sessionKey: string,
  agentName?: string,
): string {
  const entry = sessionTraceMap.get(sessionKey);
  if (entry) {
    entry.lastActivity = Date.now();
    return entry.traceId;
  }
  const traceId = randomUUID();
  sessionTraceMap.set(sessionKey, { traceId, lastActivity: Date.now() });
  registerSessionKeyMapping(sessionKey);

  // Try to infer agent name from session key if not provided
  const resolvedAgent = agentName || agentNameFromSessionKey(sessionKey) || "unknown";

  buffer.push({
    type: "trace",
    data: {
      id: traceId,
      session_id: sessionKey,
      agent_name: resolvedAgent,
      started_at: Date.now(),
      ended_at: null,
      status: "running",
    },
  });
  return traceId;
}

function registerHooks(api: PluginApi): void {
  // NOTE: The OpenClaw plugin SDK calls all hook handlers as (event, ctx).
  // We use consistent (event, ctx) parameter order across all hooks.

  // ---- Session lifecycle ----
  api.on("session_start", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    if (!sessionKey) return;
    const agentName = resolveAgentName(c);
    getOrCreateTrace(sessionKey, agentName);
  });

  api.on("session_end", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    if (!sessionKey) return;
    const entry = sessionTraceMap.get(sessionKey);
    if (!entry) return;

    buffer.push({
      type: "trace_update",
      data: {
        id: entry.traceId,
        updates: {
          ended_at: Date.now(),
          status: "success",
        },
      },
    });
    sessionTraceMap.delete(sessionKey);
    messageSequence.delete(entry.traceId);
  });

  api.on("before_agent_start", (event: unknown, ctx: unknown) => {
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c);
    if (!sessionKey) return;
    const agentName = resolveAgentName(c);
    getOrCreateTrace(sessionKey, agentName);
  });

  api.on("agent_end", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    if (!sessionKey) return;
    const entry = sessionTraceMap.get(sessionKey);
    if (!entry) return;

    const success = e.success as boolean;
    buffer.push({
      type: "trace_update",
      data: {
        id: entry.traceId,
        updates: {
          ended_at: Date.now(),
          status: success ? "success" : "error",
        },
      },
    });
  });

  // ---- Conversation capture: llm_input / llm_output ----
  api.on("llm_input", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    if (!sessionKey) return;
    const traceId = getOrCreateTrace(sessionKey, resolveAgentName(c));

    // Capture the user prompt as a message
    const prompt = e.prompt as string | undefined;
    if (prompt) {
      buffer.push({
        type: "message",
        data: {
          id: randomUUID(),
          trace_id: traceId,
          role: "user",
          content: prompt,
          tool_name: null,
          timestamp: Date.now(),
          sequence: nextSeq(traceId),
          metadata: safeStringify({ model: e.model, provider: e.provider }),
        },
      });
    }

    // Capture system prompt if present
    const systemPrompt = e.systemPrompt as string | undefined;
    if (systemPrompt) {
      buffer.push({
        type: "message",
        data: {
          id: randomUUID(),
          trace_id: traceId,
          role: "system",
          content: systemPrompt,
          tool_name: null,
          timestamp: Date.now(),
          sequence: nextSeq(traceId),
          metadata: null,
        },
      });
    }
  });

  api.on("llm_output", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    if (!sessionKey) return;
    const traceId = getOrCreateTrace(sessionKey, resolveAgentName(c));

    // Capture assistant response as a message
    const texts = e.assistantTexts as string[] | undefined;
    const content = texts?.join("\n") || "";
    if (content) {
      buffer.push({
        type: "message",
        data: {
          id: randomUUID(),
          trace_id: traceId,
          role: "assistant",
          content,
          tool_name: null,
          timestamp: Date.now(),
          sequence: nextSeq(traceId),
          metadata: safeStringify({
            model: e.model,
            provider: e.provider,
            usage: e.usage,
          }),
        },
      });
    }

    // Create an LLM span with token counts from the hook data directly.
    // This makes token tracking resilient — it works even when the
    // diagnostics.enabled config flag is off (which gates model.usage
    // diagnostic events in OpenClaw ≥2026.3.3).
    // When diagnostics ARE enabled, handleDiagnosticEvent creates a
    // separate span with cost data; the dashboard aggregates both.
    const usage = e.usage as Record<string, number> | undefined;
    if (usage && (usage.input || usage.output)) {
      const spanId = randomUUID();
      buffer.push({
        type: "span",
        data: {
          id: spanId,
          trace_id: traceId,
          parent_span_id: null,
          kind: "llm",
          name: (e.model as string) || "unknown",
          started_at: Date.now(),
          ended_at: Date.now(),
          input_json: null,
          output_json: null,
          tokens_in: usage.input ?? usage.promptTokens ?? null,
          tokens_out: usage.output ?? null,
          cost_usd: estimateCost({
            model: (e.model as string) ?? null,
            tokensIn: usage.input ?? usage.promptTokens ?? null,
            tokensOut: usage.output ?? null,
            cacheRead: usage.cacheRead ?? null,
            cacheWrite: usage.cacheWrite ?? null,
          }), // Estimate from pricing table; may be overwritten by diagnostic event if available
          model: (e.model as string) ?? null,
          error: null,
          metadata: safeStringify({
            source: "llm_output_hook",
            provider: e.provider,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          }),
        },
      });
      // Track for dedup — prevents handleDiagnosticEvent from creating a duplicate span
      recentLlmSpanTraces.set(traceId, Date.now());
    }
  });

  // ---- Tool call capture ----
  api.on("before_tool_call", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    const toolName = (c.toolName as string) || (e.toolName as string) || "unknown";
    if (!sessionKey) return;

    const traceId = getOrCreateTrace(sessionKey);
    const spanId = randomUUID();
    const callId = (e.toolCallId as string) || (e.callId as string) || (e.id as string) || "";
    const mapKey = callId ? `${toolName}:${sessionKey}:${callId}` : `${toolName}:${sessionKey}`;
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
        input_json: safeStringify(e.params),
        output_json: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        model: null,
        error: null,
        metadata: null,
      },
    });

    // Also record as a tool_call message
    buffer.push({
      type: "message",
      data: {
        id: randomUUID(),
        trace_id: traceId,
        role: "tool_call",
        content: safeStringify(e.params),
        tool_name: toolName,
        timestamp: Date.now(),
        sequence: nextSeq(traceId),
        metadata: null,
      },
    });
  });

  api.on("after_tool_call", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;
    const sessionKey = resolveSessionKey(c, e);
    const toolName = (c.toolName as string) || (e.toolName as string) || "unknown";
    if (!sessionKey) return;

    const callId = (e.toolCallId as string) || (e.callId as string) || (e.id as string) || "";
    const mapKey = callId ? `${toolName}:${sessionKey}:${callId}` : `${toolName}:${sessionKey}`;
    const spanId = toolSpanMap.get(mapKey);
    if (!spanId) return;
    toolSpanMap.delete(mapKey);

    buffer.push({
      type: "span_update",
      data: {
        id: spanId,
        updates: {
          ended_at: Date.now(),
          output_json: safeStringify(e.result),
          error: (e.error as string) || null,
        },
      },
    });

    // Record tool result message
    const traceId = getOrCreateTrace(sessionKey);
    buffer.push({
      type: "message",
      data: {
        id: randomUUID(),
        trace_id: traceId,
        role: "tool_result",
        content: safeStringify(e.result),
        tool_name: toolName,
        timestamp: Date.now(),
        sequence: nextSeq(traceId),
        metadata: e.error ? safeStringify({ error: e.error }) : null,
      },
    });
  });

  // ---- Subagent relationship tracking ----
  api.on("subagent_spawned", (event: unknown, ctx: unknown) => {
    const e = event as Record<string, unknown>;
    const c = ctx as Record<string, unknown>;

    // The parent's session key
    const parentSessionKey = (c.requesterSessionKey as string) || resolveSessionKey(c, e);
    const childSessionKey = (e.childSessionKey as string);
    const childAgentId = (e.agentId as string) || "unknown";

    if (!parentSessionKey || !childSessionKey) return;

    // Get or create the parent trace
    const parentTraceId = getOrCreateTrace(parentSessionKey);

    // Create the child trace with parent reference
    const childTraceId = randomUUID();
    sessionTraceMap.set(childSessionKey, { traceId: childTraceId, lastActivity: Date.now() });

    buffer.push({
      type: "trace",
      data: {
        id: childTraceId,
        session_id: childSessionKey,
        agent_name: childAgentId,
        started_at: Date.now(),
        ended_at: null,
        status: "running",
        parent_trace_id: parentTraceId,
      },
    });
  });

  api.on("subagent_ended", (event: unknown) => {
    const e = event as Record<string, unknown>;
    const targetSessionKey = (e.targetSessionKey as string);
    if (!targetSessionKey) return;

    const entry = sessionTraceMap.get(targetSessionKey);
    if (!entry) return;

    const outcome = (e.outcome as string) || "ok";
    buffer.push({
      type: "trace_update",
      data: {
        id: entry.traceId,
        updates: {
          ended_at: Date.now(),
          status: outcome === "ok" ? "success" : "error",
        },
      },
    });
    sessionTraceMap.delete(targetSessionKey);
    messageSequence.delete(entry.traceId);
  });
}

function handleDiagnosticEvent(event: Record<string, unknown>): void {
  if (event.type !== "model.usage") return;

  // Prefer sessionKey (named), fall back to sessionId (UUID)
  let sessionId = (event.sessionKey as string) || (event.sessionId as string);
  if (!sessionId) return;

  // If sessionId is a UUID, try to find the full session key via lookup
  if (UUID_PATTERN.test(sessionId) && !sessionId.startsWith("agent:") && !sessionId.startsWith("session-")) {
    const mappedKey = uuidToSessionKey.get(sessionId);
    if (mappedKey) {
      sessionId = mappedKey;
    }
  }

  // Extract agent name from event or session key
  const agentName = (event.agentId as string) || (event.agentName as string) || agentNameFromSessionKey(sessionId) || undefined;

  const traceId = getOrCreateTrace(sessionId, agentName);
  const usage = event.usage as Record<string, number> | undefined;

  // Check if llm_output hook already created an LLM span for this trace recently.
  // If so, UPDATE that span with cost data instead of creating a duplicate.
  const recentHookTs = recentLlmSpanTraces.get(traceId);
  if (recentHookTs && Date.now() - recentHookTs < 10_000) {
    recentLlmSpanTraces.delete(traceId);
    // Merge cost into the existing span created by llm_output hook
    // Prefer upstream costUsd; fall back to our pricing table estimate
    const costUsd = (event.costUsd as number) ?? estimateCost({
      model: (event.model as string) ?? null,
      tokensIn: usage?.input ?? usage?.promptTokens ?? null,
      tokensOut: usage?.output ?? null,
      cacheRead: usage?.cacheRead ?? null,
      cacheWrite: usage?.cacheWrite ?? null,
    });
    if (costUsd != null) {
      try {
        updateLatestLlmSpanCost(traceId, costUsd);
      } catch (err) {
        console.error("[openclaw-obs] Failed to update span cost:", err);
      }
    }
    return;
  }

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
      cost_usd: (event.costUsd as number) ?? estimateCost({
        model: (event.model as string) ?? null,
        tokensIn: usage?.input ?? usage?.promptTokens ?? null,
        tokensOut: usage?.output ?? null,
        cacheRead: usage?.cacheRead ?? null,
        cacheWrite: usage?.cacheWrite ?? null,
      }),
      model: (event.model as string) ?? null,
      error: null,
      metadata: safeStringify({
        source: "diagnostic_event",
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
  description: "Local observability plugin — captures LLM calls, tool invocations, conversations, and session metadata to SQLite",
  configSchema: {},
  register(api: PluginApi) {
    registerHooks(api);

    // Register diagnostic event listener
    try {
      // @ts-expect-error -- openclaw/plugin-sdk only exists at runtime inside OpenClaw
      import("openclaw/plugin-sdk").then((sdk: { onDiagnosticEvent?: (listener: DiagnosticListener) => void }) => {
        console.log("[openclaw-obs] plugin-sdk loaded, onDiagnosticEvent available:", typeof sdk.onDiagnosticEvent === "function");
        if (typeof sdk.onDiagnosticEvent === "function") {
          sdk.onDiagnosticEvent((event: Record<string, unknown>) => {
            console.log("[openclaw-obs] diagnostic event received:", event.type);
            handleDiagnosticEvent(event);
          });
          console.log("[openclaw-obs] diagnostic listener registered");
        }
      }).catch((err: unknown) => {
        console.error("[openclaw-obs] Could not load openclaw/plugin-sdk:", err);
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

        // Hourly prune
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

export { handleDiagnosticEvent };
