#!/usr/bin/env npx tsx
/**
 * Trace Sampler: Query obs SQLite for unannotated traces and output
 * a prioritized work queue JSON file.
 *
 * Priority order:
 *   1. Error traces (highest annotation value)
 *   2. Subagent work sessions
 *   3. Main sessions (human ↔ agent)
 *   4. Active cron (did real work beyond HEARTBEAT_OK)
 *   5. HEARTBEAT_OK-only cron (skipped unless high cost)
 *
 * Usage:
 *   npx tsx scripts/sample-traces.ts [--limit 200] [--output queue.json]
 *   npx tsx scripts/sample-traces.ts --phase2a   # initial 200: 56 errors + sampled rest
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH =
  process.env.OPENCLAW_OBS_DB_PATH ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".openclaw",
    "observability",
    "traces.db",
  );

interface TraceCandidate {
  id: string;
  session_id: string;
  agent_name: string;
  started_at: number;
  status: string;
  category: "error" | "subagent" | "main" | "cron_active" | "cron_heartbeat";
  total_cost: number;
  message_count: number;
}

interface WorkQueue {
  generated_at: string;
  total_unannotated: number;
  sampled: number;
  traces: TraceCandidate[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0; // 0 = no limit
  let output = path.join(path.dirname(new URL(import.meta.url).pathname), "work-queue.json");
  let phase2a = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[i + 1];
      i++;
    } else if (args[i] === "--phase2a") {
      phase2a = true;
    }
  }

  return { limit, output, phase2a };
}

function categorizeTrace(
  sessionId: string,
  status: string,
  parentTraceId: string | null,
  assistantContent: string | null,
): TraceCandidate["category"] {
  if (status === "error") return "error";
  if (parentTraceId || sessionId.includes("subagent")) return "subagent";
  if (sessionId.includes("cron")) {
    // Check if it's just a HEARTBEAT_OK
    if (assistantContent && assistantContent.trim() === "HEARTBEAT_OK") {
      return "cron_heartbeat";
    }
    return "cron_active";
  }
  return "main";
}

function main() {
  const { limit, output, phase2a } = parseArgs();

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  // Get all unannotated traces with cost and message count
  const rows = db.prepare(`
    SELECT
      t.id,
      t.session_id,
      t.agent_name,
      t.started_at,
      t.status,
      t.parent_trace_id,
      COALESCE((SELECT SUM(s.cost_usd) FROM spans s WHERE s.trace_id = t.id), 0) AS total_cost,
      (SELECT COUNT(*) FROM messages m WHERE m.trace_id = t.id) AS message_count,
      (SELECT m.content FROM messages m WHERE m.trace_id = t.id AND m.role = 'assistant' ORDER BY m.sequence DESC LIMIT 1) AS last_assistant_content
    FROM traces t
    WHERE NOT EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id)
    ORDER BY t.started_at DESC
  `).all() as Array<{
    id: string;
    session_id: string;
    agent_name: string;
    started_at: number;
    status: string;
    parent_trace_id: string | null;
    total_cost: number;
    message_count: number;
    last_assistant_content: string | null;
  }>;

  const totalUnannotated = rows.length;

  // Categorize all traces
  const candidates: TraceCandidate[] = rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    agent_name: r.agent_name,
    started_at: r.started_at,
    status: r.status,
    category: categorizeTrace(r.session_id, r.status, r.parent_trace_id, r.last_assistant_content),
    total_cost: r.total_cost,
    message_count: r.message_count,
  }));

  // Bucket by category
  const errors = candidates.filter((c) => c.category === "error");
  const subagents = candidates.filter((c) => c.category === "subagent");
  const mains = candidates.filter((c) => c.category === "main");
  const cronActive = candidates.filter((c) => c.category === "cron_active");
  const cronHeartbeat = candidates.filter((c) => c.category === "cron_heartbeat");

  console.log(`[sample-traces] Total unannotated: ${totalUnannotated}`);
  console.log(`  errors: ${errors.length}`);
  console.log(`  subagent: ${subagents.length}`);
  console.log(`  main: ${mains.length}`);
  console.log(`  cron_active: ${cronActive.length}`);
  console.log(`  cron_heartbeat: ${cronHeartbeat.length}`);

  let sampled: TraceCandidate[];

  if (phase2a) {
    // Phase 2a: all errors + sampled rest to reach 200
    const target = 200;
    const remaining = target - errors.length;
    const subagentSample = shuffle(subagents).slice(0, Math.min(80, Math.floor(remaining * 0.55)));
    const mainSample = shuffle(mains).slice(0, Math.min(40, Math.floor(remaining * 0.28)));
    const cronSample = shuffle(cronActive).slice(0, Math.min(24, Math.floor(remaining * 0.17)));
    // Include expensive heartbeat-only crons (>$0.50)
    const expensiveHeartbeat = cronHeartbeat.filter((c) => c.total_cost > 0.50);

    sampled = [...errors, ...subagentSample, ...mainSample, ...cronSample, ...expensiveHeartbeat];
    sampled = sampled.slice(0, target);
  } else {
    // Priority order: errors → subagent → main → cron_active
    // Skip heartbeat-only unless cost > $0.50
    const expensiveHeartbeat = cronHeartbeat.filter((c) => c.total_cost > 0.50);
    sampled = [...errors, ...subagents, ...mains, ...cronActive, ...expensiveHeartbeat];
  }

  if (limit > 0) {
    sampled = sampled.slice(0, limit);
  }

  const queue: WorkQueue = {
    generated_at: new Date().toISOString(),
    total_unannotated: totalUnannotated,
    sampled: sampled.length,
    traces: sampled,
  };

  fs.writeFileSync(output, JSON.stringify(queue, null, 2));
  console.log(`[sample-traces] Wrote ${sampled.length} traces to ${output}`);

  db.close();
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

main();
