import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "observability",
  "traces.db",
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT DEFAULT 'running',
  parent_trace_id TEXT,
  mc_task_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES traces(id),
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  input_json TEXT,
  output_json TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  model TEXT,
  error TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES traces(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  timestamp INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  annotator_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  failure_category TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  eval_name TEXT NOT NULL,
  passed INTEGER NOT NULL,
  score REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_name);
CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id);
CREATE INDEX IF NOT EXISTS idx_annotations_trace ON annotations(trace_id);
CREATE INDEX IF NOT EXISTS idx_annotations_verdict ON annotations(verdict);
CREATE INDEX IF NOT EXISTS idx_eval_results_trace ON eval_results(trace_id);
`;

const MIGRATIONS = [
  // Add parent_trace_id to traces if missing
  `ALTER TABLE traces ADD COLUMN parent_trace_id TEXT`,
  // Create messages table if missing (for existing DBs)
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES traces(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    timestamp INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    metadata TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_trace ON messages(trace_id)`,
  // Eval system: add mc_task_id to traces
  `ALTER TABLE traces ADD COLUMN mc_task_id TEXT`,
  // Eval system: annotations table
  `CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    annotator_id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    failure_category TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_annotations_trace ON annotations(trace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_annotations_verdict ON annotations(verdict)`,
  // Eval system: eval_results table (Phase 2+)
  `CREATE TABLE IF NOT EXISTS eval_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    eval_name TEXT NOT NULL,
    passed INTEGER NOT NULL,
    score REAL,
    evidence TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_results_trace ON eval_results(trace_id)`,
];

export interface TraceRow {
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

export interface AnnotationRow {
  id: number;
  trace_id: string;
  annotator_id: string;
  verdict: string; // 'pass' | 'fail' | 'flag'
  failure_category: string | null;
  notes: string | null;
  created_at: number;
}

export interface EvalResultRow {
  id: number;
  trace_id: string;
  eval_name: string;
  passed: number; // 0 or 1
  score: number | null;
  evidence: string | null;
  created_at: number;
}

export interface MessageRow {
  id: string;
  trace_id: string;
  role: string;
  content: string | null;
  tool_name: string | null;
  timestamp: number;
  sequence: number;
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

function getDbPath(): string {
  return process.env.OPENCLAW_OBS_DB_PATH || DEFAULT_DB_PATH;
}

function getMaxPayloadBytes(): number {
  const kb = parseInt(process.env.OPENCLAW_OBS_MAX_PAYLOAD_KB || "10", 10);
  if (kb === 0) return Infinity;
  return kb * 1024;
}

function getRetentionDays(): number {
  const days = parseInt(process.env.OPENCLAW_OBS_RETENTION_DAYS || "7", 10);
  return days > 0 ? days : 7;
}

export function truncatePayload(
  json: string | null | undefined,
): string | null {
  if (json == null) return null;
  const max = getMaxPayloadBytes();
  if (max === Infinity) return json;
  if (Buffer.byteLength(json, "utf-8") > max) {
    // Truncate by slicing bytes, then find valid UTF-8 boundary
    const buf = Buffer.from(json, "utf-8");
    const truncated = buf.subarray(0, max).toString("utf-8");
    return truncated + "...[truncated]";
  }
  return json;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  // Integrity check
  const check = db.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  if (check[0]?.integrity_check !== "ok") {
    const bakPath = dbPath + ".bak";
    db.close();
    db = null;
    fs.renameSync(dbPath, bakPath);
    console.error(
      `[openclaw-obs] DB corrupt, renamed to ${bakPath}, starting fresh`,
    );
    return getDb();
  }

  db.exec(SCHEMA);

  // Run migrations for existing DBs
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Ignore errors (e.g., column already exists)
    }
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---- Write operations ----

export function upsertTrace(trace: Omit<TraceRow, "metadata" | "parent_trace_id" | "mc_task_id"> & { metadata?: Record<string, unknown> | null; parent_trace_id?: string | null; mc_task_id?: string | null }): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO traces (id, session_id, agent_name, started_at, ended_at, status, parent_trace_id, mc_task_id, metadata)
    VALUES (@id, @session_id, @agent_name, @started_at, @ended_at, @status, @parent_trace_id, @mc_task_id, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = COALESCE(@ended_at, traces.ended_at),
      status = COALESCE(@status, traces.status),
      parent_trace_id = COALESCE(@parent_trace_id, traces.parent_trace_id),
      mc_task_id = COALESCE(@mc_task_id, traces.mc_task_id),
      metadata = COALESCE(@metadata, traces.metadata)
  `);
  stmt.run({
    ...trace,
    ended_at: trace.ended_at ?? null,
    parent_trace_id: trace.parent_trace_id ?? null,
    mc_task_id: trace.mc_task_id ?? null,
    metadata: trace.metadata ? JSON.stringify(trace.metadata) : null,
  });
}


export function insertMessage(msg: MessageRow): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO messages (id, trace_id, role, content, tool_name, timestamp, sequence, metadata)
    VALUES (@id, @trace_id, @role, @content, @tool_name, @timestamp, @sequence, @metadata)
  `);
  stmt.run({
    ...msg,
    content: truncatePayload(msg.content),
    tool_name: msg.tool_name ?? null,
    metadata: msg.metadata ?? null,
  });
}

export function getMessages(traceId: string): MessageRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM messages WHERE trace_id = @traceId ORDER BY sequence ASC, timestamp ASC")
    .all({ traceId }) as MessageRow[];
}

export function insertSpan(span: Omit<SpanRow, "input_json" | "output_json"> & { input_json?: string | null; output_json?: string | null }): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO spans (id, trace_id, parent_span_id, kind, name, started_at, ended_at,
      input_json, output_json, tokens_in, tokens_out, cost_usd, model, error, metadata)
    VALUES (@id, @trace_id, @parent_span_id, @kind, @name, @started_at, @ended_at,
      @input_json, @output_json, @tokens_in, @tokens_out, @cost_usd, @model, @error, @metadata)
  `);
  stmt.run({
    ...span,
    parent_span_id: span.parent_span_id ?? null,
    ended_at: span.ended_at ?? null,
    input_json: truncatePayload(span.input_json ?? null),
    output_json: truncatePayload(span.output_json ?? null),
    tokens_in: span.tokens_in ?? null,
    tokens_out: span.tokens_out ?? null,
    cost_usd: span.cost_usd ?? null,
    model: span.model ?? null,
    error: span.error ?? null,
    metadata: span.metadata ?? null,
  });
}

export function updateSpan(id: string, updates: Partial<SpanRow>): void {
  const d = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, val] of Object.entries(updates)) {
    if (key === "id") continue;
    const dbVal =
      key === "input_json" || key === "output_json"
        ? truncatePayload(val as string | null)
        : val;
    fields.push(`${key} = @${key}`);
    values[key] = dbVal ?? null;
  }

  if (fields.length === 0) return;
  d.prepare(`UPDATE spans SET ${fields.join(", ")} WHERE id = @id`).run(values);
}

export function updateLatestLlmSpanCost(traceId: string, costUsd: number): void {
  const d = getDb();
  d.prepare(
    `UPDATE spans SET cost_usd = @cost WHERE id = (
      SELECT id FROM spans WHERE trace_id = @traceId AND kind = 'llm'
      ORDER BY started_at DESC LIMIT 1
    )`
  ).run({ traceId, cost: costUsd });
}

export function updateTrace(id: string, updates: Partial<TraceRow>): void {
  const d = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, val] of Object.entries(updates)) {
    if (key === "id") continue;
    fields.push(`${key} = @${key}`);
    values[key] = val ?? null;
  }

  if (fields.length === 0) return;
  d.prepare(`UPDATE traces SET ${fields.join(", ")} WHERE id = @id`).run(
    values,
  );
}

// ---- Read operations (for API) ----

export interface TraceListParams {
  status?: string;
  agent?: string;
  model?: string;
  since?: number;
  until?: number;
  minCost?: number;
  search?: string;
  verdict?: string;
  annotated?: boolean;
  limit?: number;
  offset?: number;
}

export function listTraces(params: TraceListParams): TraceRow[] {
  const d = getDb();
  const conditions: string[] = [];
  const values: Record<string, unknown> = {};

  if (params.status) {
    conditions.push("t.status = @status");
    values.status = params.status;
  }
  if (params.agent) {
    conditions.push("t.agent_name = @agent");
    values.agent = params.agent;
  }
  if (params.since) {
    conditions.push("t.started_at >= @since");
    values.since = params.since;
  }
  if (params.until) {
    conditions.push("t.started_at <= @until");
    values.until = params.until;
  }
  if (params.search) {
    conditions.push("t.session_id LIKE @search");
    values.search = `%${params.search}%`;
  }
  if (params.model) {
    conditions.push(
      "EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.id AND s.model = @model)",
    );
    values.model = params.model;
  }
  if (params.minCost) {
    conditions.push(
      "(SELECT COALESCE(SUM(s.cost_usd), 0) FROM spans s WHERE s.trace_id = t.id) >= @minCost",
    );
    values.minCost = params.minCost;
  }
  if (params.verdict) {
    conditions.push(
      "EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id AND a.verdict = @verdict)",
    );
    values.verdict = params.verdict;
  }
  if (params.annotated === true) {
    conditions.push(
      "EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id)",
    );
  } else if (params.annotated === false) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id)",
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit || 100;
  const offset = params.offset || 0;

  return d
    .prepare(
      `SELECT t.*,
        (SELECT GROUP_CONCAT(DISTINCT s.model) FROM spans s WHERE s.trace_id = t.id AND s.model IS NOT NULL) AS models,
        (SELECT COALESCE(SUM(s.tokens_in), 0) FROM spans s WHERE s.trace_id = t.id) AS total_tokens_in,
        (SELECT COALESCE(SUM(s.tokens_out), 0) FROM spans s WHERE s.trace_id = t.id) AS total_tokens_out,
        (SELECT COALESCE(SUM(s.cost_usd), 0) FROM spans s WHERE s.trace_id = t.id) AS total_cost,
        (SELECT COUNT(*) FROM annotations a WHERE a.trace_id = t.id) AS annotation_count,
        (SELECT a.verdict FROM annotations a WHERE a.trace_id = t.id ORDER BY a.created_at DESC LIMIT 1) AS latest_verdict,
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.trace_id = t.id) AS last_activity
      FROM traces t ${where} ORDER BY t.started_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...values, limit, offset }) as TraceRow[];
}

export function getTrace(id: string): (TraceRow & { spans: SpanRow[]; messages: MessageRow[]; annotations: AnnotationRow[]; children: Array<{ id: string; agent_name: string; started_at: number; status: string }> }) | null {
  const d = getDb();
  const trace = d
    .prepare("SELECT * FROM traces WHERE id = @id")
    .get({ id }) as TraceRow | undefined;
  if (!trace) return null;
  const spans = d
    .prepare("SELECT * FROM spans WHERE trace_id = @id ORDER BY started_at ASC")
    .all({ id }) as SpanRow[];
  const messages = d
    .prepare("SELECT * FROM messages WHERE trace_id = @id ORDER BY sequence ASC, timestamp ASC")
    .all({ id }) as MessageRow[];
  const annotations = d
    .prepare("SELECT * FROM annotations WHERE trace_id = @id ORDER BY created_at DESC")
    .all({ id }) as AnnotationRow[];
  const children = d
    .prepare("SELECT id, agent_name, started_at, status FROM traces WHERE parent_trace_id = @id ORDER BY started_at ASC")
    .all({ id }) as Array<{ id: string; agent_name: string; started_at: number; status: string }>;
  return { ...trace, spans, messages, annotations, children };
}

export interface StatsParams {
  since?: number;
  until?: number;
}

export function getStats(params: StatsParams) {
  const d = getDb();
  const conditions: string[] = [];
  const values: Record<string, unknown> = {};

  if (params.since) {
    conditions.push("t.started_at >= @since");
    values.since = params.since;
  }
  if (params.until) {
    conditions.push("t.started_at <= @until");
    values.until = params.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const summary = d
    .prepare(
      `SELECT
        COUNT(*) as trace_count,
        COALESCE(SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
        COALESCE(AVG(t.ended_at - t.started_at), 0) as avg_duration_ms
      FROM traces t ${where}`,
    )
    .get(values) as { trace_count: number; error_count: number; avg_duration_ms: number };

  const totalCost = d
    .prepare(
      `SELECT COALESCE(SUM(s.cost_usd), 0) as total_cost
      FROM spans s
      JOIN traces t ON s.trace_id = t.id
      ${where}`,
    )
    .get(values) as { total_cost: number };

  const costByAgent = d
    .prepare(
      `SELECT t.agent_name, COALESCE(SUM(s.cost_usd), 0) as cost
      FROM traces t
      LEFT JOIN spans s ON s.trace_id = t.id
      ${where}
      GROUP BY t.agent_name
      ORDER BY cost DESC`,
    )
    .all(values) as Array<{ agent_name: string; cost: number }>;

  const costByDay = d
    .prepare(
      `SELECT
        date(t.started_at / 1000, 'unixepoch') as day,
        COALESCE(SUM(s.cost_usd), 0) as cost,
        COALESCE(SUM(s.tokens_in), 0) as tokens_in,
        COALESCE(SUM(s.tokens_out), 0) as tokens_out,
        COUNT(DISTINCT t.id) as trace_count,
        SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) as error_count
      FROM traces t
      LEFT JOIN spans s ON s.trace_id = t.id
      ${where}
      GROUP BY day
      ORDER BY day ASC`,
    )
    .all(values) as Array<{
    day: string;
    cost: number;
    tokens_in: number;
    tokens_out: number;
    trace_count: number;
    error_count: number;
  }>;

  const modelWhere = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")} AND s.model IS NOT NULL`
    : "WHERE s.model IS NOT NULL";

  const modelBreakdown = d
    .prepare(
      `SELECT
        s.model,
        COUNT(*) as call_count,
        COALESCE(SUM(s.tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(s.tokens_out), 0) as total_tokens_out,
        COALESCE(SUM(s.cost_usd), 0) as total_cost
      FROM spans s
      JOIN traces t ON s.trace_id = t.id
      ${modelWhere}
      GROUP BY s.model
      ORDER BY total_cost DESC`,
    )
    .all(values) as Array<{
    model: string;
    call_count: number;
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost: number;
  }>;

  return {
    ...summary,
    total_cost: totalCost.total_cost,
    cost_by_agent: costByAgent,
    cost_by_day: costByDay,
    model_breakdown: modelBreakdown,
  };
}

export function getHealth() {
  const d = getDb();
  const dbPath = getDbPath();

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fs.statSync(dbPath).size;
  } catch {
    // DB might not exist yet
  }

  const counts = d
    .prepare(
      "SELECT COUNT(*) as trace_count, MIN(started_at) as oldest, MAX(started_at) as newest FROM traces",
    )
    .get() as { trace_count: number; oldest: number | null; newest: number | null };

  return {
    db_size_bytes: dbSizeBytes,
    trace_count: counts.trace_count,
    oldest_trace: counts.oldest,
    newest_trace: counts.newest,
    retention_days: getRetentionDays(),
  };
}

// ---- Annotation CRUD ----

export function createAnnotation(annotation: Omit<AnnotationRow, "id">): AnnotationRow {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO annotations (trace_id, annotator_id, verdict, failure_category, notes, created_at)
    VALUES (@trace_id, @annotator_id, @verdict, @failure_category, @notes, @created_at)
  `);
  const result = stmt.run({
    trace_id: annotation.trace_id,
    annotator_id: annotation.annotator_id,
    verdict: annotation.verdict,
    failure_category: annotation.failure_category ?? null,
    notes: annotation.notes ?? null,
    created_at: annotation.created_at,
  });
  return {
    id: Number(result.lastInsertRowid),
    ...annotation,
  };
}

export function bulkCreateAnnotations(annotations: Omit<AnnotationRow, "id">[]): AnnotationRow[] {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO annotations (trace_id, annotator_id, verdict, failure_category, notes, created_at)
    VALUES (@trace_id, @annotator_id, @verdict, @failure_category, @notes, @created_at)
  `);
  const results: AnnotationRow[] = [];
  const insertAll = d.transaction(() => {
    for (const annotation of annotations) {
      const result = stmt.run({
        trace_id: annotation.trace_id,
        annotator_id: annotation.annotator_id,
        verdict: annotation.verdict,
        failure_category: annotation.failure_category ?? null,
        notes: annotation.notes ?? null,
        created_at: annotation.created_at,
      });
      results.push({
        id: Number(result.lastInsertRowid),
        ...annotation,
      });
    }
  });
  insertAll();
  return results;
}

export function getAnnotation(id: number): AnnotationRow | null {
  const d = getDb();
  return (d.prepare("SELECT * FROM annotations WHERE id = @id").get({ id }) as AnnotationRow) ?? null;
}

export function updateAnnotation(id: number, updates: Partial<Pick<AnnotationRow, "verdict" | "failure_category" | "notes">>): void {
  const d = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = @${key}`);
    values[key] = val ?? null;
  }

  if (fields.length === 0) return;
  d.prepare(`UPDATE annotations SET ${fields.join(", ")} WHERE id = @id`).run(values);
}

export function deleteAnnotation(id: number): void {
  getDb().prepare("DELETE FROM annotations WHERE id = @id").run({ id });
}

export interface AnnotationListParams {
  traceId?: string;
  annotatorId?: string;
  verdict?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export function listAnnotations(params: AnnotationListParams): AnnotationRow[] {
  const d = getDb();
  const conditions: string[] = [];
  const values: Record<string, unknown> = {};

  if (params.traceId) {
    conditions.push("trace_id = @traceId");
    values.traceId = params.traceId;
  }
  if (params.annotatorId) {
    conditions.push("annotator_id = @annotatorId");
    values.annotatorId = params.annotatorId;
  }
  if (params.verdict) {
    conditions.push("verdict = @verdict");
    values.verdict = params.verdict;
  }
  if (params.since) {
    conditions.push("created_at >= @since");
    values.since = params.since;
  }
  if (params.until) {
    conditions.push("created_at <= @until");
    values.until = params.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit || 100;
  const offset = params.offset || 0;

  return d
    .prepare(`SELECT * FROM annotations ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...values, limit, offset }) as AnnotationRow[];
}

/**
 * Check if a trace has any annotations.
 * Used by the prune pipeline to protect annotated traces.
 */
export function traceHasAnnotations(traceId: string): boolean {
  const d = getDb();
  const row = d
    .prepare("SELECT 1 FROM annotations WHERE trace_id = @traceId LIMIT 1")
    .get({ traceId });
  return !!row;
}

// ---- Retention / Pruning (2-Stage Pipeline) ----

/**
 * 2-stage tiered retention pipeline:
 * 1. After retention_days (default 7): strip content, keep metadata only (hot → cold)
 * 2. After retention_days * 4 (default 28): hard-delete unannotated traces (cold → gone)
 *
 * HARD RULE: Annotated traces are NEVER pruned. They are golden data.
 */

/**
 * Stage 1: Strip content from traces older than retention_days (hot → cold).
 * Removes span input/output and message content, keeps metadata only.
 * Skips annotated traces.
 */
export function pruneStripContent(): number {
  const d = getDb();
  const retentionDays = getRetentionDays();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let stripped = 0;

  // Find unannotated traces older than retention_days that still have content
  // (either in spans or messages)
  const traces = d.prepare(`
    SELECT t.id FROM traces t
    WHERE t.started_at < @cutoff
      AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id)
      AND (
        EXISTS (
          SELECT 1 FROM spans s WHERE s.trace_id = t.id
          AND (s.input_json IS NOT NULL OR s.output_json IS NOT NULL)
        )
        OR EXISTS (
          SELECT 1 FROM messages m WHERE m.trace_id = t.id
          AND m.content IS NOT NULL
        )
      )
  `).all({ cutoff }) as Array<{ id: string }>;

  const stripAll = d.transaction(() => {
    for (const trace of traces) {
      d.prepare(
        "UPDATE spans SET input_json = NULL, output_json = NULL WHERE trace_id = @traceId"
      ).run({ traceId: trace.id });

      d.prepare(
        "UPDATE messages SET content = NULL WHERE trace_id = @traceId"
      ).run({ traceId: trace.id });

      stripped++;
    }
  });

  stripAll();
  return stripped;
}

/**
 * Hard-delete unannotated traces older than retention_days * 4 (cold → gone).
 * Removes traces, spans, messages, and eval_results for unannotated traces.
 * Annotated traces are NEVER deleted.
 */
export function pruneHardDelete(): number {
  const d = getDb();
  const retentionDays = getRetentionDays();
  const cutoff = Date.now() - retentionDays * 4 * 24 * 60 * 60 * 1000;

  // Only delete traces that have NO annotations
  const traceIds = d.prepare(`
    SELECT t.id FROM traces t
    WHERE t.started_at < @cutoff
      AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id)
  `).all({ cutoff }) as Array<{ id: string }>;

  if (traceIds.length === 0) return 0;

  const ids = traceIds.map((r) => r.id);
  let totalDeleted = 0;

  // Process in batches of 100 to avoid huge IN clauses
  const batchSize = 100;
  const deleteAll = d.transaction(() => {
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(",");
      d.prepare(`DELETE FROM eval_results WHERE trace_id IN (${placeholders})`).run(batch);
      d.prepare(`DELETE FROM messages WHERE trace_id IN (${placeholders})`).run(batch);
      d.prepare(`DELETE FROM spans WHERE trace_id IN (${placeholders})`).run(batch);
      const result = d.prepare(`DELETE FROM traces WHERE id IN (${placeholders})`).run(batch);
      totalDeleted += result.changes;
    }
  });

  deleteAll();
  return totalDeleted;
}

/**
 * Run the 2-stage retention pipeline: strip content, then hard-delete old traces.
 * Returns count of hard-deleted traces.
 */
export function pruneOldTraces(): number {
  const stripped = pruneStripContent();
  const deleted = pruneHardDelete();
  if (stripped > 0 || deleted > 0) {
    console.log(`[openclaw-obs] prune: stripped ${stripped} traces, deleted ${deleted} traces`);
    // Reclaim freed pages after time-based pruning.
    // 50000 pages ≈ 200MB — enough for a single prune cycle's delta.
    // The initial backlog from upgrade is handled by ensureIncrementalAutoVacuum's full VACUUM.
    try {
      getDb().pragma("incremental_vacuum(50000)");
    } catch (err) {
      console.error("[openclaw-obs] incremental_vacuum failed:", err);
    }
  }
  return deleted;
}

export function pruneBySize(): number {
  // Default 2GB cap. Set OPENCLAW_OBS_MAX_DB_MB=0 to disable size-based pruning.
  const maxMb = parseInt(process.env.OPENCLAW_OBS_MAX_DB_MB || "2048", 10);
  if (!maxMb) return 0;

  const dbPath = getDbPath();
  let totalDeleted = 0;
  const d = getDb();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(dbPath).size;
    } catch {
      break;
    }
    if (sizeBytes <= maxMb * 1024 * 1024) break;

    // Only delete unannotated traces when pruning by size
    const oldest = d
      .prepare(`
        SELECT t.id FROM traces t
        WHERE NOT EXISTS (SELECT 1 FROM annotations a WHERE a.trace_id = t.id)
        ORDER BY t.started_at ASC LIMIT 100
      `)
      .all() as Array<{ id: string }>;
    if (oldest.length === 0) break;

    const ids = oldest.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    d.prepare(`DELETE FROM eval_results WHERE trace_id IN (${placeholders})`).run(ids);
    d.prepare(`DELETE FROM messages WHERE trace_id IN (${placeholders})`).run(ids);
    d.prepare(`DELETE FROM spans WHERE trace_id IN (${placeholders})`).run(ids);
    const result = d
      .prepare(`DELETE FROM traces WHERE id IN (${placeholders})`)
      .run(ids);
    totalDeleted += result.changes;

    // Reclaim freed pages so fs.statSync reflects actual size decrease.
    // Use a large page count to keep up with deletions — each page is 4KB,
    // so 50000 pages ≈ 200MB reclaimed per iteration.
    try {
      d.pragma("incremental_vacuum(50000)");
    } catch (err) {
      console.warn("[openclaw-obs] incremental_vacuum failed during pruneBySize, space may not be reclaimed:", err);
    }
  }

  if (totalDeleted > 0) {
    console.log(`[openclaw-obs] pruneBySize: deleted ${totalDeleted} traces to stay under ${maxMb}MB cap`);
  }
  return totalDeleted;
}

/**
 * Ensure the DB uses incremental auto_vacuum mode.
 * If switching from none/full, a one-time full VACUUM is required to restructure the file.
 * Without this, PRAGMA incremental_vacuum calls are no-ops.
 */
export function ensureIncrementalAutoVacuum(): void {
  const d = getDb();
  const result = d.pragma("auto_vacuum") as Array<{ auto_vacuum: number }>;
  const current = result[0]?.auto_vacuum ?? 0;
  if (current === 2) return; // Already incremental

  console.warn("[openclaw-obs] One-time VACUUM to enable incremental auto-vacuum (may take a few minutes for large DBs)");
  d.pragma("auto_vacuum = incremental");
  d.exec("VACUUM");
  console.log("[openclaw-obs] Incremental auto-vacuum enabled");
}

export function vacuum(): void {
  getDb().exec("VACUUM");
}

export function pruneAll(): { deleted: number; dbSizeBytes: number; stripped: number } {
  const stripped = pruneStripContent();
  const deleted = pruneHardDelete() + pruneBySize();
  // Full VACUUM for manual prune — maximum space reclamation
  vacuum();
  const dbPath = getDbPath();
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fs.statSync(dbPath).size;
  } catch {
    // ignore
  }
  return { deleted, dbSizeBytes, stripped };
}
