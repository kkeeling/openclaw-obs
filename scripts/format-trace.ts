#!/usr/bin/env npx tsx
/**
 * Trace Formatter: Takes a trace ID and produces a self-contained
 * evaluation document (markdown) for the neutral annotator.
 *
 * Usage:
 *   npx tsx scripts/format-trace.ts <trace-id>
 *   npx tsx scripts/format-trace.ts <trace-id> --json  # output as JSON
 *
 * Can also be imported and used programmatically:
 *   import { formatTrace } from "./format-trace.js";
 */

import Database from "better-sqlite3";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const DB_PATH =
  process.env.OPENCLAW_OBS_DB_PATH ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".openclaw",
    "observability",
    "traces.db",
  );

const SYSTEM_PROMPT_MAX_CHARS = 2000;
const MESSAGE_CONTENT_MAX_CHARS = 4000;

interface TraceRow {
  id: string;
  session_id: string;
  agent_name: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  parent_trace_id: string | null;
  mc_task_id: string | null;
  metadata: string | null;
}

interface MessageRow {
  id: string;
  trace_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  timestamp: number;
  sequence: number;
  metadata: string | null;
}

interface SpanRow {
  id: string;
  trace_id: string;
  kind: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  model: string | null;
  error: string | null;
}

export interface FormattedTrace {
  trace_id: string;
  markdown: string;
  metadata: {
    agent_name: string;
    session_type: string;
    started_at: string;
    duration_s: number | null;
    total_cost: number;
    total_tokens_in: number;
    total_tokens_out: number;
    status: string;
    tool_call_count: number;
    message_count: number;
    outcome_hints: string[];
    task_references: string[];
  };
}

function decompressContent(content: string | null): string | null {
  if (content == null) return null;
  // Detect base64-encoded gzip (from prune stage 1)
  if (/^[A-Za-z0-9+/]+=*$/.test(content) && content.length > 100) {
    try {
      return gunzipSync(Buffer.from(content, "base64")).toString("utf-8");
    } catch {
      // Not compressed, return as-is
    }
  }
  return content;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

function classifySession(sessionId: string, parentTraceId: string | null): string {
  if (sessionId.includes("cron")) return "cron";
  if (parentTraceId || sessionId.includes("subagent")) return "subagent";
  return "main";
}

function extractOutcomeHints(messages: MessageRow[]): string[] {
  const hints: string[] = [];
  const patterns = [
    /(?:commit|sha)\s+([0-9a-f]{7,40})/gi,
    /(?:PR|pull request)\s*#?(\d+)/gi,
    /https:\/\/github\.com\/[^\s]+\/pull\/\d+/gi,
    /\b(?:merged|deployed|completed|done|shipped)\b/gi,
    /HEARTBEAT_OK/g,
    /error:\s*.{10,80}/gi,
  ];

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content) continue;
    const content = decompressContent(msg.content) || "";
    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        hints.push(...matches.slice(0, 3)); // cap per pattern
      }
    }
  }

  return [...new Set(hints)].slice(0, 10);
}

function extractTaskReferences(messages: MessageRow[]): string[] {
  const refs: string[] = [];
  const patterns = [
    /jx7[a-z0-9]{20,40}/g,               // MC task IDs
    /#(\d{2,4})\b/g,                       // PR/issue numbers
    /(?:branch|feature|fix|hotfix)\/[\w-]+/gi, // branch names
  ];

  for (const msg of messages) {
    const content = decompressContent(msg.content) || "";
    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        refs.push(...matches.slice(0, 3));
      }
    }
  }

  return [...new Set(refs)].slice(0, 10);
}

export function formatTrace(traceId: string, db?: Database.Database): FormattedTrace {
  const ownDb = !db;
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  }

  try {
    const trace = db.prepare("SELECT * FROM traces WHERE id = ?").get(traceId) as TraceRow | undefined;
    if (!trace) throw new Error(`Trace not found: ${traceId}`);

    const messages = db.prepare(
      "SELECT * FROM messages WHERE trace_id = ? ORDER BY sequence ASC, timestamp ASC"
    ).all(traceId) as MessageRow[];

    const spans = db.prepare(
      "SELECT id, trace_id, kind, name, started_at, ended_at, tokens_in, tokens_out, cost_usd, model, error FROM spans WHERE trace_id = ? ORDER BY started_at ASC"
    ).all(traceId) as SpanRow[];

    // Compute aggregates
    const totalCost = spans.reduce((sum, s) => sum + (s.cost_usd || 0), 0);
    const totalTokensIn = spans.reduce((sum, s) => sum + (s.tokens_in || 0), 0);
    const totalTokensOut = spans.reduce((sum, s) => sum + (s.tokens_out || 0), 0);
    const toolCalls = messages.filter((m) => m.role === "tool_call");
    const toolErrors = spans.filter((s) => s.error);
    const sessionType = classifySession(trace.session_id, trace.parent_trace_id);
    const durationMs = trace.ended_at ? trace.ended_at - trace.started_at : null;
    const durationS = durationMs != null ? Math.round(durationMs / 1000) : null;
    const outcomeHints = extractOutcomeHints(messages);
    const taskRefs = extractTaskReferences(messages);

    // Tool usage summary
    const toolCounts: Record<string, number> = {};
    for (const tc of toolCalls) {
      const name = tc.tool_name || "unknown";
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }

    // Build markdown
    const lines: string[] = [];

    lines.push(`# Trace Evaluation: ${trace.id}`);
    lines.push("");
    lines.push("## Metadata");
    lines.push(`- Agent: ${trace.agent_name}`);
    lines.push(`- Session type: ${sessionType}`);
    lines.push(`- Session ID: ${trace.session_id}`);
    lines.push(`- Started: ${new Date(trace.started_at).toISOString()}`);
    lines.push(`- Duration: ${durationS != null ? `${durationS}s` : "unknown"}`);
    lines.push(`- Token cost: $${totalCost.toFixed(4)}`);
    lines.push(`- Tokens: ${totalTokensIn} in / ${totalTokensOut} out`);
    lines.push(`- Status: ${trace.status}`);
    lines.push(`- Tool calls: ${toolCalls.length}`);
    lines.push(`- Tool errors: ${toolErrors.length}`);
    lines.push("");

    // Task context
    lines.push("## Task Context");
    if (taskRefs.length > 0) {
      lines.push(`References found: ${taskRefs.join(", ")}`);
    } else {
      lines.push("No task references found.");
    }
    lines.push("");

    // Outcome hints
    lines.push("## Outcome Hints");
    if (outcomeHints.length > 0) {
      for (const hint of outcomeHints) {
        lines.push(`- ${hint}`);
      }
    } else {
      lines.push("No outcome signals found.");
    }
    lines.push("");

    // System prompt (truncated)
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg?.content) {
      const content = decompressContent(systemMsg.content) || "";
      lines.push("## System Prompt (truncated)");
      lines.push(truncate(content, SYSTEM_PROMPT_MAX_CHARS));
      lines.push("");
    }

    // Conversation
    lines.push("## Conversation");
    for (const msg of messages) {
      if (msg.role === "system") continue; // already shown above
      const content = decompressContent(msg.content) || "";
      const label = msg.role === "tool_call"
        ? `**tool_call** (${msg.tool_name || "unknown"})`
        : msg.role === "tool_result"
        ? `**tool_result** (${msg.tool_name || "unknown"})`
        : `**${msg.role}**`;

      lines.push(`### ${label}`);
      lines.push(truncate(content, MESSAGE_CONTENT_MAX_CHARS));
      lines.push("");
    }

    // Tool usage summary
    lines.push("## Tool Usage Summary");
    const toolSummary = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}: ${count}`)
      .join(", ");
    lines.push(`- Tools called: ${toolSummary || "none"}`);
    lines.push(`- Total tool calls: ${toolCalls.length}`);
    lines.push(`- Errors: ${toolErrors.length}`);

    if (toolErrors.length > 0) {
      lines.push("- Error details:");
      for (const e of toolErrors.slice(0, 5)) {
        lines.push(`  - ${e.name}: ${e.error?.slice(0, 200)}`);
      }
    }

    const markdown = lines.join("\n");

    return {
      trace_id: traceId,
      markdown,
      metadata: {
        agent_name: trace.agent_name,
        session_type: sessionType,
        started_at: new Date(trace.started_at).toISOString(),
        duration_s: durationS,
        total_cost: totalCost,
        total_tokens_in: totalTokensIn,
        total_tokens_out: totalTokensOut,
        status: trace.status,
        tool_call_count: toolCalls.length,
        message_count: messages.length,
        outcome_hints: outcomeHints,
        task_references: taskRefs,
      },
    };
  } finally {
    if (ownDb) db.close();
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("format-trace.ts")) {
  const traceId = process.argv[2];
  const jsonMode = process.argv.includes("--json");

  if (!traceId || traceId.startsWith("-")) {
    console.error("Usage: npx tsx scripts/format-trace.ts <trace-id> [--json]");
    process.exit(1);
  }

  const result = formatTrace(traceId);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.markdown);
  }
}
